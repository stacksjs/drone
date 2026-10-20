import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setupPatrolDatabase } from './setup'

async function main() {
  // Private pipe transports fixture credentials; neither process logs them or stores a credential file.
  const expected = await Bun.stdin.json()
  const { root, database } = await setupPatrolDatabase({ reuseDatabase: true })
  const source = resolve(import.meta.dir, '../../..')
  await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
  const { initializeAuthorization } = await import('@stacksjs/auth/policy')
  await initializeAuthorization()
  const { route } = await import('@stacksjs/router')
  await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
  const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: true })
  try {
    const headers = { authorization: `Bearer ${expected.credential}`, 'content-type': 'application/json', accept: 'application/json' }
    const path = `/api/patrol/reviews/${expected.schedule.scheduleKey}`
    const read = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers })
    assert.equal(read.status, 200)
    assert.deepEqual(await read.json(), expected.schedule)
    for (const item of expected.requests) {
      const response = await fetch(`http://127.0.0.1:${server.port}${item.path}`, { method: 'POST', headers, body: JSON.stringify(item.body) })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.deepEqual(result.receipt, item.receipt)
      assert.equal(result.replayed, true)
      assert.equal(result.currentVersion, 5)
      assert.equal(result.consumedNow, false)
      assert.equal(result.executionState, 'not-requested')
      assert.equal(result.handoff, null)
    }
    const after = await fetch(`http://127.0.0.1:${server.port}${path}`, { headers })
    assert.deepEqual(await after.json(), expected.schedule)
    // eslint-disable-next-line no-console
    console.log('PASS fresh native process reads durable five-audit ledger and all immutable receipts without writes')
  }
  finally {
    await server.stop(true)
    await database.closeDatabaseConnection()
  }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
