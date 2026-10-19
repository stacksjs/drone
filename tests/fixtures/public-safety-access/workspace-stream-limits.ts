import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(process.cwd(), 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { Gate } = await import('@stacksjs/auth/gate')
const { getCurrentRequest, route } = await import('@stacksjs/router')
const { emit, replaySince, setReplayBuffer, stopServer } = await import('@stacksjs/realtime')
const { workspaceRefreshChannel } = await import('../../../resources/functions/drone/public-safety/workspace/updates')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
try {
  const seeded = await f.seed('workspace-limits')
  const id = Number((await f.snapshot(seeded.key)).incident!.id)
  const channel = workspaceRefreshChannel(id)
  const path = `http://127.0.0.1:${server.port}/api/public-safety/incidents/${seeded.key}/workspace/events`
  const send = async (token = f.senderToken, signal?: AbortSignal, method = 'GET', extra: Record<string, string> = {}) => {
    const result = await route.handleRequest(new Request(path, { method, signal, headers: { authorization: `Bearer ${token}`, ...extra } }) as Parameters<typeof route.handleRequest>[0])
    assert(result)
    assert.equal(result.headers.get('cache-control'), 'private, no-store')
    return result
  }
  const connected = async (response: Response) => {
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    assert(new TextDecoder().decode((await reader.read()).value).includes(': connected'))
    return reader
  }
  for (let i = 0; i < 4; i++) assert.equal((await send(f.senderToken, undefined, 'HEAD')).body, null)
  const first = await connected(await send()), second = await connected(await send())
  assert.equal((await send()).status, 429, 'Per-account connection count is finite')
  await first.cancel()
  const replacement = await connected(await send())
  await Promise.all([second.cancel(), replacement.cancel()])
  const abort = new AbortController(), aborted = await connected(await send(f.senderToken, abort.signal))
  abort.abort()
  assert.equal((await aborted.read()).done, true)
  await aborted.cancel()

  // No reader demand: native maxPending must disconnect a burst rather than queue indefinitely.
  const slow = await send()
  for (let i = 0; i < 20; i++) emit(channel, 'refresh', { refresh: true })
  const slowReader = await connected(slow)
  assert.equal((await slowReader.read()).done, true)
  await slowReader.cancel()
  const recovered = await connected(await send()); await recovered.cancel()

  let stalled = false
  Gate.after(async (user, ability) => {
    if (stalled && ability === 'public-safety:view' && getCurrentRequest()?.headers.has('x-fixture-stall')) await Bun.sleep(2200)
  })
  const stalledReader = await connected(await send(f.senderToken, undefined, 'GET', { 'x-fixture-stall': '1' }))
  stalled = true
  emit(channel, 'refresh', { refresh: true })
  assert.equal((await stalledReader.read()).done, true, 'A stalled current-authority check closes within its finite budget')
  stalled = false
  await stalledReader.cancel()

  // A native emitter without any request must not supply another subscriber's authority.
  assert.equal(getCurrentRequest(), undefined)
  const sender = await connected(await send()), recipient = await connected(await send(f.recipientToken))
  emit(channel, 'refresh', { refresh: true })
  for (const reader of [sender, recipient]) assert(new TextDecoder().decode((await reader.read()).value).includes('"refresh":true'))
  await f.tokens.revokeToken(f.recipientToken)
  emit(channel, 'refresh', { refresh: true })
  assert.equal((await recipient.read()).done, true)
  assert(new TextDecoder().decode((await sender.read()).value).includes('"refresh":true'))
  await Promise.all([sender.cancel(), recipient.cancel()])

  setReplayBuffer({ channels: ['*'] })
  try {
    assert.equal((await send()).status, 409, 'Workspace refuses wildcard native replay buffering')
    const incident = await f.as(f.senderToken, () => f.access.readPublicSafetyIncident(seeded.key))
    await f.as(f.senderToken, () => f.access.changePublicSafetyMembership(seeded.key, { expectedVersion: incident.version, userId: f.unrelated.id, role: 'reviewer' }))
    assert.deepEqual(replaySince(channel, 0), [], 'Actual committed publishers must not retain hints under wildcard replay')
  }
  finally { setReplayBuffer(null) }
  console.log(`PASS native workspace stream limits nativeRoutes=${nativeRoutes}`)
}
finally { setReplayBuffer(null); await server.stop(true); await stopServer(); await f.database.closeDatabaseConnection() }
