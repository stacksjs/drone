import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupHandoverFixture } from './handover-setup'

// Each real wall-clock crossing owns an isolated native SQLite child process.
const f = await setupHandoverFixture()
const crossing = process.env.WORKSPACE_DEADLINE_CASE ?? ''
assert(['snapshot-commit', 'snapshot-middleware', 'stream-pull', 'mutation-commit'].includes(crossing))
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(process.cwd(), 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { getCurrentRequest, route } = await import('@stacksjs/router')
const { createBroadcastHub, stopServer } = await import('@stacksjs/realtime')
const { workspaceRefreshChannel } = await import('../../../resources/functions/drone/public-safety/workspace/updates')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
let deadline = 0, crossed = 0
const cross = async () => {
  assert(Date.now() < deadline, 'A current native read must begin before genuine retention expiry')
  crossed++
  await Bun.sleep(Math.max(1, deadline - Date.now() + 25))
  assert(Date.now() >= deadline)
}
route.use(async (request: Request, next: () => Promise<Response | null> | Response | null) => {
  const result = await next()
  if (request.headers.has('x-fixture-workspace-middleware')) {
    assert.equal(result?.status, 200)
    await cross()
  }
  return result
})
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
try {
  const seeded = await f.seed(`workspace-${crossing}`, 12000)
  deadline = Date.parse(seeded.config.retention.expiresAt)
  assert(Date.now() + 3000 < deadline)
  const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents/${seeded.key}/workspace`
  const headers = { authorization: `Bearer ${f.senderToken}` }
  if (crossing === 'snapshot-middleware') {
    const response = await fetch(base, { headers: { ...headers, 'x-fixture-workspace-middleware': '1' } })
    assert.equal(response.status, 404, 'Awaited middleware cannot release an expired snapshot')
    assert.deepEqual(Object.keys(await response.json() as object), ['error'])
  }
  else if (crossing === 'snapshot-commit' || crossing === 'mutation-commit') {
    const incident = (await f.snapshot(seeded.key)).incident!
    let hints = 0
    const remove = createBroadcastHub().addBroadcastHook(message => {
      if (message.channel !== workspaceRefreshChannel(Number(incident.id))) return
      assert.equal(message.event, 'refresh')
      assert.deepEqual(message.data, { refresh: true })
      hints++
    })
    let commits = 0
    f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
      if (!getCurrentRequest()?.headers.has('x-fixture-workspace-commit')) return
      commits++
      // Snapshot staging has its own read; cross the final coherent projection COMMIT.
      if (crossing === 'snapshot-commit' && commits < 2) return
      // No SQL inside the native callback, which follows actual COMMIT.
      await cross()
    } })
    const mutation = crossing === 'mutation-commit'
    const response = await fetch(mutation ? base.replace(/\/workspace$/, '/members') : base, { method: mutation ? 'PUT' : 'GET', headers: { ...headers, 'x-fixture-workspace-commit': '1', ...(mutation ? { 'content-type': 'application/json' } : {}) }, ...(mutation ? { body: JSON.stringify({ expectedVersion: incident.version, userId: f.unrelated.id, role: 'reviewer' }) } : {}) })
    assert.equal(response.status, 404, 'Actual COMMIT cannot release incident content after retention')
    assert.deepEqual(Object.keys(await response.json() as object), ['error'])
    remove()
    assert.equal(hints, mutation ? 1 : 0, 'Committed-but-withheld mutations still publish exactly one fixed refresh hint')
    assert.equal(commits, mutation ? 1 : 2)
    if (mutation) {
      const current = await f.snapshot(seeded.key)
      assert.equal(current.incident!.version, Number(incident.version) + 1)
      assert.equal(current.members.find(row => row.user_id === f.unrelated.id)?.role, 'reviewer', 'The withheld response cannot undo the native COMMIT')
    }
  }
  else {
    // Create a real native stream while current; leave its connected frame unread.
    const response = await route.handleRequest(new Request(`${base}/events`, { headers: { ...headers, 'x-fixture-workspace-pull': '1' } }) as Parameters<typeof route.handleRequest>[0])
    assert.equal(response?.status, 200)
    const reader = response!.body!.getReader()
    await Bun.sleep(Math.max(1, deadline - Date.now() - 600))
    f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
      if (!getCurrentRequest()?.headers.has('x-fixture-workspace-pull') || crossed) return
      await cross()
    } })
    assert.equal((await reader.read()).done, true, 'Final opaque frame release must recheck after its actual authority COMMIT')
    await reader.cancel()
  }
  assert.equal(crossed, 1, 'The genuine native COMMIT or awaited middleware crossed retention')
  console.log(`PASS actual workspace ${crossing} expiry nativeRoutes=${nativeRoutes}`)
}
finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }); await server.stop(true); await stopServer(); await f.database.closeDatabaseConnection() }
