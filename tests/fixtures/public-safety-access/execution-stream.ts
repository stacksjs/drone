import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupHandoverFixture } from './handover-setup'
import type { ExecutionView } from '../../../resources/functions/drone/public-safety/execution/types'
import limits from '../../../config/execution'
import { createBroadcastHub } from '@stacksjs/realtime'

const f = await setupHandoverFixture()
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(process.cwd(), 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { route } = await import('@stacksjs/router')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const seeded = await f.seed('execution-stream')
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents/${seeded.key}/workspace`
const headers = { authorization: `Bearer ${f.senderToken}` }
const workspace = await fetch(base, { headers })
assert.equal(workspace.status, 200)
const { scope } = await workspace.json() as { scope: string }
const send = async (suffix: string, body: unknown) => fetch(`${base}/execution${suffix}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
let started: ExecutionView | undefined, stream: Response | null = null
let removeObserver: (() => void) | undefined, emitted = 0
const abort = new AbortController()
try {
  const response = await send('', { intent: crypto.randomUUID(), scope, scenario: 'nominal', seconds: 8 })
  assert.equal(response.status, 202)
  started = await response.json() as ExecutionView
  const channel = `private-public-safety.execution.${started.execution}`
  removeObserver = createBroadcastHub().addBroadcastHook(value => { if (value.channel === channel && value.event === 'execution') emitted++ })
  // Actual native route/middleware/Auth response, deliberately without body demand.
  // The private control is only a supplemental actual-producer oracle.
  stream = await route.handleRequest(new Request(`${base}/execution/${started.execution}/events?scope=${scope}`, { headers, signal: abort.signal }) as Parameters<typeof route.handleRequest>[0])
  assert.equal(stream?.status, 200)
  const slot = executionOwner().slot as { control: Int32Array, subscriber: unknown }
  assert(slot.control instanceof Int32Array)
  // Permit the entire native queue as successful prefetch, including the native
  // connected frame. With no body pull it cannot successfully enqueue more than
  // nativePending application frames. Exceeding that bound proves credits were
  // granted without native enqueue, regardless of a stricter pull/receipt rule.
  const until = Date.now() + 5000
  while (slot.subscriber !== null && Atomics.load(slot.control, executionWords.credit) <= limits.nativePending && Date.now() < until) await Bun.sleep(10)
  console.log(JSON.stringify({ oracle: 'undrained-native-capacity', nativeRoutes, capacity: limits.nativePending, emitted, credit: Atomics.load(slot.control, executionWords.credit), returned: Atomics.load(slot.control, executionWords.returned), subscriberReleased: slot.subscriber === null }))
  assert.equal(Atomics.load(slot.control, executionWords.returned), 0)
  assert(Atomics.load(slot.control, executionWords.credit) <= limits.nativePending, 'Without body demand producer credits cannot exceed the finite successful native enqueue capacity')
  assert.equal(slot.subscriber, null, 'Native capacity closure releases the core subscriber without requiring an outer pull')
  console.log(`PASS native execution stream limits nativeRoutes=${nativeRoutes}`)
}
finally {
  abort.abort(); await stream?.body?.cancel().catch(() => {})
  removeObserver?.()
  if (started) {
    await send('/close', { execution: started.execution, scope })
    const until = Date.now() + 4000
    let state: ExecutionView | null = null
    do {
      const response = await fetch(`${base}/execution?scope=${scope}`, { headers })
      state = await response.json() as ExecutionView | null
      if (!state || state.producer === 'finished') break
      await Bun.sleep(20)
    } while (Date.now() < until)
    if (state?.producer === 'finished') await send('/close', { execution: started.execution, scope })
    console.log(JSON.stringify({ oracle: 'owned-cleanup', nativeRoutes, producer: state?.producer ?? null, reservationReleased: executionOwner().slot === null }))
  }
  await server.stop(true); await f.database.closeDatabaseConnection()
}
