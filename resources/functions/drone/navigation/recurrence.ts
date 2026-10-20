import { parse } from '@stacksjs/cron'

type SlotState = 'awaiting-review' | 'approved' | 'denied' | 'missed'
interface Tuple { scheduleId: string, revision: number, dueUtcMs: number }
interface Binding { vehicleId: 'navigation-vehicle', padId: 'pad', planId: 'local-survey-demo', profile: 'nominal-contact-partial-charge-v1', sessionId: string, bootId: string, reference: string, origin: string }
interface Review { reviewId: string, decision: 'approve' | 'deny', reviewedAtMonoMs: number, deadlineMonoMs: number, binding: Binding, consumed: true }
interface Slot { tuple: Tuple, dueMonoMs: number, reviewDeadlineMonoMs: number, state: SlotState, reason: string, review: Review | null }
interface Transition { atMonoMs: number, tuple: Tuple | null, from: SlotState | null, to: SlotState | 'latched', reason: string }
interface Observation { utcMs: number, monoMs: number, busy: boolean }
interface Ledger {
  owner: { scheduleId: string, revision: number }, profile: 'minute-zero-one-v1', anchorUtcMs: number, anchorMonoMs: 0,
  selectedUtcMs: number[], cursorUtcMs: number, parserCalls: number, lastGood: { utcMs: number, monoMs: number }, lastScanMonoMs: number,
  latch: string | null, records: Slot[], transitions: Transition[],
  summary: { reason: string, atMonoMs: number, fromUtcMs: number, toUtcMs: number, affectedSelected: number, uncomputedOutsideSelection: true } | null,
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value)
const date = (value: number) => Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000
/** Untrusted inputs are materialized once, before inspecting owned state. */
function data(input: unknown, fields: string[]) {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Invalid recurrence object')
    const d = Object.getOwnPropertyDescriptors(input)
    if (Reflect.ownKeys(d).length !== fields.length || fields.some(k => !d[k]?.enumerable || !('value' in d[k]!))) throw new TypeError('Invalid recurrence fields')
    return Object.fromEntries(fields.map(k => [k, d[k]!.value]))
  }
  catch { throw new TypeError('Invalid recurrence inspection') }
}
function observation(input: unknown): Observation {
  const v = data(input, ['utcMs', 'monoMs', 'busy'])
  if (typeof v.utcMs !== 'number' || typeof v.monoMs !== 'number' || typeof v.busy !== 'boolean') throw new TypeError('Invalid recurrence observation')
  return { utcMs: v.utcMs, monoMs: v.monoMs, busy: v.busy }
}
function normalizeBinding(input: unknown): Binding {
  const v = data(input, ['vehicleId', 'padId', 'planId', 'profile', 'sessionId', 'bootId', 'reference', 'origin'])
  const decimal = (n: unknown) => typeof n === 'string' && /^[1-9][0-9]{0,19}$/.test(n) && BigInt(n) <= 18446744073709551615n
  if (v.vehicleId !== 'navigation-vehicle' || v.padId !== 'pad' || v.planId !== 'local-survey-demo' || v.profile !== 'nominal-contact-partial-charge-v1' || !decimal(v.sessionId) || !decimal(v.bootId) || typeof v.reference !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(v.reference) || typeof v.origin !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(v.origin)) throw new TypeError('Invalid recurrence binding')
  return { vehicleId: v.vehicleId, padId: v.padId, planId: v.planId, profile: v.profile, sessionId: v.sessionId, bootId: v.bootId, reference: v.reference, origin: v.origin }
}
interface DecisionResult { outcome: 'approved' | 'denied' | 'refused', reason: string, tuple: Tuple | null, review: Review | null, handoff: { occurrenceId: 'patrol-slot-zero' | 'patrol-slot-one', issuedAtMs: number, binding: Binding } | null }
/** Finite unsigned review ledger. It has no vehicle, scheduler, callback or output handle. */
export function createPatrolRecurrence(input: unknown) {
  const v = data(input, ['scheduleId', 'revision', 'profile', 'anchorUtcMs', 'anchorMonoMs'])
  if (!id(v.scheduleId) || !Number.isInteger(v.revision) || v.revision < 1 || v.revision > 2147483647 || v.profile !== 'minute-zero-one-v1' || typeof v.anchorUtcMs !== 'number' || !date(v.anchorUtcMs) || v.anchorUtcMs % 60000 !== 0 || !date(v.anchorUtcMs - 1) || !date(v.anchorUtcMs + 180000) || v.anchorMonoMs !== 0) throw new TypeError('Invalid recurrence configuration')
  const selectedUtcMs: number[] = []
  let cursorUtcMs = v.anchorUtcMs - 1
  for (let index = 0; index < 3; index++) {
    const slot = parse('* * * * *', cursorUtcMs, { tz: 'UTC' })
    const expected = v.anchorUtcMs + index * 60000
    if (!slot || slot.getTime() !== expected || !date(slot.getTime()) || slot.getTime() <= cursorUtcMs) throw new TypeError('ledger-parser-unqualified')
    cursorUtcMs = slot.getTime()
    if (index < 2) selectedUtcMs.push(cursorUtcMs)
  }
  let state: Ledger = { owner: { scheduleId: v.scheduleId, revision: v.revision }, profile: v.profile, anchorUtcMs: v.anchorUtcMs, anchorMonoMs: 0, selectedUtcMs, cursorUtcMs, parserCalls: 3, lastGood: { utcMs: v.anchorUtcMs, monoMs: 0 }, lastScanMonoMs: 0, latch: null, records: [], transitions: [], summary: null }
  let operating = false, aborted = false
  function guard<T>(work: () => T): T {
    if (operating) { aborted = true
    throw new TypeError('Reentrant recurrence operation') }
    operating = true
    aborted = false
    try { return work() }
    finally { operating = false }
  }
  function inspected() { if (aborted) throw new TypeError('Aborted recurrence inspection') }
  function publish(next: Ledger) { inspected()
  state = next }
  function tuple(s: Ledger, dueUtcMs: number): Tuple { return { ...s.owner, dueUtcMs } }
  function event(s: Ledger, slot: Slot | null, from: SlotState | null, to: SlotState | 'latched', reason: string) {
    if (s.transitions.length >= 8) {
      s.latch = 'ledger-capacity'
      s.summary ??= { reason: s.latch, atMonoMs: s.lastGood.monoMs, fromUtcMs: s.anchorUtcMs + s.lastScanMonoMs, toUtcMs: s.lastGood.utcMs, affectedSelected: 0, uncomputedOutsideSelection: true }
      return false
    }
    s.transitions.push({ atMonoMs: s.lastGood.monoMs, tuple: slot?.tuple ?? null, from, to, reason })
    return true
  }
  function finish(s: Ledger, slot: Slot, reason: string) {
    if (event(s, slot, slot.state, 'missed', reason)) { slot.state = 'missed'
    slot.reason = reason }
  }
  function fail(s: Ledger, reason: string, affected = 0) {
    if (s.latch) return
    s.latch = reason
    for (const slot of s.records) {
      if (slot.state === 'awaiting-review') { finish(s, slot, reason === 'ledger-scan-gap' ? 'missed-gap' : 'missed-clock')
      affected++ }
    }
    event(s, null, null, 'latched', reason)
    s.summary ??= { reason, atMonoMs: s.lastGood.monoMs, fromUtcMs: s.anchorUtcMs + s.lastScanMonoMs, toUtcMs: s.lastGood.utcMs, affectedSelected: affected, uncomputedOutsideSelection: true }
  }
  function clock(s: Ledger, o: Observation) {
    if (!date(o.utcMs) || !Number.isSafeInteger(o.monoMs) || o.monoMs < 0 || o.monoMs > 180000 || o.utcMs !== s.anchorUtcMs + o.monoMs || o.monoMs < s.lastGood.monoMs || o.utcMs < s.lastGood.utcMs) { fail(s, 'ledger-clock-unqualified')
    return false }
    s.lastGood = { utcMs: o.utcMs, monoMs: o.monoMs }
    return true
  }
  function add(s: Ledger, dueUtcMs: number, reason: string) {
    if (s.records.length >= 2) { fail(s, 'ledger-capacity')
    return }
    const dueMonoMs = dueUtcMs - s.anchorUtcMs
    const slot: Slot = { tuple: tuple(s, dueUtcMs), dueMonoMs, reviewDeadlineMonoMs: dueMonoMs + 5000, state: reason === 'due-awaiting-review' ? 'awaiting-review' : 'missed', reason, review: null }
    if (event(s, slot, null, slot.state, reason)) s.records.push(slot)
  }
  return {
    snapshot() { return guard(() => structuredClone(state)) },
    review(input: unknown, context: unknown): DecisionResult {
      return guard(() => {
        const refused = (reason: string, dueUtcMs?: number): DecisionResult => ({ outcome: 'refused', reason, tuple: dueUtcMs !== undefined && state.selectedUtcMs.includes(dueUtcMs) ? tuple(state, dueUtcMs) : null, review: null, handoff: null })
        if (state.latch) return refused(state.latch)
        const request = data(input, ['dueUtcMs', 'reviewId', 'decision'])
        if (typeof request.dueUtcMs !== 'number' || !date(request.dueUtcMs) || !id(request.reviewId) || !['approve', 'deny'].includes(request.decision)) throw new TypeError('Invalid recurrence review')
        const c = data(context, ['utcMs', 'monoMs', 'busy', 'binding'])
        const binding = normalizeBinding(c.binding)
        const o = observation({ utcMs: c.utcMs, monoMs: c.monoMs, busy: c.busy })
        inspected()
        const dueUtcMs = request.dueUtcMs
        if (!state.selectedUtcMs.includes(dueUtcMs)) return refused('unknown-tuple')
        const current = state.records.find(r => r.tuple.dueUtcMs === dueUtcMs)
        if (!current) return refused(state.lastGood.utcMs < dueUtcMs ? 'not-due' : 'not-materialized', dueUtcMs)
        if (current.state !== 'awaiting-review') return refused('review-consumed', dueUtcMs)
        if (state.records.some(r => r.review?.reviewId === request.reviewId)) return refused('review-id-consumed', dueUtcMs)
        const next = structuredClone(state), slot = next.records.find(r => r.tuple.dueUtcMs === dueUtcMs)!
        if (!clock(next, o)) { publish(next)
        return refused(next.latch!, dueUtcMs) }
        const own: Review = { reviewId: request.reviewId, decision: request.decision, reviewedAtMonoMs: o.monoMs, deadlineMonoMs: slot.reviewDeadlineMonoMs, binding, consumed: true }
        const expired = o.monoMs >= slot.reviewDeadlineMonoMs
        const target: SlotState = expired || o.busy ? 'missed' : own.decision === 'deny' ? 'denied' : 'approved'
        const reason = expired ? 'missed-review-window' : o.busy ? 'missed-busy' : own.decision === 'deny' ? 'operator-denied' : 'local-review-approved'
        if (!event(next, slot, slot.state, target, reason)) { publish(next)
        return refused('ledger-capacity', dueUtcMs) }
        slot.state = target
        slot.reason = reason
        slot.review = own
        publish(next)
        return structuredClone({ outcome: target === 'approved' ? 'approved' : target === 'denied' ? 'denied' : 'refused', reason, tuple: slot.tuple, review: own, handoff: target === 'approved' ? { occurrenceId: dueUtcMs === state.selectedUtcMs[0] ? 'patrol-slot-zero' : 'patrol-slot-one', issuedAtMs: o.monoMs, binding } : null }) as DecisionResult
      })
    },
    scan(input: unknown) {
      return guard(() => {
        if (state.latch) return structuredClone(state)
        const o = observation(input)
        inspected()
        const next = structuredClone(state)
        if (clock(next, o)) {
          if (o.monoMs - next.lastScanMonoMs > 60000) {
            let affected = 0
            for (const due of next.selectedUtcMs) if (due <= o.utcMs && !next.records.some(r => r.tuple.dueUtcMs === due)) { add(next, due, 'missed-gap')
            affected++ }
            fail(next, 'ledger-scan-gap', affected)
          }
          else {
            for (const slot of next.records) if (slot.state === 'awaiting-review' && o.monoMs >= slot.reviewDeadlineMonoMs) finish(next, slot, 'missed-review-window')
            for (const due of next.selectedUtcMs) {
              if (due > o.utcMs || next.records.some(r => r.tuple.dueUtcMs === due)) continue
              const age = o.utcMs - due
              add(next, due, age > 30000 ? 'missed-lookback' : age >= 5000 ? 'missed-review-window' : o.busy ? 'missed-busy' : 'due-awaiting-review')
            }
            next.lastScanMonoMs = o.monoMs
          }
        }
        publish(next)
        return structuredClone(state)
      })
    },
  }
}
