import type { PublicSafetyEvent, PublicSafetyScenario } from '../runtime-types'
import type { ExecutionStatusInput, ExecutionView, ExecutionStartInput, ExecutionLocator, ExecutionPhase, ExecutionReason, ExecutionCompletion, ExecutionAttachment, ExecutionAdmissionInput } from './types'
import type { ExecutionContext, ExecutionBinding, ExecutionAuthority } from './policy'
import { randomUUID } from 'node:crypto'
import limits from '../../../../../config/execution'
import { PublicSafetyAccessError } from '../access/errors'
import { exactRecord, expectedVersion } from '../access/mutations'
import type { SourceRegistration } from '../access/record-types'
import { registerPublicSafetySourceChecked } from '../access/records'
import { associateIncidentDeadline, assertIncidentDeadline } from '../access/deadline'
import { publicSafetyScenarios } from '../runtime-types'
import { checkExecutionAuthority, matchExecutionBinding, requireExecutionScope, executionAccess } from './policy'
import { executionOwner } from './state'
import { executionWords as words, parseExecutionWorkerMessage, executionDigest } from './protocol'
import type { ExecutionWorkerMessage } from './protocol'
import { publicSafetyRecordingData, validatePublicSafetyRun } from '../evidence'

export { captureExecutionContext } from './policy'
type Timer = ReturnType<typeof setTimeout>
interface Subscriber { id: string, context: ExecutionContext, onView: (value: ExecutionView) => void | Promise<void>, active: boolean }
interface Candidate { recording: string, completion: ExecutionCompletion }
interface ExecutionSlot {
  version: 1
  execution: string
  intent: string
  binding: ExecutionBinding
  owner: ExecutionContext | null
  scenario: PublicSafetyScenario
  seconds: number
  startedAt: number
  wallDeadline: number
  metadataDeadline: number
  phase: ExecutionPhase
  reason: ExecutionReason
  producer: ExecutionView['producer']
  admission: ExecutionView['admission']
  latestEvent: PublicSafetyEvent | null
  completion: ExecutionCompletion | null
  recording: string | null
  worker: Worker | null
  control: Int32Array
  pendingEvent: PublicSafetyEvent | null
  lastSequence: number
  stopTarget: 'canceled' | 'failed'
  generation: number
  ownerCheckBusy: boolean
  subscriber: Subscriber | null
  processing: boolean
  resultSeen: boolean
  candidate: Candidate | null
  finishedAck: boolean
  finalizing: boolean
  wallTimer?: Timer
  consumerTimer?: Timer
  stopTimer?: Timer
  retentionTimer?: Timer
  heartbeatTimer?: ReturnType<typeof setInterval>
}
function unavailable(): never { throw new PublicSafetyAccessError(404, 'Execution is unavailable') }
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid execution locator')
}
function currentSlot(): ExecutionSlot | null {
  const value = executionOwner().slot
  if (value === null) return null
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || !('version' in value) || value.version !== 1 || !('execution' in value) || typeof value.execution !== 'string' || !('binding' in value) || !value.binding || typeof value.binding !== 'object' || !('control' in value) || !(value.control instanceof Int32Array) || value.control.length !== words.length || !('generation' in value) || !Number.isSafeInteger(value.generation) || !('producer' in value) || !['pending', 'finished', 'unconfirmed'].includes(value.producer as string)) throw new PublicSafetyAccessError(409, 'Execution process owner is incompatible')
  return value as ExecutionSlot
}
function owned(slot: ExecutionSlot): boolean { return executionOwner().slot === slot }
function active(slot: ExecutionSlot): boolean { return owned(slot) && (slot.phase === 'waiting-for-consumer' || slot.phase === 'running') }
function deadline(slot: ExecutionSlot): number {
  return Math.min(slot.binding.authorityUntil, active(slot) ? slot.wallDeadline : slot.metadataDeadline)
}
function view(slot: ExecutionSlot, currentDeadline = slot.binding.authorityUntil): ExecutionView {
  const until = Math.min(deadline(slot), currentDeadline)
  const value: ExecutionView = {
    execution: slot.execution, intent: slot.intent, scope: slot.binding.scope, profile: 'owned-public-safety-collection-v1',
    phase: slot.phase, reason: slot.reason, producer: slot.producer, scenario: slot.scenario,
    requestedSeconds: slot.seconds, startedAt: new Date(slot.startedAt).toISOString(), availableUntil: new Date(until).toISOString(),
    latestEvent: slot.latestEvent ? structuredClone(slot.latestEvent) : null,
    completion: slot.completion ? { ...slot.completion } : null, admission: slot.admission,
    identityAuthenticated: true, sourceIdentityAuthenticated: false, physicalFlightEnabled: false, physicalThermalVerified: false,
  }
  const release = (item: unknown) => {
    if (!item || typeof item !== 'object') return
    associateIncidentDeadline(item, until)
    for (const nested of Object.values(item)) release(nested)
    Object.freeze(item)
  }
  release(value); assertIncidentDeadline(value)
  return value
}
function clearTimers(slot: ExecutionSlot): void {
  clearTimeout(slot.wallTimer); clearTimeout(slot.consumerTimer); clearTimeout(slot.stopTimer); clearTimeout(slot.retentionTimer); clearInterval(slot.heartbeatTimer)
}
function dispose(slot: ExecutionSlot): void {
  if (!owned(slot) || slot.producer !== 'finished' || slot.admission === 'submitting') return
  clearTimers(slot)
  slot.owner = null; slot.recording = null; slot.latestEvent = null; slot.completion = null; slot.pendingEvent = null; slot.candidate = null; slot.subscriber = null
  if (slot.worker) { slot.worker.onmessage = null; slot.worker.onerror = null; slot.worker = null }
  executionOwner().slot = null
}
function retain(slot: ExecutionSlot): void {
  clearTimeout(slot.retentionTimer)
  slot.metadataDeadline = Math.min(slot.binding.authorityUntil, Date.now() + limits.retainedMs)
  slot.retentionTimer = setTimeout(() => {
    // Expiry ends candidate eligibility immediately, while an actual submitting
    // mutation retains this reservation until its real promise has settled.
    slot.recording = null; slot.completion = null; slot.latestEvent = null; slot.candidate = null
    dispose(slot)
  }, Math.max(1, slot.metadataDeadline - Date.now()))
  // Volatile metadata expires while the server is alive; it does not keep an
  // otherwise finished process alive or promise recovery after process loss.
  slot.retentionTimer.unref()
}
function stop(slot: ExecutionSlot, reason: Exclude<ExecutionReason, null>, target: 'canceled' | 'failed' = 'canceled'): void {
  if (!active(slot)) return
  slot.generation++; slot.phase = 'stopping'; slot.reason = reason; slot.stopTarget = target
  slot.recording = null; slot.completion = null; slot.latestEvent = null; slot.pendingEvent = null; slot.candidate = null
  clearTimeout(slot.wallTimer); clearTimeout(slot.consumerTimer); clearInterval(slot.heartbeatTimer)
  retain(slot)
  Atomics.store(slot.control, words.cancel, 1); Atomics.notify(slot.control, words.credit)
  slot.stopTimer = setTimeout(() => {
    if (!owned(slot) || slot.producer !== 'pending') return
    slot.producer = 'unconfirmed'; slot.phase = 'failed'; slot.reason = 'stop-unconfirmed'
    slot.owner = null; slot.recording = null; slot.completion = null; slot.latestEvent = null; slot.pendingEvent = null; slot.candidate = null; slot.subscriber = null
    // terminate and close mark termination only. This reservation remains quarantined.
    slot.worker?.terminate()
  }, limits.stopGraceMs)
}
function finishStopped(slot: ExecutionSlot): void {
  clearTimeout(slot.stopTimer); clearTimeout(slot.wallTimer); clearTimeout(slot.consumerTimer); clearInterval(slot.heartbeatTimer)
  slot.producer = 'finished'; slot.owner = null
  slot.phase = slot.stopTarget
  retain(slot)
}
function sameSubscriber(slot: ExecutionSlot, subscriber: Subscriber): boolean {
  return owned(slot) && slot.subscriber === subscriber && subscriber.active
}
async function deliver(slot: ExecutionSlot, subscriber: Subscriber): Promise<boolean> {
  const current = await checkExecutionAuthority(subscriber.context, slot.binding.scope, slot.binding)
  if (!sameSubscriber(slot, subscriber)) return false
  const value = view(slot, current.deadline)
  let timer: Timer | undefined
  try {
    await Promise.race([Promise.resolve(subscriber.onView(value)), new Promise<never>((resolve, reject) => {
      void resolve
      timer = setTimeout(() => reject(new Error('Execution consumer timed out')), limits.checkTimeoutMs)
    })])
    return true
  }
  catch { return false }
  finally { clearTimeout(timer) }
}
function notifyTerminal(slot: ExecutionSlot): void {
  const subscriber = slot.subscriber
  if (!subscriber?.active) return
  const release = () => {
    if (slot.subscriber === subscriber) slot.subscriber = null
  }
  void deliver(slot, subscriber).then(delivered => { if (!delivered) release() }).catch(release)
}
function pump(slot: ExecutionSlot): void {
  const subscriber = slot.subscriber, event = slot.pendingEvent
  if (!active(slot) || slot.processing || !subscriber?.active || !event || !slot.owner) return
  slot.processing = true
  const generation = slot.generation, owner = slot.owner
  void (async () => {
    const current = await checkExecutionAuthority(owner, slot.binding.scope, slot.binding)
    if (!active(slot) || slot.generation !== generation || !sameSubscriber(slot, subscriber)) return
    slot.binding.authorityUntil = Math.min(slot.binding.authorityUntil, current.deadline)
    slot.phase = 'running'; slot.latestEvent = event
    const delivered = await deliver(slot, subscriber)
    if (!delivered && active(slot) && slot.generation === generation && sameSubscriber(slot, subscriber)) { stop(slot, 'consumer-failed', 'failed'); return }
    if (!active(slot) || slot.generation !== generation || !sameSubscriber(slot, subscriber)) return
    // An asynchronous observer can outlive its pre-delivery authority. Re-enter
    // both captured contexts after it settles, before releasing another credit.
    const ownerCredit = await checkExecutionAuthority(owner, slot.binding.scope, slot.binding)
    const subscriberCredit = await checkExecutionAuthority(subscriber.context, slot.binding.scope, slot.binding)
    if (!active(slot) || slot.generation !== generation || !sameSubscriber(slot, subscriber)) return
    slot.binding.authorityUntil = Math.min(slot.binding.authorityUntil, ownerCredit.deadline, subscriberCredit.deadline)
    if (Date.now() >= deadline(slot)) { stop(slot, 'deadline-expired'); return }
    // Clear parent ownership before granting exactly this actual callback's credit.
    slot.lastSequence = event.sequence; slot.pendingEvent = null; slot.processing = false
    Atomics.store(slot.control, words.credit, event.sequence); Atomics.notify(slot.control, words.credit)
  })().catch(() => {
    if (active(slot) && slot.generation === generation && slot.subscriber === subscriber) stop(slot, 'authority-unavailable')
  }).finally(() => {
    slot.processing = false
    if (active(slot) && slot.pendingEvent && slot.subscriber?.active && slot.subscriber !== subscriber) queueMicrotask(() => pump(slot))
  })
}
async function complete(slot: ExecutionSlot): Promise<void> {
  if (!active(slot) || !slot.candidate || !slot.finishedAck || slot.finalizing || !slot.owner) return
  slot.finalizing = true
  const generation = slot.generation
  try {
    const current = await checkExecutionAuthority(slot.owner, slot.binding.scope, slot.binding)
    if (!active(slot) || slot.generation !== generation || !slot.candidate || !slot.finishedAck) return
    slot.binding.authorityUntil = Math.min(slot.binding.authorityUntil, current.deadline)
    if (Date.now() >= deadline(slot)) { stop(slot, 'deadline-expired'); finishStopped(slot); return }
    clearTimers(slot)
    slot.recording = slot.candidate.recording; slot.completion = slot.candidate.completion; slot.candidate = null
    slot.phase = 'completed'; slot.producer = 'finished'; slot.owner = null; slot.reason = null
    retain(slot); notifyTerminal(slot)
  }
  catch {
    stop(slot, 'authority-unavailable')
    if (slot.finishedAck && slot.phase === 'stopping') finishStopped(slot)
  }
  finally { slot.finalizing = false }
}
function result(slot: ExecutionSlot, message: Extract<ExecutionWorkerMessage, { kind: 'result' }>): void {
  if (!active(slot) || slot.resultSeen || slot.pendingEvent || slot.processing || slot.lastSequence < 1 || Atomics.load(slot.control, words.returned) !== 1) { stop(slot, 'protocol-refused', 'failed'); return }
  slot.resultSeen = true
  try {
    const bytes = new Uint8Array(message.buffer)
    if (executionDigest(bytes) !== message.digest) throw new TypeError('Execution digest mismatch')
    const recording = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Full unchanged canonical validator/replay is deliberately retained in the parent.
    // Native authority is rechecked after this synchronous work and after finished ACK.
    const run = validatePublicSafetyRun(JSON.parse(recording))
    if (publicSafetyRecordingData(run) !== recording || publicSafetyRecordingData(run.plan.config) !== slot.binding.configJson || run.scenario !== slot.scenario || run.seconds !== slot.seconds || run.events.length !== slot.lastSequence || JSON.stringify(run.events.at(-1)) !== JSON.stringify(slot.latestEvent)) throw new TypeError('Execution recording scope mismatch')
    slot.candidate = { recording, completion: { digest: message.digest, byteLength: message.byteLength, eventCount: run.events.length, epochCount: run.epochs.length, captureCount: run.captures.length, virtualTimeMs: run.survey.trace.rows.at(-1)!.observation.nowMs, surveyStatus: run.survey.status, faultDemonstrated: run.faultDemonstrated } }
    void complete(slot)
  }
  catch { stop(slot, 'protocol-refused', 'failed') }
}
function observe(slot: ExecutionSlot, input: unknown): void {
  if (!owned(slot) || slot.producer === 'unconfirmed' || slot.producer === 'finished') return
  try {
    const message = parseExecutionWorkerMessage(input)
    if (message.kind === 'finished') {
      if (slot.phase === 'stopping') { finishStopped(slot); notifyTerminal(slot); return }
      if (message.outcome !== 'completed') { stop(slot, 'producer-failed', 'failed'); finishStopped(slot); notifyTerminal(slot); return }
      if (!slot.resultSeen) { stop(slot, 'protocol-refused', 'failed'); return }
      slot.finishedAck = true; void complete(slot); return
    }
    if (!active(slot)) return
    if (message.kind === 'result') { result(slot, message); return }
    if (slot.resultSeen || slot.pendingEvent || slot.processing || message.event.sequence !== slot.lastSequence + 1 || Atomics.load(slot.control, words.emitted) !== message.event.sequence || Atomics.load(slot.control, words.returned) !== 0 || slot.latestEvent && (message.event.atMs < slot.latestEvent.atMs || message.event.observationCount < slot.latestEvent.observationCount || message.event.captureCount < slot.latestEvent.captureCount)) { stop(slot, 'protocol-refused', 'failed'); return }
    slot.pendingEvent = message.event
    pump(slot)
  }
  catch { stop(slot, 'protocol-refused', 'failed') }
}
function maintain(slot: ExecutionSlot): void {
  slot.wallTimer = setTimeout(() => stop(slot, 'deadline-expired'), Math.max(1, slot.wallDeadline - Date.now()))
  slot.consumerTimer = setTimeout(() => stop(slot, 'consumer-absent'), Math.min(limits.consumerGraceMs, Math.max(1, slot.wallDeadline - Date.now())))
  slot.heartbeatTimer = setInterval(() => {
    if (!active(slot) || !slot.owner || slot.ownerCheckBusy) return
    slot.ownerCheckBusy = true
    void checkExecutionAuthority(slot.owner, slot.binding.scope, slot.binding).then(current => {
      if (!active(slot)) return
      slot.binding.authorityUntil = Math.min(slot.binding.authorityUntil, current.deadline)
      if (Date.now() >= deadline(slot)) stop(slot, 'deadline-expired')
    }).catch(() => stop(slot, 'authority-unavailable')).finally(() => { slot.ownerCheckBusy = false })
  }, limits.heartbeatMs)
}
function locate(context: ExecutionContext, current: ExecutionAuthority, scope: string, execution?: string): ExecutionSlot | null {
  const slot = currentSlot()
  if (!slot || slot.binding.key !== context.key || slot.binding.accountId !== current.binding.accountId || execution !== undefined && slot.execution !== execution) return null
  matchExecutionBinding(slot.binding, current.binding)
  if (scope !== slot.binding.scope) unavailable()
  if (slot.producer === 'finished' && slot.admission !== 'submitting' && Date.now() >= slot.metadataDeadline) { dispose(slot); return null }
  if (active(slot) && Date.now() >= deadline(slot)) stop(slot, 'deadline-expired')
  slot.binding.authorityUntil = Math.min(slot.binding.authorityUntil, current.deadline)
  return slot
}
function locator(input: ExecutionLocator): ExecutionLocator {
  const body = exactRecord(input, ['execution', 'scope'])
  uuid(body.execution); requireExecutionScope(body.scope)
  return { execution: body.execution, scope: body.scope }
}
export async function readIncidentExecution(context: ExecutionContext, input: ExecutionStatusInput): Promise<ExecutionView | null> {
  const body = exactRecord(input, ['scope']); requireExecutionScope(body.scope)
  const current = await checkExecutionAuthority(context, body.scope)
  const slot = locate(context, current, body.scope)
  return slot ? view(slot, current.deadline) : null
}
export async function startIncidentExecution(context: ExecutionContext, input: ExecutionStartInput, workerUrl: URL): Promise<ExecutionView> {
  const body = exactRecord(input, ['intent', 'scope', 'scenario', 'seconds'])
  uuid(body.intent); requireExecutionScope(body.scope)
  if (!publicSafetyScenarios.includes(body.scenario as PublicSafetyScenario) || !Number.isSafeInteger(body.seconds) || (body.seconds as number) < 8 || (body.seconds as number) > 120) throw new PublicSafetyAccessError(422, 'Invalid execution scenario or duration')
  const current = await checkExecutionAuthority(context, body.scope)
  const retained = currentSlot()
  if (retained) {
    const sameOwner = retained.binding.accountId === current.binding.accountId && retained.binding.tokenId === current.binding.tokenId
    throw new PublicSafetyAccessError(sameOwner ? 409 : 429, 'An execution reservation is already retained')
  }
  if (!(workerUrl instanceof URL) || workerUrl.protocol !== 'file:' || workerUrl.host || workerUrl.search || workerUrl.hash || !/\/app\/Workers\/PublicSafetySimulation\.(?:ts|js)$/.test(workerUrl.pathname)) throw new PublicSafetyAccessError(422, 'Invalid owned Worker entrypoint')
  const config = JSON.parse(current.binding.configJson)
  if (config.survey.calibration.evidence !== 'synthetic') throw new PublicSafetyAccessError(422, 'Execution requires synthetic calibration')
  const at = Date.now(), slot: ExecutionSlot = {
    version: 1, execution: randomUUID(), intent: body.intent, binding: current.binding, owner: context,
    scenario: body.scenario as PublicSafetyScenario, seconds: body.seconds as number, startedAt: at,
    wallDeadline: Math.min(current.deadline, at + limits.runWallMs), metadataDeadline: current.deadline,
    phase: 'waiting-for-consumer', reason: null, producer: 'pending', admission: 'unsubmitted',
    latestEvent: null, completion: null, recording: null, worker: null,
    control: new Int32Array(new SharedArrayBuffer(words.length * 4)), pendingEvent: null, lastSequence: 0,
    stopTarget: 'canceled', generation: 1, ownerCheckBusy: false, subscriber: null, processing: false, resultSeen: false, candidate: null, finishedAck: false, finalizing: false,
  }
  executionOwner().slot = slot
  try {
    const worker = slot.worker = new Worker(new URL(workerUrl.href).href, { env: {}, preload: [] })
    worker.onmessage = event => observe(slot, event.data)
    worker.onerror = () => stop(slot, 'producer-failed', 'failed')
    maintain(slot)
    worker.postMessage({ version: 1, config, scenario: slot.scenario, seconds: slot.seconds, control: slot.control.buffer, creditWaitMs: limits.creditWaitMs })
    const release = await checkExecutionAuthority(context, slot.binding.scope, slot.binding)
    return view(slot, release.deadline)
  }
  catch (error) {
    if (slot.worker) stop(slot, 'producer-failed', 'failed')
    else { slot.producer = 'finished'; dispose(slot) }
    throw error
  }
}
export async function closeIncidentExecution(context: ExecutionContext, input: ExecutionLocator): Promise<ExecutionView> {
  const body = locator(input), current = await checkExecutionAuthority(context, body.scope)
  const slot = locate(context, current, body.scope, body.execution) ?? unavailable()
  if (slot.admission === 'submitting') throw new PublicSafetyAccessError(409, 'Source admission is in progress')
  if (active(slot)) { stop(slot, 'stopped-by-owner'); return view(slot, current.deadline) }
  if (slot.producer !== 'finished') return view(slot, current.deadline)
  slot.phase = 'discarded'; slot.reason = 'discarded-by-owner'; slot.latestEvent = null; slot.completion = null; slot.recording = null
  const result = view(slot, current.deadline)
  dispose(slot)
  return result
}

/** Reserve one observer without granting any credit until the native adapter is ready. */
export async function attachIncidentExecution(context: ExecutionContext, input: ExecutionLocator, onView: (value: ExecutionView) => void | Promise<void>): Promise<ExecutionAttachment> {
  const body = locator(input), current = await checkExecutionAuthority(context, body.scope)
  const slot = locate(context, current, body.scope, body.execution) ?? unavailable()
  if (typeof onView !== 'function') throw new PublicSafetyAccessError(422, 'Invalid execution observer')
  if (slot.subscriber) throw new PublicSafetyAccessError(409, 'An execution observer is already attached')
  const subscriber: Subscriber = { id: randomUUID(), context, onView, active: false }
  slot.subscriber = subscriber
  let released = false
  const check = async () => {
    if (released || !owned(slot) || slot.subscriber !== subscriber) unavailable()
    const current = await checkExecutionAuthority(context, slot.binding.scope, slot.binding)
    if (released || !owned(slot) || slot.subscriber !== subscriber) unavailable()
    const located = locate(context, current, body.scope, body.execution) ?? unavailable()
    return view(located, current.deadline)
  }
  const release = () => {
    if (released) return
    released = true; subscriber.active = false
    if (!owned(slot) || slot.subscriber !== subscriber) return
    slot.subscriber = null
    if (active(slot)) {
      clearTimeout(slot.consumerTimer)
      slot.consumerTimer = setTimeout(() => stop(slot, 'consumer-absent'), Math.min(limits.consumerGraceMs, Math.max(1, deadline(slot) - Date.now())))
    }
  }
  return {
    initial: view(slot, current.deadline), check, release,
    activate: async () => {
      await check()
      if (released || slot.subscriber !== subscriber) unavailable()
      if (subscriber.active) return
      subscriber.active = true
      clearTimeout(slot.consumerTimer)
      if (active(slot)) pump(slot)
      else await deliver(slot, subscriber)
    },
  }
}

/** Deliberate single-flight admission through the existing sole native writer. */
export async function admitIncidentExecution(context: ExecutionContext, input: ExecutionAdmissionInput): Promise<SourceRegistration> {
  const body = exactRecord(input, ['execution', 'scope', 'digest', 'expectedVersion'])
  uuid(body.execution); requireExecutionScope(body.scope)
  if (typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest)) throw new PublicSafetyAccessError(422, 'Invalid execution digest')
  const expected = expectedVersion(body.expectedVersion), current = await checkExecutionAuthority(context, body.scope)
  const slot = locate(context, current, body.scope, body.execution) ?? unavailable()
  if (slot.phase !== 'completed' || slot.producer !== 'finished' || !slot.recording || !slot.completion || slot.completion.digest !== body.digest || slot.admission !== 'unsubmitted') throw new PublicSafetyAccessError(409, 'Execution result is not available for admission')
  const generation = slot.generation, resultDeadline = Math.min(slot.metadataDeadline, slot.binding.authorityUntil), recording = slot.recording
  if (Date.now() >= resultDeadline) unavailable()
  slot.admission = 'submitting'
  let guardAccepted = false
  try {
    const registered = await context.run(() => registerPublicSafetySourceChecked(context.key, { expectedVersion: expected, recording: JSON.parse(recording) }, async (tx, access) => {
      if (!owned(slot) || slot.generation !== generation || slot.phase !== 'completed' || slot.admission !== 'submitting' || Date.now() >= resultDeadline) unavailable()
      const actual = await executionAccess(tx, context.key, slot.binding.scope, slot.binding)
      if (access.incident.id !== actual.binding.incidentId || access.principal.userId !== actual.binding.accountId || access.principal.tokenId !== actual.binding.tokenId || access.member.id !== actual.binding.memberId || access.member.version !== actual.binding.memberVersion || access.member.role !== actual.binding.role || access.incident.config_json !== actual.binding.configJson) throw new PublicSafetyAccessError(409, 'Original execution authority has changed')
      if (!owned(slot) || slot.generation !== generation || slot.admission !== 'submitting' || Date.now() >= resultDeadline) unavailable()
      guardAccepted = true
      return Math.min(resultDeadline, actual.deadline)
    }))
    // Recheck after actual COMMIT as well. A failure here cannot undo its write.
    await checkExecutionAuthority(context, slot.binding.scope, slot.binding)
    assertIncidentDeadline(registered)
    slot.admission = 'confirmed'; slot.recording = null
    return registered
  }
  catch (error) {
    // Before the sole-writer guard accepted, no source write was reachable.
    // Afterwards even a lost/withheld response can follow durable COMMIT.
    slot.admission = guardAccepted ? 'unknown' : 'unsubmitted'
    if (guardAccepted) slot.reason = 'admission-outcome-unknown'
    throw error
  }
  finally {
    if (Date.now() >= slot.metadataDeadline) dispose(slot)
    else notifyTerminal(slot)
  }
}
