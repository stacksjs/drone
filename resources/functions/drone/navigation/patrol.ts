import { createNavigationOccurrenceSession } from './runtime'
import { createPatrolRecurrence } from './recurrence'

const anchorUtcMs = 1767225600000
const horizonMs = 180000
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v)
type Decision = { kind: 'flight', id: string, atMs: number, dueUtcMs: number, decision: 'approve' | 'deny' } | { kind: 'charge', id: string, atMs: number, occurrenceId: 'patrol-slot-zero' | 'patrol-slot-one', decision: 'approve' | 'deny' }
type Snapshot = ReturnType<ReturnType<typeof createNavigationOccurrenceSession>['snapshot']>
interface Outcome { id: string, kind: Decision['kind'], atMs: number, decision: 'approve' | 'deny', tuple: { scheduleId: string, revision: number, dueUtcMs: number } | null, occurrenceId: string | null, reviewOutcome: 'not-called' | 'approved' | 'denied' | 'refused', requestOutcome: 'not-called' | 'queued' | 'refused', reason: string, fulfilled: boolean, fulfillmentReason: string }
function inspect(input: unknown) {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Invalid patrol object')
  return Object.getOwnPropertyDescriptors(input)
}
function fields(d: PropertyDescriptorMap, keys: string[]) {
  if (Reflect.ownKeys(d).length !== keys.length || keys.some(k => !d[k]?.enumerable || !('value' in d[k]!))) throw new TypeError('Invalid patrol fields')
  return Object.fromEntries(keys.map(k => [k, d[k]!.value]))
}
/** Normalize the complete unknown input before creating any owned world or review ledger. */
export function normalizePatrolInput(input: unknown) {
  try {
    const d = inspect(input)
    const allowed = ['profile', 'unsignedLocalReview', 'enableCharge', 'decisions']
    if (Reflect.ownKeys(d).some(k => typeof k !== 'string' || !allowed.includes(k) || !d[k]?.enumerable || !('value' in d[k]!))) throw new TypeError('Invalid patrol options')
    const profile = d.profile ? d.profile.value : 'nominal'
    const unsignedLocalReview = d.unsignedLocalReview ? d.unsignedLocalReview.value : false
    const enableCharge = d.enableCharge ? d.enableCharge.value : false
    const original = d.decisions ? d.decisions.value : []
    if (profile !== 'nominal' || typeof unsignedLocalReview !== 'boolean' || typeof enableCharge !== 'boolean' || enableCharge && !unsignedLocalReview || !Array.isArray(original) || Object.getPrototypeOf(original) !== Array.prototype) throw new TypeError('Invalid patrol options')
    const array = Object.getOwnPropertyDescriptors<object>(original), length = array.length
    if (!length || !('value' in length) || length.enumerable || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 4 || Reflect.ownKeys(array).length !== length.value + 1) throw new TypeError('Invalid patrol decision list')
    const decisions: Decision[] = [], ids = new Set<string>(), tuples = new Set<number>()
    let flights = 0, charges = 0, previousAtMs = -1
    for (let n = 0; n < length.value; n++) {
      const entry = array[String(n)]
      if (!entry?.enumerable || !('value' in entry)) throw new TypeError('Invalid patrol decision index')
      const descriptors = inspect(entry.value), kind = descriptors.kind?.value
      if (kind !== 'flight' && kind !== 'charge') throw new TypeError('Invalid patrol decision kind')
      const v = fields(descriptors, ['kind', 'id', 'atMs', kind === 'flight' ? 'dueUtcMs' : 'occurrenceId', 'decision'])
      if (!id(v.id) || ids.has(v.id) || !Number.isSafeInteger(v.atMs) || v.atMs < 0 || v.atMs > horizonMs || v.atMs % 4 !== 0 || v.atMs < previousAtMs || !['approve', 'deny'].includes(v.decision)) throw new TypeError('Invalid patrol decision')
      ids.add(v.id)
      previousAtMs = v.atMs
      if (kind === 'flight') {
        if (![anchorUtcMs, anchorUtcMs + 60000].includes(v.dueUtcMs) || tuples.has(v.dueUtcMs) || ++flights > 2) throw new TypeError('Invalid patrol flight tuple')
        tuples.add(v.dueUtcMs)
        decisions.push(Object.freeze({ kind, id: v.id, atMs: v.atMs, dueUtcMs: v.dueUtcMs, decision: v.decision }))
      }
      else {
        if (!['patrol-slot-zero', 'patrol-slot-one'].includes(v.occurrenceId) || ++charges > 2 || !enableCharge) throw new TypeError('Invalid patrol charge decision')
        decisions.push(Object.freeze({ kind, id: v.id, atMs: v.atMs, occurrenceId: v.occurrenceId, decision: v.decision }))
      }
    }
    if (decisions.length && !unsignedLocalReview) throw new TypeError('Unsigned local review opt-in required')
    return Object.freeze({ profile: 'nominal' as const, unsignedLocalReview, enableCharge, decisions: Object.freeze(decisions) })
  }
  catch { throw new TypeError('Invalid patrol input') }
}
function busy(s: Snapshot) { return s.occurrences.some(o => o.state === 'queued' || o.state === 'running') || s.charge!.episodes.some(e => e.state === 'queued') || ['pending', 'verified', 'isolating'].includes(s.charge!.phase) }
function flightBinding(s: Snapshot) {
  const e = s.estimate, p = e.localPosition, a = s.authority
  const resets = [e.resets.attitude, e.resets.position, e.resets.boot, e.resets.manual, e.resets.clock]
  const uint64 = (v: bigint | null) => typeof v === 'bigint' && v > 0n && v <= 18446744073709551615n
  if (!s.hostAvailable || s.hostDataStale || s.lastHostAtMs !== s.nowMs || e.nowMs !== s.nowMs || a.lastCheckedAtMs !== s.nowMs || !uint64(a.sessionId) || !uint64(e.bootId) || resets.some(n => !Number.isSafeInteger(n) || n < 0) || !p || !p.origin || ![p.origin.latitudeDeg, p.origin.longitudeDeg, p.origin.ellipsoidHeightM].every(Number.isFinite)) return null
  return { vehicleId: 'navigation-vehicle', padId: 'pad', planId: 'local-survey-demo', profile: 'nominal-contact-partial-charge-v1', sessionId: String(a.sessionId), bootId: String(e.bootId), reference: `${e.bootId}:${resets.join(',')}`, origin: JSON.stringify({ latitudeDeg: p.origin.latitudeDeg, longitudeDeg: p.origin.longitudeDeg, ellipsoidHeightM: p.origin.ellipsoidHeightM }) }
}
const decimal = (value: bigint | null) => value === null ? null : String(value)
/** Finite model only. Native scans create review metadata, never automatic authority. */
export function simulatePatrol(input: unknown = {}) {
  const options = normalizePatrolInput(input)
  const session = createNavigationOccurrenceSession({ contact: 'nominal', charge: 'nominal' })
  const ledger = createPatrolRecurrence({ scheduleId: 'patrol-demo', revision: 1, profile: 'minute-zero-one-v1', anchorUtcMs, anchorMonoMs: 0 })
  const decisions: Outcome[] = []
  const calls = { flightReviewCalls: 0, flightRequests: 0, chargeRequests: 0 }
  const scanTimes = [0, 60000, 120000, horizonMs]
  const epochs = [...new Set([...scanTimes, ...options.decisions.map(d => d.atMs)])].sort((a, b) => a - b)
  let decisionIndex = 0
  for (const atMs of epochs) {
    const snapshot = session.advanceTo(atMs)
    if (scanTimes.includes(atMs)) ledger.scan({ utcMs: anchorUtcMs + atMs, monoMs: atMs, busy: busy(snapshot) })
    while (options.decisions[decisionIndex]?.atMs === atMs) {
      const d = options.decisions[decisionIndex++]!, current = session.snapshot()
      const row: Outcome = { id: d.id, kind: d.kind, atMs: d.atMs, decision: d.decision, tuple: null, occurrenceId: null, reviewOutcome: 'not-called', requestOutcome: 'not-called', reason: 'patrol-binding-unavailable', fulfilled: false, fulfillmentReason: 'patrol-binding-unavailable' }
      decisions.push(row)
      if (d.kind === 'flight') {
        row.tuple = { scheduleId: 'patrol-demo', revision: 1, dueUtcMs: d.dueUtcMs }
        const binding = flightBinding(current)
        if (!binding) continue
        calls.flightReviewCalls++
        const reviewed = ledger.review({ dueUtcMs: d.dueUtcMs, reviewId: d.id, decision: d.decision }, { utcMs: anchorUtcMs + atMs, monoMs: atMs, busy: busy(current), binding })
        row.reviewOutcome = reviewed.outcome
        row.reason = reviewed.reason
        row.fulfillmentReason = reviewed.reason
        if (reviewed.outcome === 'denied' && reviewed.reason === 'operator-denied') {
          row.fulfilled = true
          row.fulfillmentReason = 'operator-denial-recorded'
        }
        if (reviewed.outcome === 'approved' && reviewed.handoff) {
          row.occurrenceId = reviewed.handoff.occurrenceId
          calls.flightRequests++
          const request = session.requestOccurrence({ id: reviewed.handoff.occurrenceId, issuedAtMs: reviewed.handoff.issuedAtMs, decision: 'approve' })
          row.requestOutcome = request.state
          row.reason = request.reason
          row.fulfillmentReason = request.reason
        }
      }
      else {
        row.occurrenceId = d.occurrenceId
        calls.chargeRequests++
        const request = session.requestCharge!({ id: d.id, occurrenceId: d.occurrenceId, issuedAtMs: current.nowMs, decision: d.decision })
        row.requestOutcome = request.state
        row.reason = request.reason
        row.fulfillmentReason = request.reason
        if (d.decision === 'deny' && request.state === 'refused' && request.reason === 'charge-operator-denied') {
          row.fulfilled = true
          row.fulfillmentReason = 'operator-denial-recorded'
        }
      }
    }
  }
  const s = session.snapshot(), l = ledger.snapshot(), c = s.charge!
  const live = s.occurrences.filter(o => o.state === 'running')
  if (live.length > 1 || live.some(o => o.startedAtMs === null || o.result !== null)) throw new RangeError('patrol-summary-unqualified')
  const missionRows = s.occurrences.reduce((sum, o) => sum + (o.result?.trace.rows.length ?? 0), 0) + (live.length ? s.trace.rows.length : 0)
  const counts = { ...calls, armsAccepted: s.counts.armAccepted, engagesAccepted: s.counts.engageAccepted, chargeFramesAccepted: c.host.acceptedFrames, missionRows, contactRows: s.contact!.verification?.totalRows ?? 0, chargeRows: c.host.rows.length }
  if (missionRows > 9001 || counts.contactRows > 512 || counts.chargeRows > 512) throw new RangeError('patrol-summary-unqualified')
  for (const d of decisions) {
    if (d.kind === 'flight' && d.decision === 'approve' && d.requestOutcome === 'queued') {
      const flight = s.occurrences.find(o => o.id === d.occurrenceId)
      const contact = s.contact!.outcomes.find(o => o.occurrenceId === d.occurrenceId)
      if (flight?.state !== 'completed') d.fulfillmentReason = flight && ['refused', 'blocked', 'aborted'].includes(flight.state) ? flight.reason : 'patrol-flight-incomplete'
      else if (contact?.phase !== 'verified' || contact.verifiedAtMs === null) d.fulfillmentReason = 'patrol-flight-contact-unverified'
      else {
        d.fulfilled = true
        d.fulfillmentReason = 'completed-contact-verified'
      }
    }
    if (d.kind === 'charge' && d.decision === 'approve' && d.requestOutcome === 'queued') {
      const episode = c.episodes.find(e => e.id === d.id)
      if (episode && ['refused', 'recovery-required'].includes(episode.state)) d.fulfillmentReason = episode.reason
      else if (!episode || episode.verifiedAtMs === null) d.fulfillmentReason = 'patrol-charge-unverified'
      else if (episode.isolatedAtMs === null || episode.state !== 'isolated') d.fulfillmentReason = 'patrol-charge-unisolated'
      else {
        d.fulfilled = true
        d.fulfillmentReason = 'verified-isolated'
      }
    }
  }
  const finalFault = l.latch || (!s.hostAvailable ? 'patrol-host-unavailable' : s.board.fault ? 'patrol-flight-output-fault' : s.board.motorsN.some(n => n !== 0) ? 'patrol-flight-output-nonneutral' : c.output.fault ? 'patrol-charge-output-fault' : c.output.values.some(n => n !== 0) ? 'patrol-charge-output-nonneutral' : c.latch ? 'patrol-charge-recovery-required' : null)
  const reasons = [...new Set([...decisions.filter(d => !d.fulfilled).map(d => d.fulfillmentReason), ...(finalFault ? [finalFault] : [])])]
  if (reasons.length > 8 || reasons.some(r => !/^[\x20-\x7e]{1,96}$/.test(r))) throw new RangeError('patrol-summary-unqualified')
  const result = {
    version: 1 as const, evidence: 'owned-patrol-simulation' as const, profile: options.profile, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, identityAuthenticated: false as const, anchorUtcMs, horizonMs,
    status: (reasons.length ? 'failed' : !decisions.length ? 'neutral-preview' : decisions.every(d => d.decision === 'deny') ? 'reviewed-denials' : 'completed') as 'failed' | 'neutral-preview' | 'reviewed-denials' | 'completed', reasons, decisions,
    recurrence: { scheduleId: l.owner.scheduleId, revision: l.owner.revision, profile: l.profile, slots: l.records.map(r => ({ dueUtcMs: r.tuple.dueUtcMs, reviewDeadlineMs: r.reviewDeadlineMonoMs, state: r.state, reason: r.reason, reviewId: r.review?.reviewId ?? null, reviewedAtMs: r.review?.reviewedAtMonoMs ?? null, reviewConsumed: r.review?.consumed ?? false })), latch: l.latch, summary: l.summary },
    flights: s.occurrences.map(o => ({ id: o.id, state: o.state, reason: o.reason, requestedAtMs: o.requestedAtMs, attemptedAtMs: o.attemptedAtMs, startedAtMs: o.startedAtMs, terminalAtMs: o.terminalAtMs, contactVerifiedAtMs: s.contact!.outcomes.find(v => v.occurrenceId === o.id)?.verifiedAtMs ?? null })),
    charge: { phase: c.phase, reason: c.reason, latch: c.latch, episodes: c.episodes.map(e => ({ id: e.id, occurrenceId: e.occurrenceId, state: e.state, reason: e.reason, requestedAtMs: e.requestedAtMs, attemptedAtMs: e.attemptedAtMs, startedAtMs: e.startedAtMs, verifiedAtMs: e.verifiedAtMs, isolatedAtMs: e.isolatedAtMs, creditWh: e.creditWh })), offRequestedAtMs: c.host.offRequestedAtMs, independentOffObservedAtMs: c.independent.offObservedAtMs, hostOffObservedAtMs: c.host.offObservedAtMs, electricalIsolation: c.host.electricalIsolation, currentEligibility: c.currentEligibility,
      output: { values: c.output.values, fault: c.output.fault, sequence: c.output.sequence, epoch: c.output.epoch, expiresAtMs: c.output.expiresAtMs, lastCheckedAtMs: c.output.lastCheckedAtMs, bootId: String(c.output.bootId) }, relay: { closed: c.plant.relayClosed, currentA: c.plant.currentA, nodeV: c.plant.nodeV, batteryV: c.plant.batteryV } },
    energy: { availableWh: s.energy.availableWh!, usedWh: s.energy.usedWh, remainingWh: s.energy.remainingWh, truePackWh: c.plant.storedWh, trueGrossGainWh: c.plant.grossGainWh, verifiedCreditWh: c.host.verifiedCreditWh, model: 'nominal-hover-load-while-powered' as const, idleLoadMeasured: false as const },
    host: { available: s.hostAvailable, stale: s.hostDataStale, lastObservedAtMs: s.lastHostAtMs, sessionId: decimal(s.authority.sessionId), flightBootId: decimal(s.board.bootId), estimatorBootId: decimal(s.estimate.bootId), chargerBootId: decimal(c.output.bootId), reference: s.estimate.bootId === null ? null : `${s.estimate.bootId}:${[s.estimate.resets.attitude, s.estimate.resets.position, s.estimate.resets.boot, s.estimate.resets.manual, s.estimate.resets.clock].join(',')}` }, counts,
  }
  const text = JSON.stringify(result, (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('patrol-summary-unqualified')
    if (['reason', 'fulfillmentReason', 'fault', 'latch'].includes(key) && value !== null && (typeof value !== 'string' || !/^[\x20-\x7e]{1,96}$/.test(value))) throw new RangeError('patrol-summary-unqualified')
    return value
  })
  if (Buffer.byteLength(`${text}\n`, 'utf8') > 16384) throw new RangeError('patrol-summary-size')
  return result
}

export type PatrolInput = ReturnType<typeof normalizePatrolInput>
export type PatrolSummary = ReturnType<typeof simulatePatrol>
