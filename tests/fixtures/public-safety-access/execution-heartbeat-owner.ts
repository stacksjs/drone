/* eslint-disable ts/no-top-level-await, no-console */
// Controlled actual heartbeat/replay overlap, not natural timing or instruction cancellation.
import type { ExecutionWorkerMessage } from '../../../resources/functions/drone/public-safety/execution/protocol'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const core = await import('../../../resources/functions/drone/public-safety/execution/service')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
const { examplePublicSafetyConfig } = await import('../../../resources/functions/drone/public-safety/fixtures')
const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const { enhanceRequest, getCurrentRequest, runWithRequest } = await import('@stacksjs/router')
const limits = (await import('../../../config/execution')).default
interface HeartbeatSlot {
  worker: Worker | null, control: Int32Array, ownerCheckBusy: boolean,
  processing: boolean, pendingEvent: object | null, phase: string, reason: string | null,
  producer: string, candidate: object | null, recording: string | null,
  completion: object | null, admission: string, wallDeadline: number,
}
let slot: HeartbeatSlot | undefined, heldResult: MessageEvent | undefined
let context: ReturnType<typeof core.captureExecutionContext> | undefined
let locator: { execution: string, scope: string } | undefined
let attachment: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
let observe: Worker['onmessage'] = null
let worker: Worker | undefined
const fifo: MessageEvent[] = []
let captureHeartbeat = true, gateCaptured = false, gateBodySettled = false, resultDelegated = false
let releaseGate!: () => void
const holdGate = new Promise<void>(resolve => { releaseGate = resolve })
let announceGate!: () => void
const enteredGate = new Promise<void>(resolve => { announceGate = resolve })
let finishGateBody!: () => void
const settledGateBody = new Promise<void>(resolve => { finishGateBody = resolve })
let gateAt = 0, replayMs = 0, gateElapsedAtReplayEnd = 0, gateElapsedAtCheckSettlement = 0
let entryPending = 0, entryOwnerBusy = false, completedViews = 0, events = 0, forwardedRealAcks = 0
let delegatedGateCalls = 0, postResultGateCalls = 0, sameOwnerRequestCalls = 0, postResultOwnerBusyCalls = 0
interface StateObservation { phase: string, reason: string | null, producer: string, pending: number, ownerBusy: boolean, processing: boolean, wallRemainingMs: number }
interface ErrorObservation { valueType: string, name: string | null, message: string | null, frames: string[] }
const workerErrors: { atMs: number, eventType: string | null, eventName: string | null, eventMessage: string | null, error: ErrorObservation, before: StateObservation | undefined }[] = []
const wrapperExceptions: { atMs: number, kind: string | null, error: ErrorObservation, before: StateObservation | undefined }[] = []
const genuineAcks: { atMs: number, outcome: string | null, transferred: boolean | null, retained: boolean, before: StateObservation | undefined }[] = []
const boundedText = (value: unknown, limit = 256) => typeof value === 'string' ? value.slice(0, limit) : null
const errorObservation = (value: unknown): ErrorObservation => {
  if (!(value instanceof Error)) return { valueType: typeof value, name: null, message: null, frames: [] }
  return {
    valueType: 'Error', name: boundedText(value.name, 64), message: boundedText(value.message),
    frames: (value.stack ?? '').split('\n').filter(line => line.includes('/resources/functions/drone/public-safety/') || line.includes('/tests/fixtures/public-safety-access/execution-heartbeat-owner.ts:')).slice(0, 6).map(line => line.trim().slice(0, 512)),
  }
}
let resultReceipt: StateObservation | undefined, firstInactive: StateObservation | undefined
let inactiveResultDelegated = false
const active = () => !!slot && ['waiting-for-consumer', 'running'].includes(slot.phase)
const state = (): StateObservation | undefined => slot ? { phase: slot.phase, reason: slot.reason, producer: slot.producer, pending: executionOwner().pendingChecks, ownerBusy: slot.ownerCheckBusy, processing: slot.processing, wallRemainingMs: slot.wallDeadline - Date.now() } : undefined
const recordInactive = () => { if (!firstInactive && !active()) firstInactive = state() }
const ownerRequest = enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents/heartbeat/execution/start', { method: 'POST', headers: { authorization: `Bearer ${f.senderToken}` } }) as Parameters<typeof enhanceRequest>[0])
const flushGenuine = () => {
  if (!worker || !observe) return
  for (const event of fifo.splice(0)) {
    if (event.data?.kind === 'finished') forwardedRealAcks++
    observe.call(worker, event)
  }
}
const settleNativeCheck = async () => {
  if (gateCaptured) await settledGateBody
  const until = Date.now() + 5000
  while ((executionOwner().pendingChecks || slot?.ownerCheckBusy) && Date.now() < until) await Bun.sleep(0)
  assert.equal(executionOwner().pendingChecks, 0, 'The actual native transaction/promise has settled, not merely its timeout')
  if (slot) assert.equal(slot.ownerCheckBusy, false, 'The actual heartbeat continuation settled before forwarding genuine ACK')
}
try {
  const config = examplePublicSafetyConfig()
  config.id = 'execution-heartbeat-owner'
  config.revision = 'r1'
  config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const before = await f.snapshot(config.id)
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(config.id))).scope
  const delegatedSourceGate: Parameters<typeof Gate.define>[1] = async (user, key) => {
    assert(typeof key === 'string')
    delegatedGateCalls++
    if (getCurrentRequest() === ownerRequest) sameOwnerRequestCalls++
    if (heldResult) {
      postResultGateCalls++
      if (slot?.ownerCheckBusy) postResultOwnerBusyCalls++
    }
    const allowed = await publicSafetyIncidentGate(user, key, 'source-register')
    if (!captureHeartbeat || gateCaptured || !heldResult || !slot?.ownerCheckBusy || getCurrentRequest() !== ownerRequest) return allowed
    assert(allowed, 'Every authority decision delegates actual native policy')
    assert(isInTransaction(), 'This is the actual heartbeat native check transaction')
    assert.equal(Atomics.load(slot.control, executionWords.returned), 1)
    assert.equal(slot.processing, false)
    assert.equal(slot.pendingEvent, null)
    assert.equal(Atomics.load(slot.control, executionWords.credit), Atomics.load(slot.control, executionWords.emitted))
    gateCaptured = true
    gateAt = performance.now()
    announceGate()
    try { await holdGate }
    finally {
      gateBodySettled = true
      finishGateBody()
    }
    return allowed
  }
  const started = await runWithRequest(ownerRequest, async () => {
    context = core.captureExecutionContext(config.id)
    return core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 100 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
  })
  locator = { execution: started.execution, scope }
  slot = executionOwner().slot as HeartbeatSlot
  // Match the qualified production-smoke ordering: finish actual native start
  // before installing a delegated diagnostic Gate. No boot registration is bypassed.
  Gate.define('public-safety:source-register', delegatedSourceGate)
  assert(slot.worker)
  worker = slot.worker
  observe = worker.onmessage
  assert(observe)
  const originalWorkerError = worker.onerror
  worker.onerror = event => {
    // Preserve the actual receiver and error policy. Diagnostics hold no token,
    // recording or arbitrary payload and never prevent the original callback.
    if (workerErrors.length < 4) {
      const payload = event as { type?: unknown, name?: unknown, message?: unknown, error?: unknown }
      workerErrors.push({ atMs: performance.now(), eventType: boundedText(payload.type, 64), eventName: boundedText(payload.name, 64), eventMessage: boundedText(payload.message), error: errorObservation(payload.error ?? event), before: state() })
    }
    return originalWorkerError?.call(worker!, event)
  }
  worker.onmessage = event => {
    try {
      if (event.data?.kind === 'finished' && genuineAcks.length < 4) {
        genuineAcks.push({ atMs: performance.now(), outcome: boundedText(event.data.outcome, 32), transferred: typeof event.data.transferred === 'boolean' ? event.data.transferred : null, retained: !!heldResult, before: state() })
      }
      if (heldResult) {
        // The unchanged producer emits only its genuine owned-work ACK after result.
        assert.equal(event.data?.kind, 'finished')
        assert.equal(fifo.length, 0)
        fifo.push(event)
        return
      }
      if (event.data?.kind === 'result') {
        resultReceipt = state()
        if (!active()) {
          recordInactive()
          inactiveResultDelegated = true
          observe!.call(worker!, event)
          return
        }
        heldResult = event
        return
      }
      if (event.data?.kind === 'finished') forwardedRealAcks++
      observe!.call(worker!, event)
    }
    catch (error) {
      if (wrapperExceptions.length < 4) wrapperExceptions.push({ atMs: performance.now(), kind: boundedText(event.data?.kind, 32), error: errorObservation(error), before: state() })
      throw error
    }
  }
  const subscriberRequest = enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents/heartbeat/execution/events', { headers: { authorization: `Bearer ${f.senderToken}` } }) as Parameters<typeof enhanceRequest>[0])
  attachment = await runWithRequest(subscriberRequest, async () => {
    const subscriber = core.captureExecutionContext(config.id)
    return core.attachIncidentExecution(subscriber, locator!, value => {
      if (value.latestEvent) events++
      if (value.phase === 'completed' || value.completion) completedViews++
    })
  })
  await attachment.activate()
  const until = Date.parse(started.availableUntil)
  while (!heldResult && ['waiting-for-consumer', 'running'].includes(slot.phase) && Date.now() < until) await Bun.sleep(20)
  const resultEvent = heldResult as MessageEvent | undefined
  assert(resultEvent, `No eligible result for controlled overlap: ${JSON.stringify(resultReceipt ?? state())}`)
  const message = resultEvent.data as ExecutionWorkerMessage
  assert.equal(message.kind, 'result')
  assert(message.kind === 'result')
  const digest = message.digest
  let gateTimer: ReturnType<typeof setTimeout> | undefined
  let inactiveTimer: ReturnType<typeof setInterval> | undefined
  try {
    await Promise.race([enteredGate, new Promise<never>((resolve, reject) => {
      void resolve
      gateTimer = setTimeout(() => reject(new Error('Actual next owner heartbeat was not captured before the unchanged wall deadline')), Math.max(1, until - Date.now()))
      inactiveTimer = setInterval(() => {
        if (!active()) {
          recordInactive()
          reject(new Error(`Run stopped before controlled heartbeat capture: ${JSON.stringify(firstInactive)}`))
        }
      }, 20)
    })])
  }
  finally {
    clearTimeout(gateTimer)
    clearInterval(inactiveTimer)
  }
  entryPending = executionOwner().pendingChecks
  entryOwnerBusy = slot.ownerCheckBusy
  assert.equal(entryPending, 1)
  assert.equal(entryOwnerBusy, true)
  assert.equal(slot.phase, 'running')
  assert(Date.now() < slot.wallDeadline, 'No wall deadline substitution for the targeted check budget')
  const at = performance.now()
  observe.call(worker, resultEvent)
  replayMs = performance.now() - at
  resultDelegated = true
  gateElapsedAtReplayEnd = performance.now() - gateAt
  assert(slot.candidate, 'The exact production result handler completed unchanged full canonical validation')
  assert.equal(slot.producer, 'pending', 'The genuine final ACK is still retained, not fabricated')
  releaseGate()
  await settleNativeCheck()
  gateElapsedAtCheckSettlement = performance.now() - gateAt
  recordInactive()
  assert.equal(gateBodySettled, true)
  assert(replayMs > limits.checkTimeoutMs, `Controlled window not sampled: real replay ${replayMs}ms did not itself cross ${limits.checkTimeoutMs}ms`)
  assert.equal(slot.phase, 'stopping')
  assert.equal(slot.reason, 'authority-unavailable')
  assert.equal(slot.candidate, null)
  assert.equal(slot.recording, null)
  assert.equal(slot.completion, null)
  // Actual native work is settled before the exact genuine producer ACK is delegated.
  const ackUntil = Date.now() + limits.stopGraceMs
  while (!fifo.length && Date.now() < ackUntil) await Bun.sleep(0)
  assert.equal(fifo.length, 1)
  assert.equal(fifo[0]!.data.outcome, 'completed')
  assert.equal(fifo[0]!.data.transferred, true)
  flushGenuine()
  assert.equal(forwardedRealAcks, 1)
  assert.equal(slot.producer, 'finished')
  assert.equal(slot.phase, 'canceled')
  const current = await core.readIncidentExecution(context!, { scope })
  assert.equal(current!.phase, 'canceled')
  assert.equal(current!.completion, null)
  assert.equal(completedViews, 0)
  assert(events > 0)
  await assert.rejects(() => core.admitIncidentExecution(context!, { ...locator!, digest, expectedVersion: 1 }), f.status(409))
  assert.deepEqual(await f.snapshot(config.id), before)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(config.id))).entries.length, 0)
  assert.equal((await core.closeIncidentExecution(context!, locator)).phase, 'discarded')
  console.log('PASS native pending owner heartbeat refuses real nominal replay after elapsed deadline')
}
finally {
  captureHeartbeat = false
  recordInactive()
  releaseGate()
  await settleNativeCheck()
  attachment?.release()
  if (context && locator && slot && ['waiting-for-consumer', 'running'].includes(slot.phase)) await core.closeIncidentExecution(context, locator).catch(() => {})
  if (heldResult && !resultDelegated && worker && observe) observe.call(worker, heldResult)
  flushGenuine()
  if (slot) {
    const until = Date.now() + limits.stopGraceMs + 1000
    while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
    if (slot.producer === 'pending') slot.worker?.terminate()
  }
  console.log(`OWNER_HEARTBEAT ${JSON.stringify({ controlledTiming: true, requestedSeconds: 100, checkBudgetMs: limits.checkTimeoutMs, wallBudgetMs: limits.runWallMs, entryPending, entryOwnerBusy, resultReceipt, firstInactive, inactiveResultDelegated, workerErrors, wrapperExceptions, genuineAcks, delegatedGateCalls, postResultGateCalls, sameOwnerRequestCalls, postResultOwnerBusyCalls, actualGateBodySettled: gateBodySettled, replayMs, gateElapsedAtReplayEnd, gateElapsedAtCheckSettlement, forwardedRealAcks, completedViews, events, finalPhase: slot?.phase, finalReason: slot?.reason, finalProducer: slot?.producer })}`)
  await f.database.closeDatabaseConnection()
}
