/* eslint-disable ts/no-top-level-await, no-console */
// Actual accepted finished ACK and concurrent native owner close, never a fabricated ACK/phase.
import assert from 'node:assert/strict'
import { setupExecutionLifetime } from './execution-lifetime-setup'

const h = await setupExecutionLifetime('ack-stop')
const { Gate } = await import('@stacksjs/auth/gate')
const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { enhanceRequest, getCurrentRequest, runWithRequest } = await import('@stacksjs/router')
const { isInTransaction } = await import('@stacksjs/database/runtime')
interface FinalizingSlot {
  finishedAck: boolean, finalizing: boolean, ownerCheckBusy: boolean,
  candidate: unknown, completion: unknown, recording: string | null,
  phase: string, reason: string | null, producer: string,
}
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let finished: MessageEvent | undefined, forwarded = 0, completedViews = 0
let closePromise: Promise<void> | undefined, closeView: Awaited<ReturnType<typeof h.core.closeIncidentExecution>> | undefined
let closeError: unknown, closeRejected = false, closeCaptured = false, armClose = true
let releaseClose!: () => void, announceClose!: () => void
const holdClose = new Promise<void>(resolve => { releaseClose = resolve })
const closeEntered = new Promise<void>(resolve => { announceClose = resolve })
let closeAuthorityCommits = 0, finalAuthorityAllows = 0, finalAuthorityCommits = 0, rollbacks = 0
let queuedPending = 0, closeReturnedAt = 0, stopObservationElapsed = 0
let ackForwardAt = 0, finalChecksElapsedMs = 0
let afterSuccessfulChecks: unknown, afterStopGrace: unknown
const workerErrors: unknown[] = [], closeCodes: (number | null)[] = []
const ownerRequest = await h.context.run(async () => getCurrentRequest())
assert(ownerRequest)
const closeRequest = enhanceRequest(new Request(`https://incident.invalid/api/public-safety/incidents/${h.key}/workspace/execution/close`, { method: 'POST', headers: { authorization: `Bearer ${h.f.senderToken}` } }) as Parameters<typeof enhanceRequest>[0])
const run = await h.start()
const slot = run.slot as typeof run.slot & FinalizingSlot
assert(slot.worker)
const worker = slot.worker, observe = worker.onmessage
assert(observe)
const state = () => ({ phase: slot.phase, reason: slot.reason, producer: slot.producer, finishedAck: slot.finishedAck, finalizing: slot.finalizing, pending: h.executionOwner().pendingChecks, ownerBusy: slot.ownerCheckBusy, candidate: !!slot.candidate, recording: !!slot.recording, completion: !!slot.completion })
const forwardGenuine = () => {
  assert(finished)
  assert.equal(forwarded, 0)
  forwarded++
  ackForwardAt = performance.now()
  observe.call(worker, finished)
}
try {
  worker.addEventListener('error', event => {
    if (workerErrors.length < 4) workerErrors.push({ type: event.type, message: typeof event.message === 'string' ? event.message.slice(0, 512) : null })
  })
  worker.addEventListener('close', event => {
    if (closeCodes.length < 4) closeCodes.push('code' in event && typeof event.code === 'number' ? event.code : null)
  })
  worker.onmessage = event => {
    if (event.data?.kind === 'finished') {
      assert.equal(finished, undefined)
      finished = event
      return
    }
    observe.call(worker, event)
  }
  Gate.define('public-safety:source-register', async (user, incident) => {
    assert(typeof incident === 'string')
    const allowed = await publicSafetyIncidentGate(user, incident, 'source-register')
    if (armClose && !closeCaptured && getCurrentRequest() === closeRequest) {
      assert(allowed)
      assert(isInTransaction())
      assert.equal(slot.phase, 'running')
      assert(slot.candidate)
      assert.equal(slot.finishedAck, false)
      assert.equal(slot.ownerCheckBusy, false)
      closeCaptured = true
      announceClose()
      await holdClose
    }
    if (getCurrentRequest() === ownerRequest && slot.finishedAck && slot.finalizing) {
      assert(allowed)
      assert(isInTransaction())
      finalAuthorityAllows++
    }
    return allowed
  })
  attachment = await h.f.as(h.f.senderToken, () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), run.locator, value => {
    if (value.phase === 'completed' || value.completion) completedViews++
  }))
  await attachment.activate()
  await h.wait(() => !!finished, 'Capture actual finished ACK after unchanged full canonical candidate', Math.max(1, Date.parse(run.view.availableUntil) - Date.now() + 5000))
  assert(slot.candidate)
  assert.equal(slot.phase, 'running')
  assert.equal(slot.finishedAck, false)
  assert.equal(slot.ownerCheckBusy, false)
  assert.equal(h.executionOwner().pendingChecks, 0)
  assert.equal(Atomics.load(slot.control, h.executionWords.returned), 1)
  assert.equal(finished!.data.outcome, 'completed')
  assert.equal(finished!.data.transferred, true)
  h.f.database.db.primary.setTransactionDefaults({
    afterCommit: () => {
      if (getCurrentRequest() === closeRequest) closeAuthorityCommits++
      if (getCurrentRequest() === ownerRequest && slot.finishedAck && slot.finalizing) finalAuthorityCommits++
    },
    onRollback: () => { rollbacks++ },
  })
  closePromise = runWithRequest(closeRequest, async () => {
    const captured = h.core.captureExecutionContext(h.key)
    return h.core.closeIncidentExecution(captured, run.locator)
  }).then(value => { closeView = value }).catch(error => {
    closeRejected = true
    closeError = error
  })
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([closeEntered, new Promise<never>((resolve, reject) => {
      void resolve
      guard = setTimeout(() => reject(new Error(`Actual close native Gate not held: ${JSON.stringify(state())}`)), 5000)
    })])
  }
  finally { clearTimeout(guard) }
  assert.equal(h.executionOwner().pendingChecks, 1)
  forwardGenuine()
  assert.equal(slot.finishedAck, true)
  assert.equal(slot.finalizing, true)
  assert.equal(slot.producer, 'pending')
  queuedPending = h.executionOwner().pendingChecks
  assert.equal(queuedPending, 2, 'Actual final authority queues behind the already eligible close transaction')
  releaseClose()
  await closePromise
  closeReturnedAt = performance.now()
  assert.equal(closeRejected, false, 'The native owner close must actually succeed')
  assert(closeView)
  assert.equal(closeView.reason, 'stopped-by-owner')
  assert(['stopping', 'canceled'].includes(closeView.phase))
  assert.equal(slot.candidate, null)
  assert.equal(slot.recording, null)
  assert.equal(slot.completion, null)
  await h.wait(() => !slot.finalizing && h.executionOwner().pendingChecks === 0, 'Actual successful final owner authority settles without timeout')
  finalChecksElapsedMs = performance.now() - ackForwardAt
  assert(finalChecksElapsedMs < h.limits.checkTimeoutMs, 'The full genuine ACK to settled final authority bracket excludes the unchanged native check timeout path')
  assert.equal(closeAuthorityCommits, 1)
  assert.equal(finalAuthorityAllows, 1)
  assert.equal(finalAuthorityCommits, 1)
  assert.equal(rollbacks, 0)
  assert.equal(completedViews, 0)
  afterSuccessfulChecks = state()
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  // Observe the actual unshortened stop grace. No timer, phase or clock mutation.
  await Bun.sleep(Math.max(1, h.limits.stopGraceMs + 100 - (performance.now() - closeReturnedAt)))
  stopObservationElapsed = performance.now() - closeReturnedAt
  afterStopGrace = state()
  await h.sourceZero()
  console.log(`FINISHED_ACK_STOP ${JSON.stringify({ runtime: Bun.version, genuineAckForwarded: forwarded, closeRejected, closeStatus: closeError instanceof h.f.access.PublicSafetyAccessError ? closeError.status : null, closePhase: closeView.phase, closeProducer: closeView.producer, queuedPending, closeAuthorityCommits, finalAuthorityAllows, finalAuthorityCommits, finalChecksElapsedMs, configuredCheckTimeoutMs: h.limits.checkTimeoutMs, rollbacks, afterSuccessfulChecks, afterStopGrace, stopObservationElapsed, configuredStopGraceMs: h.limits.stopGraceMs, completedViews, sourceCount: 0, workerErrors, closeCodes, osThreadJoinClaim: false })}`)
  assert.equal(slot.finishedAck, true)
  assert.equal(slot.producer, 'finished', 'An already accepted genuine ACK cannot become an unconfirmed quarantine')
  assert.equal(slot.phase, 'canceled')
  assert.equal(slot.reason, 'stopped-by-owner')
  assert(stopObservationElapsed >= h.limits.stopGraceMs)
  assert.deepEqual(workerErrors, [])
  assert.deepEqual(closeCodes, [0])
  assert.equal((await h.core.readIncidentExecution(h.context, { scope: h.scope }))!.producer, 'finished')
  assert.equal((await h.core.closeIncidentExecution(h.context, run.locator)).phase, 'discarded')
  assert.equal(h.executionOwner().slot, null)
  const next = await h.start()
  assert.notEqual(next.view.execution, run.view.execution)
  await h.wait(() => Atomics.load(next.slot.control, h.executionWords.emitted) === 1, 'A new explicit real Worker can reserve capacity')
  await h.core.closeIncidentExecution(h.context, next.locator)
  await h.wait(() => next.slot.producer === 'finished', 'New real Worker cooperatively finishes')
  await h.core.closeIncidentExecution(h.context, next.locator)
  assert.equal(h.executionOwner().slot, null)
  await h.sourceZero()
  console.log('PASS native accepted finished ACK survives concurrent successful owner close without quarantine')
}
finally {
  armClose = false
  releaseClose()
  if (closePromise) await closePromise
  if (finished && !forwarded) forwardGenuine()
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  attachment?.release()
  await h.close()
}
