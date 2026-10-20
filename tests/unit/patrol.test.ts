import { expect, test } from 'bun:test'
import { simulatePatrol } from '../../resources/functions/drone/navigation/patrol'

test('default patrol is a neutral finite preview with due metadata but no flight or charge request', () => {
  const result = simulatePatrol()
  expect(result.status).toBe('neutral-preview')
  expect(result.reasons).toEqual([])
  expect(result.horizonMs).toBe(180000)
  expect(result.decisions).toEqual([])
  expect(result.counts.flightReviewCalls).toBe(0)
  expect(result.counts.flightRequests).toBe(0)
  expect(result.counts.chargeRequests).toBe(0)
  expect(result.counts.armsAccepted).toBe(0)
  expect(result.counts.engagesAccepted).toBe(0)
  expect(result.counts.chargeFramesAccepted).toBe(0)
  expect(result.counts.missionRows).toBe(0)
  expect(result.counts.contactRows).toBe(0)
  expect(result.flights).toEqual([])
  expect(result.charge.episodes).toEqual([])
  expect(result.charge.output.values).toEqual([0])
  expect(result.charge.relay.closed).toBe(false)
  expect(result.energy.usedWh).toBe(0)
  expect(result.energy.trueGrossGainWh).toBe(0)
  expect(result.recurrence.slots.map(s => s.state)).toEqual(['missed', 'missed'])
  expect(result.physicalFlightEnabled).toBe(false)
  expect(result.identityAuthenticated).toBe(false)
  expect(Object.keys(result)).toEqual(['version', 'evidence', 'profile', 'physicalFlightEnabled', 'boardOutputsInhibited', 'identityAuthenticated', 'anchorUtcMs', 'horizonMs', 'status', 'reasons', 'decisions', 'recurrence', 'flights', 'charge', 'energy', 'host', 'counts'])
  expect(Object.keys(result.counts)).toEqual(['flightReviewCalls', 'flightRequests', 'chargeRequests', 'armsAccepted', 'engagesAccepted', 'chargeFramesAccepted', 'missionRows', 'contactRows', 'chargeRows'])
  expect(result.host.reference).toBe('55:0,0,0,0,0')
  expect(result.counts.chargeRows).toBeGreaterThan(0)
  expect(Buffer.byteLength(`${JSON.stringify(result)}\n`)).toBeLessThanOrEqual(16384)
})

const anchor = 1767225600000
const flight = (decision: 'approve' | 'deny' = 'approve', atMs = 2000, id = 'review-first', dueUtcMs = anchor) => ({ kind: 'flight', id, atMs, dueUtcMs, decision })
test('valid zero-time flight approval and denial both refuse unavailable actual binding without a ledger or flight call', () => {
  for (const decision of ['approve', 'deny'] as const) {
    const result = simulatePatrol({ unsignedLocalReview: true, decisions: [flight(decision, 0)] })
    expect(result.status).toBe('failed')
    expect(result.decisions[0]!.reason).toBe('patrol-binding-unavailable')
    expect(result.decisions[0]!.fulfilled).toBe(false)
    expect(result.counts.flightReviewCalls).toBe(0)
    expect(result.counts.flightRequests).toBe(0)
    expect(result.counts.armsAccepted).toBe(0)
    expect(result.recurrence.slots[0]!.reviewId).toBeNull()
    expect(result.decisions[0]!.reviewOutcome).toBe('not-called')
  }
})

test('a qualified explicit flight denial records native denial without pretending that a mission completed', () => {
  const result = simulatePatrol({ unsignedLocalReview: true, decisions: [flight('deny')] })
  expect(result.status).toBe('reviewed-denials')
  expect(result.decisions[0]!.reviewOutcome).toBe('denied')
  expect(result.decisions[0]!.fulfilled).toBe(true)
  expect(result.recurrence.slots[0]!.reviewId).toBe('review-first')
  expect(result.flights).toEqual([])
  expect(result.counts.flightReviewCalls).toBe(1)
  expect(result.counts.flightRequests).toBe(0)
  expect(result.counts.armsAccepted).toBe(0)
})

const charge = (decision: 'approve' | 'deny' = 'approve', atMs = 47000, id = 'charge-first') => ({ kind: 'charge', id, atMs, occurrenceId: 'patrol-slot-zero', decision })
test('zero-time charge denial is independent of recurrence binding and fulfills only the exact native operator-denied result', () => {
  const result = simulatePatrol({ unsignedLocalReview: true, enableCharge: true, decisions: [charge('deny', 0)] })
  expect(result.status).toBe('reviewed-denials')
  expect(result.decisions[0]!.requestOutcome).toBe('refused')
  expect(result.decisions[0]!.reason).toBe('charge-operator-denied')
  expect(result.decisions[0]!.fulfilled).toBe(true)
  expect(result.counts.flightReviewCalls).toBe(0)
  expect(result.counts.flightRequests).toBe(0)
  expect(result.counts.chargeRequests).toBe(1)
  expect(result.counts.chargeFramesAccepted).toBe(0)
  expect(result.charge.episodes[0]!.state).toBe('refused')
})

test('explicit local reviews compose two real flights, historical contacts and separately verified partial charge on one world', () => {
  const result = simulatePatrol({ unsignedLocalReview: true, enableCharge: true, decisions: [flight(), charge(), flight('approve', 60000, 'review-second', anchor + 60000)] })
  // eslint-disable-next-line no-console
  console.log(`PATROL_FIRST_APPROVED ${JSON.stringify(result)}`)
  expect(result.status).toBe('completed')
  expect(result.reasons).toEqual([])
  expect(result.decisions.map(d => d.fulfilled)).toEqual([true, true, true])
  expect(result.flights.map(f => f.state)).toEqual(['completed', 'completed'])
  expect(result.flights.map(f => f.startedAtMs)).toEqual([2020, 60020])
  expect(result.flights.map(f => f.terminalAtMs)).toEqual([44120, 102120])
  expect(result.flights.every(f => f.contactVerifiedAtMs !== null)).toBe(true)
  expect(result.charge.episodes).toHaveLength(1)
  expect(result.charge.episodes[0]!.verifiedAtMs).toBe(48160)
  expect(result.charge.episodes[0]!.isolatedAtMs).toBe(55400)
  expect(result.charge.electricalIsolation).toBe(true)
  expect(result.energy.trueGrossGainWh).toBeCloseTo(.0592, 10)
  expect(result.energy.verifiedCreditWh).toBeCloseTo(.052053618375, 10)
  expect(result.energy.truePackWh).toBeCloseTo(20 - result.energy.usedWh + result.energy.trueGrossGainWh, 8)
  expect(result.energy.remainingWh).toBeCloseTo(20 - result.energy.usedWh + result.energy.verifiedCreditWh, 10)
  expect(result.counts.flightReviewCalls).toBe(2)
  expect(result.counts.flightRequests).toBe(2)
  expect(result.counts.chargeRequests).toBe(1)
  expect(result.counts.armsAccepted).toBe(2)
  expect(result.counts.engagesAccepted).toBe(2)
  expect(result.counts.chargeFramesAccepted).toBe(400)
  expect(result.counts.missionRows).toBe(result.flights.reduce((sum, f) => sum + (f.terminalAtMs! - f.startedAtMs!) / 20 + 1, 0))
  expect(result.counts.contactRows).toBe(74)
  expect(result.host.sessionId).toBe('123')
  expect(result.host.flightBootId).toBe('55')
  expect(result.host.chargerBootId).toBe('77')
}, 30000)

test('charge-first tied decisions include its still-queued reservation and cannot later heal the refused flight review', () => {
  const result = simulatePatrol({ unsignedLocalReview: true, enableCharge: true, decisions: [flight(), charge('approve', 60000), flight('approve', 60000, 'review-second', anchor + 60000)] })
  expect(result.status).toBe('failed')
  expect(result.decisions.map(d => d.id)).toEqual(['review-first', 'charge-first', 'review-second'])
  expect(result.decisions.map(d => d.fulfilled)).toEqual([true, true, false])
  expect(result.decisions[2]!.reviewOutcome).toBe('refused')
  expect(result.decisions[2]!.reason).toBe('missed-busy')
  expect(result.counts.flightRequests).toBe(1)
  expect(result.counts.chargeRequests).toBe(1)
  expect(result.counts.armsAccepted).toBe(1)
  expect(result.charge.episodes[0]!.startedAtMs).toBe(60020)
  expect(result.flights).toHaveLength(1)
}, 30000)

test('flight-first tied decisions preserve its actual reservation and refuse charge before any enable frame', () => {
  const result = simulatePatrol({ unsignedLocalReview: true, enableCharge: true, decisions: [flight(), flight('approve', 60000, 'review-second', anchor + 60000), charge('approve', 60000)] })
  expect(result.status).toBe('failed')
  expect(result.decisions.map(d => d.id)).toEqual(['review-first', 'review-second', 'charge-first'])
  expect(result.decisions.map(d => d.fulfilled)).toEqual([true, true, false])
  expect(result.decisions[2]!.reason).toBe('charge-contact-or-interlock-unqualified')
  expect(result.counts.flightRequests).toBe(2)
  expect(result.counts.armsAccepted).toBe(2)
  expect(result.counts.chargeFramesAccepted).toBe(0)
  expect(result.energy.trueGrossGainWh).toBe(0)
  expect(result.charge.episodes[0]!.startedAtMs).toBeNull()
}, 30000)

test('an expired explicit denial is unfulfilled and cannot be classified as a successfully recorded denial', () => {
  const result = simulatePatrol({ unsignedLocalReview: true, decisions: [flight('deny', 5000)] })
  expect(result.status).toBe('failed')
  expect(result.decisions[0]!.reason).toBe('missed-review-window')
  expect(result.decisions[0]!.fulfilled).toBe(false)
  expect(result.counts.flightRequests).toBe(0)
  expect(result.counts.armsAccepted).toBe(0)
})

test('the complete unknown list is descriptor-validated before any owned experiment including an invalid final event', () => {
  let reads = 0
  const getter = Object.defineProperty([flight()], '0', { enumerable: true, get() {
    reads++
    return flight()
  } })
  const iterator = Object.assign([flight()], { [Symbol.iterator]() {
    reads++
    throw new Error('iterator')
  } })
  const hidden = Object.defineProperty([flight()], 'hidden', { value: true })
  const eventGetter = Object.defineProperty(flight(), 'decision', { enumerable: true, get() {
    reads++
    return 'approve'
  } })
  const values: unknown[] = [getter, iterator, hidden, [eventGetter], new Array(1), new Array(5), Object.assign([flight()], { extra: true }), Object.create(Array.prototype), [flight(), { ...charge(), atMs: 47001 }], [flight(), { ...charge(), extra: 1 }], [flight(), { ...charge(), id: 'review-first' }], [flight(), { ...flight('deny', 60000, 'another'), dueUtcMs: anchor }], [charge(), flight()], [{ ...flight(), decision: undefined }]]
  for (const decisions of values) expect(() => simulatePatrol({ unsignedLocalReview: true, enableCharge: true, decisions })).toThrow(TypeError)
  for (const input of [null, { profile: undefined }, { unsignedLocalReview: 'false' }, { enableCharge: true }, { decisions: [flight()] }, { unsignedLocalReview: true, decisions: [charge()] }, { unsignedLocalReview: true, decisions: null }, { profile: 'physical' }, { extra: true }, Object.defineProperty({}, 'decisions', { enumerable: true, get() { reads++; return [] } }), { [Symbol('hidden')]: true }, Object.create({ profile: 'nominal' }), new Proxy({}, { ownKeys() { throw new Error('inspection') } })]) expect(() => simulatePatrol(input)).toThrow(TypeError)
  expect(reads).toBe(0)
})
