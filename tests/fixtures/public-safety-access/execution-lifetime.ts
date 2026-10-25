import assert from 'node:assert/strict'
import { setupExecutionLifetime } from './execution-lifetime-setup'

const mode = Bun.argv[2]
assert(mode === 'completed' || mode === 'canceled' || mode === 'quarantine')
const began = performance.now()
console.log(JSON.stringify({ oracle: 'lifetime-fixture-runtime', mode, bunVersion: Bun.version, executable: process.execPath, platform: process.platform, arch: process.arch }))
let observations = 0
async function observe<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const emit = (outcome: 'began' | 'settled' | 'rejected') => {
    assert(observations < 128 && phase.length <= 64)
    console.log(JSON.stringify({ oracle: 'lifetime-phase', mode, ordinal: observations++, phase, outcome, wallMs: Date.now(), elapsedMs: performance.now() - began }))
  }
  emit('began')
  try { const result = await work(); emit('settled'); return result }
  catch (error) { emit('rejected'); throw error }
}
const h = await observe('setup', () => setupExecutionLifetime(mode))
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let expiredClose: string | null = null
try {
  const run = await observe('start', h.start)
  const ack = h.captureFinished(run.slot, mode === 'quarantine')
  await observe('source-zero', h.sourceZero)
  if (mode === 'completed') {
    let last = 0
    attachment = await observe('attach', () => h.f.as(h.f.senderToken, async () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), run.locator, value => {
      if (!value.latestEvent || value.latestEvent.sequence === last) return
      assert.equal(value.latestEvent.sequence, ++last)
    })))
    await observe('activate', () => attachment!.activate())
    await h.wait(() => run.slot.phase === 'completed', 'The real eight-second producer must complete', 20000)
    assert(ack.event)
    assert.equal(ack.event.data.outcome, 'completed')
    assert.equal(ack.event.data.transferred, true)
    assert.equal(run.slot.producer, 'finished')
    assert.equal(Atomics.load(run.slot.control, h.executionWords.returned), 1)
    assert(run.slot.recording && run.slot.completion)
    attachment.release()
  }
  else {
    await h.wait(() => Atomics.load(run.slot.control, h.executionWords.emitted) === 1, 'The real producer must reach its first blocked callback')
    assert.equal(Atomics.load(run.slot.control, h.executionWords.credit), 0)
    assert.equal(Atomics.load(run.slot.control, h.executionWords.returned), 0)
    const stoppingAt = performance.now()
    const stopping = await observe('close', () => h.core.closeIncidentExecution(h.context, run.locator))
    assert.equal(stopping.phase, 'stopping')
    await h.wait(() => Boolean(ack.event), 'Capture a genuine finished ACK from the canceled actual Worker')
    assert.equal(ack.event!.data.outcome, 'canceled')
    assert.equal(ack.event!.data.transferred, false)
    if (mode === 'canceled') {
      await h.wait(() => run.slot.producer === 'finished', 'The genuine delegated ACK confirms owned work finished')
      assert.equal(run.slot.phase, 'canceled')
    }
    else {
      await h.wait(() => run.slot.producer === 'unconfirmed', 'Actual stop grace must quarantine the missing ACK', 5000)
      const elapsedMs = performance.now() - stoppingAt
      assert(elapsedMs >= h.limits.stopGraceMs)
      assert.equal(run.slot.phase, 'failed')
      assert.equal(run.slot.reason, 'stop-unconfirmed')
      assert.equal((await h.core.closeIncidentExecution(h.context, run.locator)).producer, 'unconfirmed')
      assert.equal(h.executionOwner().slot, run.slot)
      await assert.rejects(() => h.start(), h.f.status(409))
      console.log(JSON.stringify({ oracle: 'actual-stop-grace', elapsedMs, configuredMs: h.limits.stopGraceMs, actualFinishedAckSuppressed: true, actualStuckCpuQualified: false, actualIndividualThreadJoinQualified: false }))
    }
  }
  const expiry = run.slot.metadataDeadline
  const observedAt = Date.now(), observedMonotonic = performance.now()
  assert(expiry > observedAt + 50000, 'The actual unshortened terminal TTL must still be mostly ahead')
  await observe('source-zero', h.sourceZero)
  console.log(JSON.stringify({ oracle: 'actual-retention-begins', mode, configuredMs: h.limits.retainedMs, remainingMs: expiry - observedAt, producer: run.slot.producer }))
  // Scalar time/slot observation only, not repeated native authority polling.
  await observe('wait-before-expiry', () => h.untilWall(expiry - 1000))
  assert.equal(h.executionOwner().slot, run.slot, 'Reservation remains during the actual retained lifetime')
  const readAt = Date.now(), readMonotonic = performance.now()
  console.log(JSON.stringify({ oracle: 'retained-read-admission', mode, wallMs: readAt, metadataDeadline: expiry, remainingMs: expiry - readAt, producer: run.slot.producer, slotRetained: h.executionOwner().slot === run.slot }))
  const retained = await observe('retained-read', () => h.core.readIncidentExecution(h.context, { scope: h.scope }))
  const settledAt = Date.now()
  console.log(JSON.stringify({ oracle: 'retained-read-result', mode, wallMs: settledAt, metadataDeadline: expiry, remainingMs: expiry - settledAt, elapsedMs: performance.now() - readMonotonic, returnedView: retained !== null, producer: run.slot.producer, slotRetained: h.executionOwner().slot === run.slot }))
  assert.equal(retained?.execution, run.view.execution)
  assert.equal(retained.producer, mode === 'quarantine' ? 'unconfirmed' : 'finished')
  assert.equal(run.slot.metadataDeadline, expiry, 'Reads do not renew retention')
  await observe('wait-after-expiry', () => h.untilWall(expiry + 100))
  if (mode === 'quarantine') {
    assert.equal(h.executionOwner().slot, run.slot, 'Actual TTL cannot free an unconfirmed reservation')
    try { assert.equal((await h.core.closeIncidentExecution(h.context, run.locator)).producer, 'unconfirmed'); expiredClose = 'unconfirmed-view' }
    catch (error) { assert(h.f.status(404)(error), 'Expired public close may refuse its view, but cannot free the reservation'); expiredClose = '404' }
    assert.equal(h.executionOwner().slot, run.slot, 'Expired close cannot release quarantine')
    await assert.rejects(() => h.start(), h.f.status(409))
    ack.forwardGenuine()
    await Bun.sleep(20)
    assert.equal(run.slot.producer, 'unconfirmed')
    assert.equal(run.slot.reason, 'stop-unconfirmed')
    assert.equal(h.executionOwner().slot, run.slot, 'Forwarding the captured genuine late ACK cannot restore or free quarantine')
    await assert.rejects(() => h.start(), h.f.status(409))
    h.assertCleared(run.slot)
  }
  else {
    // Assert timer disposal BEFORE public read, which also supports lazy expiry.
    await h.wait(() => h.executionOwner().slot === null, 'The real retention timer must dispose the confirmed slot')
    h.assertCleared(run.slot)
    assert.equal(run.slot.worker, null)
    assert.equal(await observe('expired-read', () => h.core.readIncidentExecution(h.context, { scope: h.scope })), null)
    if (mode === 'completed') {
      const next = await observe('next-start', h.start)
      assert.notEqual(next.view.execution, run.view.execution)
      assert.equal(next.view.phase, 'waiting-for-consumer')
      await h.wait(() => Atomics.load(next.slot.control, h.executionWords.emitted) === 1, 'A new explicit start constructs a new real producer')
      await observe('next-close', () => h.core.closeIncidentExecution(h.context, next.locator))
      await h.wait(() => next.slot.producer === 'finished', 'New explicit producer cooperatively finishes')
      await observe('next-release', () => h.core.closeIncidentExecution(h.context, next.locator))
      assert.equal(h.executionOwner().slot, null)
    }
  }
  await observe('source-zero', h.sourceZero)
  console.log(JSON.stringify({ oracle: 'actual-retention-ended', mode, elapsedSinceObservationMs: performance.now() - observedMonotonic, expiryPassedMs: Date.now() - expiry, slotRetained: h.executionOwner().slot === run.slot, producer: run.slot.producer, sourceCount: 0, expiredClose, lateAckControlled: mode === 'quarantine', actualIndividualThreadJoinQualified: false }))
  console.log(`PASS native execution lifetime ${mode}`)
}
finally { attachment?.release(); await observe('cleanup', h.close) }
