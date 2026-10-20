/* eslint-disable ts/no-top-level-await, no-console */
// Native source work plus separate parent stall, not exact canonical CPU or HTTP transport.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const core = await import('../../../resources/functions/drone/public-safety/execution/service')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
const { examplePublicSafetyConfig } = await import('../../../resources/functions/drone/public-safety/fixtures')
const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { enhanceRequest, getCurrentRequest, runWithRequest } = await import('@stacksjs/router')
const { createBroadcastHub, setServer } = await import('@stacksjs/realtime/server-instance')
const limits = (await import('../../../config/execution')).default
interface AdmissionSlot {
  worker: Worker | null, phase: string, reason: string | null, producer: string,
  ownerCheckBusy: boolean, recording: string | null, admission: string,
  metadataDeadline: number, subscriber: unknown, wallDeadline: number,
  binding: { authorityUntil: number, retainUntil: string },
}
const key = 'execution-h-admit'
const request = (operation: string, method = 'GET') => enhanceRequest(new Request(`https://incident.invalid/api/public-safety/incidents/${key}/workspace/execution/${operation}`, { method, headers: { authorization: `Bearer ${f.senderToken}` } }) as Parameters<typeof enhanceRequest>[0])
const ownerRequest = request('start', 'POST'), subscriberRequest = request('events'), admitRequest = request('admission', 'POST')
let context: ReturnType<typeof core.captureExecutionContext> | undefined
let locator: { execution: string, scope: string } | undefined, slot: AdmissionSlot | undefined
let live: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
let subscriber: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
let admitPromise: Promise<void> | undefined, subscriberPromise: Promise<void> | undefined
let admitted: Awaited<ReturnType<typeof core.admitIncidentExecution>> | undefined
let admitError: unknown, subscriberError: unknown, subscriberReturned = false, admitRejected = false
const hints: unknown[] = [], errors: unknown[] = [], closeCodes: (number | null)[] = []
const acks: { outcome: unknown, transferred: unknown }[] = []
const unhookHints = createBroadcastHub().addBroadcastHook(hint => { hints.push(hint) })
let unhookWrites: (() => void) | undefined
let releasePreflight!: () => void, preflightEntered!: () => void, releaseSubscriber!: () => void, subscriberEntered!: () => void
const preflightHold = new Promise<void>(resolve => { releasePreflight = resolve })
const preflightReady = new Promise<void>(resolve => { preflightEntered = resolve })
const subscriberHold = new Promise<void>(resolve => { releaseSubscriber = resolve })
const subscriberReady = new Promise<void>(resolve => { subscriberEntered = resolve })
let preflightCaptured = false, subscriberCaptured = false, armPreflight = false, armSubscriber = false
let preflightBodyDone = false, subscriberBodyDone = false, releasedForSubscriberFailure = false
let initialAuthorityCommits = 0, subscriberNativeCommits = 0, sourceCommits = 0, nativeRollbacks = 0
let sourceInsert = 0, sourceAudit = 0, sourceAdvance = 0, checkedGuardReads = 0
let initialAuthorityCommitAt = 0, subscriberNativeCommitAt = 0, firstWriterDmlAt = 0, sourceCommitAt = 0
let preflightReleaseAt = 0, subscriberCheckAt = 0, subscriberGateAt = 0, zeroTaskAt = 0, subscriberSettledAt = 0
let entryPending = 0, entryOwnerBusy = false, zeroTaskPending = 0, zeroTaskBodyHeld = false
let zeroTaskOwnsReservation = false, zeroTaskRecordingRetained = false, zeroTaskAdmission: string | null = null
let releaseTask: ReturnType<typeof setTimeout> | undefined, sentinelTimer: ReturnType<typeof setTimeout> | undefined
let requestedSupplementalBlockMs = 0, supplementalParentBlockMs = 0, conservativeGateWindowMs = 0
let sentinelFired = false, releaseBeforeSentinel = false, settledBeforeSentinel = false, pendingAtSubscriberCommit = 0
let pendingAtSubscriberOutcome = -1, nativeCommitBeforeOutcome = false
const order: string[] = []
const state = () => slot ? { phase: slot.phase, reason: slot.reason, producer: slot.producer, admission: slot.admission, pending: executionOwner().pendingChecks, ownerBusy: slot.ownerCheckBusy, recordingRetained: !!slot.recording } : null
const wait = async (predicate: () => boolean, message: string, timeout = 5000) => {
  const until = Date.now() + timeout
  while (!predicate() && Date.now() < until) await Bun.sleep(10)
  assert(predicate(), `${message}: ${JSON.stringify(state())}`)
}
const errorStatus = (error: unknown) => error instanceof f.access.PublicSafetyAccessError ? error.status : null
try {
  const config = examplePublicSafetyConfig()
  config.id = key
  config.revision = 'r1'
  config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const before = await f.snapshot(key), beforeHints = hints.length
  const expectedVersion = before.incident!.version
  assert(typeof expectedVersion === 'number')
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(key))).scope
  const started = await runWithRequest(ownerRequest, async () => {
    context = core.captureExecutionContext(key)
    return core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 100 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
  })
  locator = { execution: started.execution, scope }
  slot = executionOwner().slot as AdmissionSlot
  const originalSlot = slot
  assert(slot.worker)
  slot.worker.addEventListener('error', event => {
    if (errors.length < 4) errors.push({ type: event.type, message: typeof event.message === 'string' ? event.message.slice(0, 256) : null })
  })
  slot.worker.addEventListener('message', event => {
    if (event.data?.kind === 'finished' && acks.length < 4) acks.push({ outcome: event.data.outcome, transferred: event.data.transferred })
  })
  slot.worker.addEventListener('close', event => {
    if (closeCodes.length < 4) closeCodes.push('code' in event && typeof event.code === 'number' ? event.code : null)
  })
  Gate.define('public-safety:source-register', async (user, incident) => {
    assert(typeof incident === 'string')
    const allowed = await publicSafetyIncidentGate(user, incident, 'source-register')
    if (armPreflight && !preflightCaptured && getCurrentRequest() === admitRequest && !isInTransaction()) {
      assert(allowed)
      assert.equal(initialAuthorityCommits, 1)
      assert.equal(slot!.admission, 'submitting')
      preflightCaptured = true
      order.push('outside-tx-final-preflight-allowed-held')
      preflightEntered()
      try { await preflightHold }
      finally { preflightBodyDone = true }
    }
    if (armSubscriber && !subscriberCaptured && getCurrentRequest() === subscriberRequest) {
      assert(allowed)
      assert(isInTransaction())
      assert.equal(slot!.phase, 'completed')
      assert.equal(slot!.admission, 'submitting')
      assert.equal(slot!.ownerCheckBusy, false)
      subscriberCaptured = true
      subscriberGateAt = performance.now()
      order.push('subscriber-native-tx-allowed-held')
      subscriberEntered()
      try { await subscriberHold }
      finally { subscriberBodyDone = true }
    }
    return allowed
  })
  live = await f.as(f.senderToken, async () => {
    const captured = core.captureExecutionContext(key)
    return core.attachIncidentExecution(captured, locator!, () => {})
  })
  await live.activate()
  await wait(() => slot!.phase === 'completed', 'Actual nominal100 full canonical completion', Math.max(1, Date.parse(started.availableUntil) - Date.now() + 5000))
  assert.equal(slot.producer, 'finished')
  live.release()
  const completed = await core.readIncidentExecution(context!, { scope })
  const digest = completed!.completion!.digest
  assert(slot.recording)
  await wait(() => executionOwner().pendingChecks === 0 && closeCodes.length > 0, 'Actual finished native checks and close marker')
  assert.deepEqual(acks, [{ outcome: 'completed', transferred: true }])
  assert.deepEqual(closeCodes, [0])
  assert.deepEqual(errors, [])
  assert.deepEqual(await f.snapshot(key), before)
  assert.equal(hints.length, beforeHints)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))).entries.length, 0)
  subscriber = await runWithRequest(subscriberRequest, async () => {
    const captured = core.captureExecutionContext(key)
    return core.attachIncidentExecution(captured, locator!, () => {})
  })
  await subscriber.activate()
  unhookWrites = registerPersistentQueryHooks({ onQueryEnd(event) {
    if (getCurrentRequest() !== admitRequest || !isInTransaction() || !preflightReleaseAt) return
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (!sourceCommits && /^select (?:[a-z_]+\.)?created_at from public_safety_incidents\b/.test(sql)) {
      checkedGuardReads++
      order.push('actual-writer-execution-guard-created-at')
    }
    if (/^update public_safety_incidents\b/.test(sql)) sourceAdvance++
    else if (/^insert into public_safety_sources\b/.test(sql)) sourceInsert++
    else if (/^insert into public_safety_audits\b/.test(sql)) sourceAudit++
    else return
    if (!firstWriterDmlAt) {
      firstWriterDmlAt = performance.now()
      order.push('first-actual-writer-dml')
    }
  } })
  f.database.db.primary.setTransactionDefaults({
    afterCommit: () => {
      if (getCurrentRequest() === subscriberRequest && subscriberCaptured && !subscriberNativeCommits) {
        subscriberNativeCommits++
        subscriberNativeCommitAt = performance.now()
        pendingAtSubscriberCommit = executionOwner().pendingChecks
        order.push('subscriber-actual-native-commit')
      }
      if (getCurrentRequest() !== admitRequest) return
      if (!preflightCaptured) {
        initialAuthorityCommits++
        initialAuthorityCommitAt = performance.now()
        order.push('initial-admit-authority-actual-commit')
      }
      else if (sourceInsert && !sourceCommits) {
        sourceCommits++
        sourceCommitAt = performance.now()
        order.push('sole-source-writer-actual-commit')
      }
    },
    onRollback: () => { nativeRollbacks++ },
  })
  armPreflight = true
  admitPromise = runWithRequest(admitRequest, async () => {
    const captured = core.captureExecutionContext(key)
    return core.admitIncidentExecution(captured, { ...locator!, digest, expectedVersion })
  }).then(value => { admitted = value }).catch(error => {
    admitRejected = true
    admitError = error
  })
  await wait(() => preflightCaptured, 'Final outside-TX preflight after actual initial authority COMMIT')
  await preflightReady
  assert.equal(initialAuthorityCommits, 1)
  assert.equal(executionOwner().pendingChecks, 0)
  armSubscriber = true
  subscriberCheckAt = performance.now()
  subscriberPromise = subscriber.check().then(() => { subscriberReturned = true }).catch(error => {
    subscriberError = error
    subscriber!.release()
    releasedForSubscriberFailure = true
  }).finally(() => {
    subscriberSettledAt = performance.now()
    settledBeforeSentinel = !sentinelFired
    pendingAtSubscriberOutcome = executionOwner().pendingChecks
    nativeCommitBeforeOutcome = subscriberNativeCommits === 1 && subscriberBodyDone
  })
  await wait(() => subscriberCaptured, 'Actual subscriber native transaction acquires SQL while preflight is outside TX')
  await subscriberReady
  entryPending = executionOwner().pendingChecks
  entryOwnerBusy = slot.ownerCheckBusy
  assert.equal(entryPending, 1)
  assert.equal(entryOwnerBusy, false)
  assert.equal(sourceInsert, 0)
  assert.equal(sourceAdvance, 0)
  assert.equal(sourceAudit, 0)
  assert.equal(executionOwner().slot, originalSlot)
  assert(slot.recording)
  assert(performance.now() - subscriberCheckAt < limits.checkTimeoutMs, 'Prior-call elapsed upper bound remains below the native check budget at sentinel arm')
  assert.equal(subscriberReturned, false)
  assert(Object.is(subscriberError, undefined))
  assert.equal(releasedForSubscriberFailure, false)
  assert(performance.now() - subscriberGateAt < limits.checkTimeoutMs, 'Conservative Gate-entry window still precedes its full native check budget')
  releaseTask = setTimeout(() => {
    releaseBeforeSentinel = !sentinelFired
    zeroTaskAt = performance.now()
    zeroTaskPending = executionOwner().pendingChecks
    zeroTaskBodyHeld = !subscriberBodyDone
    zeroTaskOwnsReservation = executionOwner().slot === originalSlot
    zeroTaskRecordingRetained = !!slot!.recording
    zeroTaskAdmission = slot!.admission
    order.push('zero-task-releases-subscriber-native-gate')
    releaseSubscriber()
  }, 0)
  // The release task is due first; the next task must not beat native GET settlement.
  sentinelTimer = setTimeout(() => { sentinelFired = true }, 0)
  requestedSupplementalBlockMs = Math.max(0, subscriberGateAt + limits.checkTimeoutMs + 50 - performance.now())
  if (requestedSupplementalBlockMs > 0) {
    const blockAt = performance.now()
    assert.equal(Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, requestedSupplementalBlockMs), 'timed-out')
    supplementalParentBlockMs = performance.now() - blockAt
  }
  conservativeGateWindowMs = performance.now() - subscriberGateAt
  assert(conservativeGateWindowMs > limits.checkTimeoutMs)
  assert(Date.now() < slot.wallDeadline && Date.now() < slot.metadataDeadline && Date.now() < slot.binding.authorityUntil && Date.now() < Date.parse(slot.binding.retainUntil), 'Wall, token, result and incident retention deadlines remain future')
  preflightReleaseAt = performance.now()
  order.push('release-actual-source-preflight')
  releasePreflight()
  await Promise.all([admitPromise, subscriberPromise])
  await wait(() => executionOwner().pendingChecks === 0, 'Actual native subscriber and admission work settle before oracle reads')
  unhookWrites()
  unhookWrites = undefined
  f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  const sources = await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))
  console.log(`ADMISSION_OVERLAP_OUTCOME ${JSON.stringify({ admitRejected, admitStatus: errorStatus(admitError), sourceCount: sources.entries.length, actualSourceCommits: sourceCommits, admission: slot.admission, sourceWorkTaskSpanMs: zeroTaskAt - preflightReleaseAt })}`)
  assert(subscriberSettledAt - subscriberGateAt > limits.checkTimeoutMs)
  assert.equal(releaseBeforeSentinel, true)
  assert.equal(settledBeforeSentinel, true, 'Actual native GET outcome and SQL settlement must precede the next timer sentinel')
  assert(pendingAtSubscriberCommit >= 1, 'Native pending budget remains owned through actual SQL COMMIT')
  assert.equal(pendingAtSubscriberOutcome, 0)
  assert.equal(nativeCommitBeforeOutcome, true)
  assert.equal(zeroTaskPending, 1)
  assert.equal(zeroTaskBodyHeld, true)
  assert.equal(zeroTaskOwnsReservation, true)
  assert.equal(zeroTaskRecordingRetained, true)
  assert.equal(zeroTaskAdmission, 'submitting')
  assert.equal(preflightBodyDone, true)
  assert.equal(subscriberBodyDone, true)
  assert(subscriberError instanceof f.access.PublicSafetyAccessError && subscriberError.status === 404)
  assert.equal(subscriberReturned, false)
  assert.equal(releasedForSubscriberFailure, true)
  assert.equal(subscriberNativeCommits, 1)
  assert(firstWriterDmlAt >= subscriberNativeCommitAt && subscriberNativeCommitAt > 0, 'Actual native transaction settled before serialized source DML')
  assert.equal(admitRejected, false, 'Preserve an actual unknown/withheld outcome for review, never retry or claim undo')
  assert(admitted)
  assert.equal(checkedGuardReads, 1)
  assert.equal(sourceAdvance, 1)
  assert.equal(sourceInsert, 1)
  assert.equal(sourceAudit, 1)
  assert.equal(sourceCommits, 1)
  assert.equal(nativeRollbacks, 0)
  assert.equal(slot.admission, 'confirmed')
  assert.equal(slot.phase, 'completed')
  assert.equal(slot.reason, null)
  assert.equal(slot.subscriber, null)
  assert.equal(executionOwner().slot, originalSlot)
  assert.equal(admitted.source.digest, digest)
  assert.equal(admitted.incident.version, expectedVersion + 1)
  assert.equal(sources.entries.length, 1)
  assert.equal(sources.entries[0]!.digest, digest)
  const after = await f.snapshot(key)
  assert.equal(after.incident!.version, expectedVersion + 1)
  assert.equal(after.audits.length, before.audits.length + 1)
  assert.equal(after.audits.at(-1)!.action, 'source-registered')
  assert.equal(hints.length, beforeHints + 1)
  assert.equal((await core.readIncidentExecution(context!, { scope }))!.admission, 'confirmed')
  assert.equal((await core.closeIncidentExecution(context!, locator)).phase, 'discarded')
  console.log('PASS native subscriber elapsed fence before next timer task preserves single actual admission COMMIT')
}
finally {
  const beforeCleanup = state()
  armPreflight = false
  armSubscriber = false
  clearTimeout(releaseTask)
  clearTimeout(sentinelTimer)
  releasePreflight()
  releaseSubscriber()
  if (subscriberPromise) await subscriberPromise
  if (admitPromise) await admitPromise
  live?.release()
  subscriber?.release()
  unhookWrites?.()
  f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  await wait(() => executionOwner().pendingChecks === 0 && !slot?.ownerCheckBusy, 'Actual native promises settle before database close')
  if (context && locator && slot && slot.producer !== 'unconfirmed' && executionOwner().slot === slot) {
    await core.closeIncidentExecution(context, locator).catch(() => {})
  }
  if (slot?.producer === 'pending') {
    const until = Date.now() + limits.stopGraceMs + 1000
    while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
    if (slot.producer === 'pending') slot.worker?.terminate()
  }
  console.log(`ADMISSION_HEARTBEAT ${JSON.stringify({ controlledTiming: true, requestedSeconds: 100, checkBudgetMs: limits.checkTimeoutMs, entryPending, entryOwnerBusy, initialAuthorityCommits, initialAuthorityCommitAt, preflightCaptured, preflightBodyDone, subscriberCaptured, subscriberBodyDone, subscriberCheckElapsedMs: subscriberSettledAt && subscriberCheckAt ? subscriberSettledAt - subscriberCheckAt : 0, subscriberGateElapsedMs: subscriberSettledAt && subscriberGateAt ? subscriberSettledAt - subscriberGateAt : 0, sourceWorkTaskSpanMs: zeroTaskAt && preflightReleaseAt ? zeroTaskAt - preflightReleaseAt : 0, requestedSupplementalBlockMs, supplementalParentBlockMs, conservativeGateWindowMs, releaseBeforeSentinel, settledBeforeSentinel, sentinelFired, pendingAtSubscriberCommit, pendingAtSubscriberOutcome, nativeCommitBeforeOutcome, spanIsExactCanonicalCpu: false, zeroTaskPending, zeroTaskBodyHeld, zeroTaskOwnsReservation, zeroTaskRecordingRetained, zeroTaskAdmission, subscriberReturned, subscriberStatus: errorStatus(subscriberError), releasedForSubscriberFailure, subscriberNativeCommits, subscriberNativeCommitAt, firstWriterDmlAt, sourceAdvance, sourceInsert, sourceAudit, checkedGuardReads, sourceCommits, sourceCommitAt, nativeRollbacks, admitStatus: errorStatus(admitError), order, errors, closeCodes, beforeCleanup, final: state(), closeMarkerIsOsJoin: false })}`)
  unhookHints()
  setServer(null)
  await f.database.closeDatabaseConnection()
}
