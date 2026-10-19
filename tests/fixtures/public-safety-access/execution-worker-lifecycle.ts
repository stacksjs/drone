/* eslint-disable ts/no-top-level-await, no-console */
// Actual native close is a marked-termination event, never an OS-thread join.
import assert from 'node:assert/strict'
import { setupExecutionLifetime } from './execution-lifetime-setup'

const mode = process.argv[2]
assert(mode === 'healthy' || mode === 'owner-cancel')
const h = await setupExecutionLifetime(mode === 'healthy' ? 'worker-ok' : 'worker-no')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let worker: Worker | undefined, cleanupStarted = false
const stringField = (value: unknown, name: string) => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null
  try {
    const field = (value as Record<string, unknown>)[name]
    return typeof field === 'string' ? field : null
  }
  catch { return null }
}
const bounded = (value: string | null) => value === null ? null : { length: value.length, head: value.slice(0, 512), tail: value.length > 512 ? value.slice(-512) : '' }
const errors: unknown[] = []
const acks: { outcome: unknown, transferred: unknown }[] = []
const closes: { code: number, beforeCleanup: boolean }[] = []
let callbackEntered = false, callbacks = 0, terminalCallbacks = 0
let releaseCallback!: () => void
const blockedCallback = new Promise<void>(resolve => { releaseCallback = resolve })
try {
  const started = await h.start()
  worker = started.slot.worker!
  // Additional genuine native listeners preserve the production handlers.
  worker.addEventListener('error', event => {
    if (errors.length >= 4) return
    let error: unknown
    try { error = event.error }
    catch { error = undefined }
    errors.push({ eventMessage: bounded(stringField(event, 'message')), errorName: bounded(stringField(error, 'name')), errorMessage: bounded(stringField(error, 'message')), errorStack: bounded(stringField(error, 'stack')) })
  })
  worker.addEventListener('message', event => {
    if (event.data?.kind === 'finished' && acks.length < 4) acks.push({ outcome: event.data.outcome, transferred: event.data.transferred })
  })
  // Pickier misses the parameter read inside the native CloseEvent narrowing.
  // eslint-disable-next-line pickier/no-unused-vars
  worker.addEventListener('close', event => { if (closes.length < 4) closes.push({ code: (event as CloseEvent).code, beforeCleanup: !cleanupStarted }) })
  attachment = await h.f.as(h.f.senderToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, started.locator, async value => {
      if (value.phase === 'running' && value.latestEvent) callbacks++
      else terminalCallbacks++
      if (mode === 'owner-cancel' && value.phase === 'running' && !callbackEntered) {
        callbackEntered = true
        await blockedCallback
      }
    })
  })
  await attachment.activate()
  if (mode === 'owner-cancel') {
    await h.wait(() => callbackEntered, 'The real first observer callback is blocked')
    assert.equal(Atomics.load(started.slot.control, h.executionWords.credit), 0)
    assert.equal(Atomics.load(started.slot.control, h.executionWords.emitted), 1)
    assert.equal(Atomics.load(started.slot.control, h.executionWords.returned), 0)
    assert.equal((await h.core.closeIncidentExecution(h.context, started.locator)).phase, 'stopping')
  }
  const until = Date.parse(started.view.availableUntil) + 5000
  while ((!closes.length || started.slot.producer === 'pending') && Date.now() < until) await Bun.sleep(20)
  releaseCallback()
  await h.wait(() => h.executionOwner().pendingChecks === 0, 'Actual native work settled before oracle reads')
  await h.sourceZero()
  console.log(`WORKER_LIFECYCLE ${JSON.stringify({ mode, runtime: Bun.version, revision: Bun.revision, errors, acks, closes, corePhase: started.slot.phase, coreReason: started.slot.reason, producer: started.slot.producer, callbacks, terminalCallbacks, nativePending: h.executionOwner().pendingChecks, sourceCount: 0, closeMarkerIsOsJoin: false })}`)
  assert.equal(errors.length, 0, 'Completed ACK must not hide a subsequent native Worker error')
  assert.deepEqual(closes, [{ code: 0, beforeCleanup: true }], 'Observe natural normal native close before cleanup, not forced terminate or OS join')
  assert.deepEqual(acks, [{ outcome: mode === 'healthy' ? 'completed' : 'canceled', transferred: mode === 'healthy' }])
  assert.equal(started.slot.producer, 'finished')
  assert.equal(started.slot.phase, mode === 'healthy' ? 'completed' : 'canceled')
  assert.equal(started.slot.reason, mode === 'healthy' ? null : 'stopped-by-owner')
  assert(callbacks > 0)
  if (mode === 'owner-cancel') assert.equal(callbacks, 1)
  assert.equal(h.executionOwner().pendingChecks, 0)
  console.log(`PASS native production Worker ${mode} drains without an error after genuine ACK`)
}
finally {
  cleanupStarted = true
  releaseCallback()
  attachment?.release()
  try { await h.close() }
  finally { if (!closes.length) worker?.terminate() }
}
