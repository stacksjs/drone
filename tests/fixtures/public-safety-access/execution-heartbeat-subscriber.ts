/* eslint-disable ts/no-top-level-await, no-console */
// Real GET check and genuine replay plus separate parent stall, not SSE delivery or CPU cost.
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
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { enhanceRequest, getCurrentRequest, runWithRequest } = await import('@stacksjs/router')
const { createBroadcastHub, setServer } = await import('@stacksjs/realtime/server-instance')
const limits = (await import('../../../config/execution')).default
interface SubscriberSlot {
  worker: Worker | null, control: Int32Array, ownerCheckBusy: boolean, processing: boolean,
  pendingEvent: object | null, phase: string, reason: string | null, producer: string,
  candidate: object | null, recording: string | null, completion: object | null,
  admission: string, subscriber: unknown, wallDeadline: number,
  binding: { authorityUntil: number, retainUntil: string },
}
const key = 'execution-heartbeat-sub'
const makeRequest = (operation: string, method = 'GET') => enhanceRequest(new Request(`https://incident.invalid/api/public-safety/incidents/${key}/workspace/execution/${operation}`, { method, headers: { authorization: `Bearer ${f.senderToken}` } }) as Parameters<typeof enhanceRequest>[0])
const ownerRequest = makeRequest('start', 'POST'), subscriberRequest = makeRequest('events')
const hints: unknown[] = []
const unhookHints = createBroadcastHub().addBroadcastHook(hint => { hints.push(hint) })
let slot: SubscriberSlot | undefined, worker: Worker | undefined, observe: Worker['onmessage'] = null
let context: ReturnType<typeof core.captureExecutionContext> | undefined
let locator: { execution: string, scope: string } | undefined
let attachment: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
let replacement: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
let heldResult: MessageEvent | undefined, resultDelegated = false, holdChecks = false
const fifo: MessageEvent[] = [], workerErrors: unknown[] = [], closeCodes: (number | null)[] = []
const acks: { outcome: unknown, transferred: unknown }[] = []
let checkPromise: Promise<void> | undefined, checkError: unknown, checkReturned = false
let releaseGate!: () => void, enteredGate!: () => void, finishGateBody!: () => void
const heldGate = new Promise<void>(resolve => { releaseGate = resolve })
const gateEntered = new Promise<void>(resolve => { enteredGate = resolve })
const gateBodySettled = new Promise<void>(resolve => { finishGateBody = resolve })
let gateCaptured = false, gateBodyDone = false, releasedForCheckFailure = false
let gateAt = 0, checkAt = 0, replayMs = 0, checkElapsedMs = 0, settledElapsedMs = 0
let requestedSupplementalBlockMs = 0, supplementalParentBlockMs = 0, conservativeGateWindowMs = 0
let sentinelFired = false, settledBeforeSentinel = false
let sentinelTimer: ReturnType<typeof setTimeout> | undefined
let entryPending = 0, entryOwnerBusy = false, forwardedAcks = 0, completedBeforeAck = 0
let resultReceipt: unknown, sourceInsertObserved = false, sourceCommits = 0, sourceAudits = 0
let unhookWrites: (() => void) | undefined
const stringField = (value: unknown, name: string) => {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null
  try {
    const field = (value as Record<string, unknown>)[name]
    return typeof field === 'string' ? field : null
  }
  catch { return null }
}
const bounded = (value: string | null) => value === null ? null : { length: value.length, head: value.slice(0, 256), tail: value.length > 256 ? value.slice(-256) : '' }
const state = () => slot ? { phase: slot.phase, reason: slot.reason, producer: slot.producer, pending: executionOwner().pendingChecks, ownerBusy: slot.ownerCheckBusy, processing: slot.processing, wallRemainingMs: slot.wallDeadline - Date.now() } : null
const wait = async (predicate: () => boolean, message: string, timeout = 5000) => {
  const until = Date.now() + timeout
  while (!predicate() && Date.now() < until) await Bun.sleep(10)
  assert(predicate(), `${message}: ${JSON.stringify(state())}`)
}
const flushGenuine = () => {
  if (!worker || !observe) return
  for (const event of fifo.splice(0)) {
    if (event.data?.kind === 'finished') forwardedAcks++
    observe.call(worker, event)
  }
}
try {
  const config = examplePublicSafetyConfig()
  config.id = key
  config.revision = 'r1'
  config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const before = await f.snapshot(key), beforeHints = hints.length
  const beforeVersion = before.incident!.version
  assert(typeof beforeVersion === 'number')
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(key))).scope
  const started = await runWithRequest(ownerRequest, async () => {
    context = core.captureExecutionContext(key)
    return core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 100 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
  })
  locator = { execution: started.execution, scope }
  slot = executionOwner().slot as SubscriberSlot
  assert(slot.worker)
  worker = slot.worker
  observe = worker.onmessage
  assert(observe)
  worker.addEventListener('error', event => {
    if (workerErrors.length < 4) workerErrors.push({ type: event.type, message: bounded(stringField(event, 'message')) })
  })
  worker.addEventListener('close', event => {
    if (closeCodes.length < 4) closeCodes.push('code' in event && typeof event.code === 'number' ? event.code : null)
  })
  worker.onmessage = event => {
    if (event.data?.kind === 'finished' && acks.length < 4) acks.push({ outcome: event.data.outcome, transferred: event.data.transferred })
    if (heldResult) {
      assert.equal(event.data?.kind, 'finished')
      assert.equal(fifo.length, 0)
      fifo.push(event)
      return
    }
    if (event.data?.kind === 'result') {
      resultReceipt = state()
      assert.equal(slot!.phase, 'running')
      heldResult = event
      return
    }
    observe!.call(worker!, event)
  }
  // Real native policy always decides; only this actual GET's later check is delayed.
  Gate.define('public-safety:source-register', async (user, incident) => {
    assert(typeof incident === 'string')
    const allowed = await publicSafetyIncidentGate(user, incident, 'source-register')
    if (!holdChecks || gateCaptured || getCurrentRequest() !== subscriberRequest) return allowed
    assert(allowed)
    assert(isInTransaction())
    assert(slot)
    assert.equal(slot.ownerCheckBusy, false)
    gateCaptured = true
    gateAt = performance.now()
    enteredGate()
    try { await heldGate }
    finally {
      gateBodyDone = true
      finishGateBody()
    }
    return allowed
  })
  attachment = await runWithRequest(subscriberRequest, async () => {
    const captured = core.captureExecutionContext(key)
    return core.attachIncidentExecution(captured, locator!, value => {
      if (value.phase === 'completed' || value.completion) completedBeforeAck++
    })
  })
  await attachment.activate()
  const until = Date.parse(started.availableUntil)
  while (!heldResult && ['waiting-for-consumer', 'running'].includes(slot.phase) && Date.now() < until) await Bun.sleep(20)
  assert(heldResult, `No eligible genuine result: ${JSON.stringify(state())}`)
  assert.equal(slot.processing, false)
  assert.equal(slot.pendingEvent, null)
  assert.equal(executionOwner().pendingChecks, 0)
  assert.equal(slot.ownerCheckBusy, false)
  assert.equal(Atomics.load(slot.control, executionWords.returned), 1)
  const digest = heldResult.data.digest as string
  holdChecks = true
  checkAt = performance.now()
  checkPromise = attachment.check().then(() => { checkReturned = true }).catch(error => {
    checkError = error
    // The actual HTTP boundary calls this idempotent release after check failure.
    attachment!.release()
    releasedForCheckFailure = true
  })
  let gateTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([gateEntered, new Promise<never>((resolve, reject) => {
      void resolve
      gateTimer = setTimeout(() => reject(new Error(`Subscriber Gate not captured: ${JSON.stringify(state())}`)), Math.min(5000, Math.max(1, until - Date.now())))
    })])
  }
  finally { clearTimeout(gateTimer) }
  entryPending = executionOwner().pendingChecks
  entryOwnerBusy = slot.ownerCheckBusy
  assert.equal(entryPending, 1)
  assert.equal(entryOwnerBusy, false)
  assert.equal(slot.phase, 'running')
  assert(performance.now() - checkAt < limits.checkTimeoutMs, 'Prior-call elapsed upper bound remains below the native check budget at sentinel arm')
  assert.equal(checkReturned, false)
  assert(Object.is(checkError, undefined))
  assert.equal(releasedForCheckFailure, false)
  assert(performance.now() - gateAt < limits.checkTimeoutMs, 'Conservative Gate-entry window still precedes its full native check budget')
  sentinelTimer = setTimeout(() => { sentinelFired = true }, 0)
  const at = performance.now()
  observe.call(worker, heldResult)
  replayMs = performance.now() - at
  resultDelegated = true
  assert(slot.candidate)
  assert.equal(slot.producer, 'pending')
  // Supplement only this private scratch word; producer controls stay untouched.
  requestedSupplementalBlockMs = Math.max(0, gateAt + limits.checkTimeoutMs + 50 - performance.now())
  if (requestedSupplementalBlockMs > 0) {
    const blockAt = performance.now()
    assert.equal(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, requestedSupplementalBlockMs), 'timed-out')
    supplementalParentBlockMs = performance.now() - blockAt
  }
  conservativeGateWindowMs = performance.now() - gateAt
  assert(conservativeGateWindowMs > limits.checkTimeoutMs)
  assert(Date.now() < slot.wallDeadline && Date.now() < slot.binding.authorityUntil && Date.now() < Date.parse(slot.binding.retainUntil), 'Wall, token and incident retention deadlines remain future')
  releaseGate()
  await gateBodySettled
  await checkPromise
  checkElapsedMs = performance.now() - checkAt
  assert.equal(executionOwner().pendingChecks, 0, 'Actual native SQL settled before the check outcome')
  assert.equal(slot.ownerCheckBusy, false)
  settledElapsedMs = performance.now() - gateAt
  settledBeforeSentinel = !sentinelFired
  assert.equal(settledBeforeSentinel, true, 'Native subscriber decision must precede the earlier-due timer sentinel')
  clearTimeout(sentinelTimer)
  assert(checkError instanceof f.access.PublicSafetyAccessError && checkError.status === 404)
  assert.equal(checkReturned, false)
  assert.equal(gateBodyDone, true)
  assert.equal(releasedForCheckFailure, true)
  assert.equal(slot.subscriber, null)
  assert.equal(slot.phase, 'running', 'Subscriber timeout alone must not cancel original owner work')
  assert.equal(slot.reason, null)
  assert(slot.candidate)
  assert.equal(completedBeforeAck, 0)
  assert.deepEqual(await f.snapshot(key), before)
  assert.equal(hints.length, beforeHints)
  await wait(() => fifo.length === 1, 'Retain the exact genuine finished ACK')
  assert.deepEqual(acks, [{ outcome: 'completed', transferred: true }])
  flushGenuine()
  await wait(() => slot!.phase === 'completed', 'Fresh actual original owner authority accepts the candidate')
  assert.equal(forwardedAcks, 1)
  assert.equal(slot.producer, 'finished')
  const completed = await core.readIncidentExecution(context!, { scope })
  assert.equal(completed!.completion!.digest, digest)
  replacement = await runWithRequest(makeRequest('events'), async () => {
    const captured = core.captureExecutionContext(key)
    return core.attachIncidentExecution(captured, locator!, () => {})
  })
  await replacement.activate()
  attachment.release()
  attachment.release()
  assert.equal((await replacement.check()).completion!.digest, digest)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))).entries.length, 0)
  const admitRequest = makeRequest('admission', 'POST')
  unhookWrites = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (/^insert into public_safety_sources\b/.test(sql)) sourceInsertObserved = true
    if (/^insert into public_safety_audits\b/.test(sql)) sourceAudits++
  } })
  f.database.db.primary.setTransactionDefaults({ afterCommit: () => {
    if (getCurrentRequest() === admitRequest && sourceInsertObserved && sourceCommits === 0) sourceCommits++
  } })
  const registered = await runWithRequest(admitRequest, async () => {
    const captured = core.captureExecutionContext(key)
    return core.admitIncidentExecution(captured, { ...locator!, digest, expectedVersion: beforeVersion })
  })
  unhookWrites()
  unhookWrites = undefined
  f.database.db.primary.setTransactionDefaults({ afterCommit: undefined })
  assert.equal(sourceInsertObserved, true)
  assert.equal(sourceCommits, 1)
  assert.equal(sourceAudits, 1)
  assert.equal(registered.source.digest, digest)
  assert.equal(registered.incident.version, beforeVersion + 1)
  const sources = await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))
  assert.equal(sources.entries.length, 1)
  assert.equal(sources.entries[0]!.digest, digest)
  const after = await f.snapshot(key)
  assert.equal(after.incident!.version, beforeVersion + 1)
  assert.equal(after.audits.length, before.audits.length + 1)
  assert.equal(after.audits.at(-1)!.action, 'source-registered')
  assert.equal(hints.length, beforeHints + 1)
  replacement.release()
  assert.equal((await core.closeIncidentExecution(context!, locator)).phase, 'discarded')
  await wait(() => closeCodes.length > 0 && executionOwner().pendingChecks === 0, 'Native close marker and actual pending settlement')
  assert.deepEqual(closeCodes, [0])
  assert.deepEqual(workerErrors, [])
  console.log('PASS native subscriber elapsed fence before timer tasks preserves owner completion and explicit admission')
}
finally {
  holdChecks = false
  clearTimeout(sentinelTimer)
  releaseGate()
  if (gateCaptured) await gateBodySettled
  if (checkPromise) await checkPromise
  attachment?.release()
  replacement?.release()
  unhookWrites?.()
  f.database.db.primary.setTransactionDefaults({ afterCommit: undefined })
  if (context && locator && slot && ['waiting-for-consumer', 'running'].includes(slot.phase)) await core.closeIncidentExecution(context, locator).catch(() => {})
  if (heldResult && !resultDelegated && worker && observe) observe.call(worker, heldResult)
  flushGenuine()
  await wait(() => executionOwner().pendingChecks === 0 && !slot?.ownerCheckBusy, 'Actual native work settled before database close')
  if (slot) {
    const until = Date.now() + limits.stopGraceMs + 1000
    while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
    if (slot.producer === 'pending') slot.worker?.terminate()
  }
  console.log(`SUBSCRIBER_HEARTBEAT ${JSON.stringify({ controlledTiming: true, requestedSeconds: 100, checkBudgetMs: limits.checkTimeoutMs, resultReceipt, entryPending, entryOwnerBusy, gateCaptured, gateBodyDone, replayMs, requestedSupplementalBlockMs, supplementalParentBlockMs, conservativeGateWindowMs, settledBeforeSentinel, sentinelFired, checkElapsedMs, settledElapsedMs, checkReturned, checkStatus: checkError instanceof f.access.PublicSafetyAccessError ? checkError.status : null, releasedForCheckFailure, forwardedAcks, completedBeforeAck, sourceInsertObserved, sourceCommits, sourceAudits, workerErrors, closeCodes, final: state(), closeMarkerIsOsJoin: false })}`)
  unhookHints()
  setServer(null)
  await f.database.closeDatabaseConnection()
}
