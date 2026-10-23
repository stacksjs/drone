import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ExecutionView } from '../../../resources/functions/drone/public-safety/execution/types'

const scenario = Bun.argv[2]
assert(['limits', 'preflight', 'middleware', 'chunk', 'admission'].includes(scenario!))
const began = performance.now()
let observations = 0
async function observe<T>(phase: string, work: () => T | Promise<T>): Promise<T> {
  const emit = (outcome: 'began' | 'settled' | 'rejected') => {
    if (observations >= 128) return
    // Diagnostic output must not replace an actual native failure.
    try { console.log(JSON.stringify({ oracle: 'execution-http-phase', scenario, pid: process.pid, ordinal: observations++, phase, outcome, elapsedMs: performance.now() - began })) }
    catch {}
  }
  emit('began')
  try { const result = await work(); emit('settled'); return result }
  catch (error) { emit('rejected'); throw error }
}
try { console.log(JSON.stringify({ oracle: 'execution-http-runtime', scenario, pid: process.pid, bunVersion: Bun.version, executable: process.execPath, platform: process.platform, arch: process.arch })) }
catch {}
const { setupHandoverFixture } = await observe('setup-module', () => import('./handover-setup'))
const f = await observe('setup', setupHandoverFixture)
const source = resolve(import.meta.dir, '../../..')
await observe('gate-override', () => writeFile(join(process.cwd(), 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`))
const { initializeAuthorization } = await observe('authorization-module', () => import('@stacksjs/auth/policy'))
await observe('authorization', initializeAuthorization)
const { Gate } = await observe('gate-module', () => import('@stacksjs/auth/gate'))
const { getCurrentRequest, route } = await observe('router-module', () => import('@stacksjs/router'))
const { emit, setReplayBuffer, stopServer } = await observe('realtime-module', () => import('@stacksjs/realtime'))
const { executionOwner } = await observe('execution-state-module', () => import('../../../resources/functions/drone/public-safety/execution/state'))
const { executionWords } = await observe('protocol-module', () => import('../../../resources/functions/drone/public-safety/execution/protocol'))
await observe('route-register', () => route.register(join(source, 'routes/api.ts'), { prefix: '/api' }))
let deadline = 0, crossed = 0
const cross = async () => {
  assert(Date.now() < deadline, 'Actual native response/check must be current before the wall crossing')
  crossed++
  await Bun.sleep(Math.max(1, deadline - Date.now() + 20))
  assert(Date.now() >= deadline)
}
route.use(async (request: Request, next: () => Promise<Response | null> | Response | null) => {
  const response = await next()
  if (request.headers.has('x-fixture-execution-middleware')) { assert.equal(response?.status, 200); await cross() }
  return response
})
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await observe('server-start', () => route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes }))
type DiagnosticSlot = { control: Int32Array, subscriber: unknown, worker: Worker | null, producer: string, admission: string, phase: string, reason: string | null }
let slot: DiagnosticSlot | undefined, started: ExecutionView | undefined
const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
const aborts = new Set<AbortController>()
let resume: (() => void) | undefined
let removeQueries: (() => void) | undefined
let cleanup: (() => Promise<void>) | undefined
let denySubscriber = false, stall = false, held = false
const barrier = new Promise<void>(resolve => { resume = resolve })
Gate.after(async (user, ability) => {
  void user
  const request = getCurrentRequest()
  if (denySubscriber && ability === 'public-safety:source-register' && request?.headers.has('x-fixture-execution-subscriber')) return false
  if (stall && ability === 'public-safety:view' && request?.headers.has('x-fixture-execution-stall')) { held = true; await barrier }
})
try {
  const expiring = ['middleware', 'chunk', 'admission'].includes(scenario!)
  // Chunk/admission must first complete an actual run. Give that setup margin;
  // the subsequent native release still has to cross this genuine wall deadline.
  const retentionMs = scenario === 'chunk' || scenario === 'admission' ? 20000 : expiring ? 8000 : 86400000
  const seeded = await observe('seed', () => f.seed(`execution-http-${scenario}`, retentionMs))
  deadline = Date.parse(seeded.config.retention.expiresAt)
  const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents/${seeded.key}/workspace`
  const headers = { authorization: `Bearer ${f.senderToken}` }
  const workspace = await observe('workspace-request', () => fetch(base, { headers })); assert.equal(workspace.status, 200)
  const { scope } = await observe('workspace-body', () => workspace.json()) as { scope: string }
  const initialVersion = Number((await observe('initial-snapshot', () => f.snapshot(seeded.key))).incident!.version)
  const statusUrl = `${base}/execution?scope=${scope}`
  const send = (suffix: string, body: unknown, extra: Record<string, string> = {}) => fetch(`${base}/execution${suffix}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) })
  cleanup = async () => {
    if (!started || !executionOwner().slot) return
    await send('/close', { execution: started.execution, scope })
    const until = Date.now() + 4000
    while (slot?.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
    if (slot?.producer === 'finished') await send('/close', { execution: started.execution, scope })
  }
  const wait = async (predicate: () => boolean, message: string, duration = 5000) => {
    const until = Date.now() + duration
    while (!predicate() && Date.now() < until) await Bun.sleep(10)
    assert(predicate(), message)
  }
  if (scenario === 'preflight') {
    stall = true
    const response = await observe('preflight-request', () => fetch(statusUrl, { headers: { ...headers, 'x-fixture-execution-stall': '1' } }))
    assert.equal(response.status, 404)
    assert(held)
    assert.equal(executionOwner().pendingChecks, 1, 'Timed-out actual HTTP preflight remains charged until genuine native settlement')
    resume!(); stall = false
    await observe('preflight-settlement', () => wait(() => executionOwner().pendingChecks === 0, 'Native preflight must settle before its shared budget is released'))
    assert.equal((await fetch(statusUrl, { headers })).status, 200)
    assert.equal(executionOwner().slot, null)
  }
  else if (scenario === 'middleware') {
    const response = await observe('middleware-request', () => fetch(statusUrl, { headers: { ...headers, 'x-fixture-execution-middleware': '1' } }))
    assert.equal(response.status, 404, 'Null status response retains preflight deadline across awaited native middleware')
    assert.equal(crossed, 1)
    assert.deepEqual(Object.keys(await response.json() as object), ['error'])
  }
  else {
    const response = await observe('execution-start', () => send('', { intent: crypto.randomUUID(), scope, scenario: 'nominal', seconds: 8 }))
    assert.equal(response.status, 202); started = await response.json() as ExecutionView
    slot = executionOwner().slot as DiagnosticSlot
    const events = `${base}/execution/${started.execution}/events?scope=${scope}`
    const channel = `private-public-safety.execution.${started.execution}`
    const open = (extra: Record<string, string> = {}) => observe('events-open', async () => {
      const abort = new AbortController(); aborts.add(abort)
      const result = await route.handleRequest(new Request(events, { headers: { ...headers, ...extra }, signal: abort.signal }) as Parameters<typeof route.handleRequest>[0])
      assert.equal(result?.status, 200)
      const reader = result!.body!.getReader(); readers.add(reader)
      assert(new TextDecoder().decode((await reader.read()).value).includes(': connected'))
      return { reader, abort }
    })
    const drainClosed = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      for (let count = 0; count < 100; count++) if ((await reader.read()).done) return
      assert.fail('Native stream must close without unbounded pending frames')
    }
    if (scenario === 'limits') {
      for (const pattern of [channel, channel.replace('private-', ''), '*', 'private-public-safety.*', 'public-safety.*']) {
        setReplayBuffer({ channels: [pattern] })
        assert.equal((await fetch(events, { headers })).status, 409)
        assert.equal(slot.subscriber, null)
        setReplayBuffer(null)
      }
      const preabort = new AbortController(); preabort.abort()
      const refused = await route.handleRequest(new Request(events, { headers, signal: preabort.signal }) as Parameters<typeof route.handleRequest>[0])
      assert.equal(refused?.status, 404)
      assert.equal(slot.subscriber, null)
      const first = await open()
      assert.equal((await fetch(events, { headers })).status, 409, 'Only one core/native subscriber is retained')
      first.abort.abort(); await first.reader.cancel()
      await wait(() => slot!.subscriber === null, 'Request abort must release the core attachment')
      const revoked = await open({ 'x-fixture-execution-subscriber': '1' })
      denySubscriber = true
      emit(channel, 'execution', { publisher: 'valid-native-hub' })
      await drainClosed(revoked.reader)
      assert.equal(slot.subscriber, null, 'Valid publisher cannot borrow current authority for a denied native subscriber')
      denySubscriber = false
      const stalled = await open({ 'x-fixture-execution-stall': '1' })
      stall = true
      emit(channel, 'execution', { publisher: 'native-deferred-check' })
      await drainClosed(stalled.reader)
      assert(held)
      assert(executionOwner().pendingChecks > 0, 'Timed-out deferred native checks retain the real shared pending budget')
      resume!(); stall = false
      await wait(() => executionOwner().pendingChecks === 0, 'Late native authorization must actually settle')
      assert.equal(slot.subscriber, null)
      console.log(JSON.stringify({ oracle: 'native-stream-cleanup', nativeRoutes, producerCredit: Atomics.load(slot.control, executionWords.credit), returned: Atomics.load(slot.control, executionWords.returned), pendingChecks: executionOwner().pendingChecks, subscriberReleased: slot.subscriber === null }))
    }
    else {
      const live = await open({ 'x-fixture-execution-chunk': '1' })
      const activeSlot = slot
      const complete = await observe('producer-terminal', async () => {
        let complete: ExecutionView | undefined, text = ''
        const decoder = new TextDecoder()
        while (!complete) {
          const part = await live.reader.read()
          if (part.done) console.log(JSON.stringify({ oracle: 'terminal-preparation-ended', scenario, nativeRoutes, remainingMs: deadline - Date.now(), phase: activeSlot.phase, reason: activeSlot.reason, producer: activeSlot.producer, credit: Atomics.load(activeSlot.control, executionWords.credit), emitted: Atomics.load(activeSlot.control, executionWords.emitted), returned: Atomics.load(activeSlot.control, executionWords.returned), pending: executionOwner().pendingChecks }))
          assert(!part.done)
          text += decoder.decode(part.value, { stream: true })
          for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
            const frame = text.slice(0, end); text = text.slice(end + 2)
            if (!frame.startsWith('data: ')) continue
            const value = JSON.parse(frame.slice(6)) as { data: ExecutionView }
            if (value.data.phase === 'completed') complete = value.data
          }
        }
        return complete
      })
      console.log(JSON.stringify({ oracle: 'terminal-preparation-completed', scenario, nativeRoutes, remainingMs: deadline - Date.now(), phase: slot.phase, reason: slot.reason, producer: slot.producer, credit: Atomics.load(slot.control, executionWords.credit), emitted: Atomics.load(slot.control, executionWords.emitted), returned: Atomics.load(slot.control, executionWords.returned) }))
      if (scenario === 'chunk') {
        live.abort.abort(); await live.reader.cancel()
        // Leave no native queue idle while waiting. Reconnect the SAME retained
        // execution within one heartbeat of expiry, then hold its final read.
        await observe('terminal-reconnect-wait', () => Bun.sleep(Math.max(1, deadline - Date.now() - 1500)))
        const final = await open({ 'x-fixture-execution-final-chunk': '1' })
        await Bun.sleep(10)
        await wait(() => executionOwner().pendingChecks === 0, 'Terminal reconnect setup native checks must settle', 500)
        assert.equal(executionOwner().slot, slot, 'Deadline reconnect cannot restart the completed producer')
        await Bun.sleep(Math.max(1, deadline - Date.now() - 500))
        f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
          if (!crossed && getCurrentRequest()?.headers.has('x-fixture-execution-final-chunk')) await cross()
        } })
        assert.equal((await observe('final-chunk-read', () => final.reader.read())).done, true, 'Opaque chunk is withheld when its actual native check COMMIT crosses retention')
        assert.equal(crossed, 1)
      }
      else {
        live.abort.abort(); await live.reader.cancel()
        const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
        let inserted = false
        removeQueries = registerPersistentQueryHooks({ onQueryEnd(query) {
          if (getCurrentRequest()?.headers.has('x-fixture-execution-admission') && /^insert\s+into\s+["`]?public_safety_sources/i.test(query.sql)) inserted = true
        } })
        f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
          if (inserted && !crossed && getCurrentRequest()?.headers.has('x-fixture-execution-admission')) await cross()
        } })
        const result = await observe('admission-request', () => send('/admission', { execution: started!.execution, scope, digest: complete.completion!.digest, expectedVersion: initialVersion }, { 'x-fixture-execution-admission': '1' }))
        assert.equal(result.status, 404, 'A genuinely committed admission cannot release past its authority deadline')
        assert.equal(crossed, 1)
        assert(inserted, 'The actual checked writer inserted the source before its native COMMIT wait')
        assert.equal(slot.admission, 'unknown')
        const snapshot = await f.snapshot(seeded.key)
        assert.equal(snapshot.incident!.version, initialVersion + 1, 'Withheld response does not undo the actual checked writer COMMIT')
        const sources = await f.database.db.primary.selectFrom('public_safety_sources').select('id').where('incident_id', '=', snapshot.incident!.id).execute()
        assert.equal(sources.length, 2, 'Exactly one new completed execution source was durably committed')
      }
    }
    if (scenario === 'limits') {
      // A retained terminal stream has no producer queue pressure, isolating the
      // byte ceiling from the earlier queue-capacity case.
      if (slot.producer === 'pending') await send('/close', { execution: started.execution, scope })
      await wait(() => slot!.producer === 'finished', 'Producer must cooperatively stop before retained byte-cap test')
      const terminal = await open()
      const frame = await terminal.reader.read(); assert(!frame.done)
      emit(channel, 'execution', { excess: 'x'.repeat(4096) })
      assert.equal((await terminal.reader.read()).done, true, 'Oversized native frame cannot cross the final opaque release')
      assert.equal(slot.subscriber, null)
    }
  }
  console.log(`PASS native execution HTTP ${scenario} nativeRoutes=${nativeRoutes}`)
}
finally {
  denySubscriber = false; stall = false; resume!()
  setReplayBuffer(null)
  f.database.db.primary.setTransactionDefaults({ afterCommit: undefined })
  removeQueries?.()
  for (const abort of aborts) abort.abort()
  await observe('cleanup-readers', () => Promise.allSettled([...readers].map(reader => reader.cancel())))
  await observe('cleanup-execution', async () => { await cleanup?.() })
  await observe('cleanup-producer', async () => {
    if (slot?.producer === 'pending') {
      const until = Date.now() + 4000
      while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
      if (slot.producer === 'pending') slot.worker?.terminate()
    }
  })
  await observe('cleanup-pending-checks', async () => {
    const until = Date.now() + 5000
    while (executionOwner().pendingChecks && Date.now() < until) await Bun.sleep(10)
  })
  assert.equal(executionOwner().pendingChecks, 0)
  await observe('cleanup-server', async () => { await server.stop(true) })
  await observe('cleanup-realtime', stopServer)
  await observe('cleanup-database', () => f.database.closeDatabaseConnection())
}
