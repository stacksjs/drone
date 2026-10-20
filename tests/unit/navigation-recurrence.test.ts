import { parse } from '@stacksjs/cron'
import { expect, test } from 'bun:test'

const utc = Date.UTC(2026, 0, 1)
test('actual native UTC parser uses exclusive cursors for two selected minute slots and their excluded sentinel', () => {
  const first = parse('* * * * *', utc - 1, { tz: 'UTC' })!
  const second = parse('* * * * *', first, { tz: 'UTC' })!
  const sentinel = parse('* * * * *', second, { tz: 'UTC' })!
  expect(first.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  expect(second.toISOString()).toBe('2026-01-01T00:01:00.000Z')
  expect(sentinel.toISOString()).toBe('2026-01-01T00:02:00.000Z')
  expect(parse('* * * * *', utc, { tz: 'UTC' })!.getTime()).toBe(second.getTime())
})

import { createPatrolRecurrence } from '../../resources/functions/drone/navigation/recurrence'
const config = () => ({ scheduleId: 'patrol', revision: 1, profile: 'minute-zero-one-v1', anchorUtcMs: utc, anchorMonoMs: 0 })
const at = (monoMs: number, busy = false) => ({ utcMs: utc + monoMs, monoMs, busy })

test('due slots are review metadata only and repeated scans preserve one bounded owned identity', () => {
  const ledger = createPatrolRecurrence(config())
  expect(ledger.snapshot().records).toHaveLength(0)
  const due = ledger.scan(at(0))
  expect(due.parserCalls).toBe(3)
  expect(due.selectedUtcMs).toEqual([utc, utc + 60000])
  expect(due.cursorUtcMs).toBe(utc + 120000)
  expect(due.records).toHaveLength(1)
  expect(due.records[0]!.state).toBe('awaiting-review')
  expect(due.records[0]!.review).toBeNull()
  expect(due.transitions).toHaveLength(1)
  expect('handoff' in due).toBe(false)
  expect(ledger.scan(at(0))).toEqual(due)
  due.records[0]!.state = 'approved'
  expect(ledger.snapshot().records[0]!.state).toBe('awaiting-review')
})

const binding = () => ({ vehicleId: 'navigation-vehicle' as const, padId: 'pad' as const, planId: 'local-survey-demo' as const, profile: 'nominal-contact-partial-charge-v1' as const, sessionId: '123', bootId: '55', reference: '55:0,0,0,0,0', origin: '{"latitudeDeg":0,"longitudeDeg":0,"ellipsoidHeightM":100}' })
const context = (monoMs: number, busy = false) => ({ ...at(monoMs, busy), binding: binding() })
const review = (dueUtcMs = utc, reviewId = 'review-first', decision = 'approve') => ({ dueUtcMs, reviewId, decision })

test('an explicit unsigned review emits one positive handoff and retains immutable consumed metadata', () => {
  const ledger = createPatrolRecurrence(config())
  ledger.scan(at(0))
  const ctx = context(2000)
  const result = ledger.review(review(), ctx)
  expect(result.outcome).toBe('approved')
  expect(result.handoff).toEqual({ occurrenceId: 'patrol-slot-zero', issuedAtMs: 2000, binding: binding() })
  expect(result.review!.consumed).toBe(true)
  expect(result.review!.deadlineMonoMs).toBe(5000)
  const before = ledger.snapshot()
  ctx.binding.bootId = '99'
  result.handoff!.binding.bootId = '88'
  expect(ledger.review(review(utc, 'changed', 'deny'), context(-1))).toEqual({ outcome: 'refused', reason: 'review-consumed', tuple: before.records[0]!.tuple, review: null, handoff: null })
  expect(ledger.snapshot()).toEqual(before)
  expect('handoff' in before.records[0]!).toBe(false)
  expect(before.transitions).toHaveLength(2)
})

test('review deadlines are exclusive and deny or busy results stay terminal without retry', () => {
  for (const c of [{ now: 4999, busy: false, decision: 'approve', outcome: 'approved', reason: 'local-review-approved' }, { now: 5000, busy: false, decision: 'approve', outcome: 'refused', reason: 'missed-review-window' }, { now: 2000, busy: false, decision: 'deny', outcome: 'denied', reason: 'operator-denied' }, { now: 2000, busy: true, decision: 'approve', outcome: 'refused', reason: 'missed-busy' }] as const) {
    const ledger = createPatrolRecurrence(config())
    ledger.scan(at(0))
    const result = ledger.review(review(utc, 'first', c.decision), context(c.now, c.busy))
    expect(result.outcome).toBe(c.outcome)
    expect(result.reason).toBe(c.reason)
    expect(result.review!.consumed).toBe(true)
    const before = ledger.snapshot()
    expect(ledger.review(review(utc, 'retry'), context(c.now + 1)).handoff).toBeNull()
    expect(ledger.snapshot()).toEqual(before)
    expect(ledger.scan(at(60000)).records[0]).toEqual(before.records[0])
  }
})

test('lookback, first late scans, exact scan-gap boundaries and future blocked slots have bounded honest histories', () => {
  for (const [now, reason] of [[30000, 'missed-review-window'], [30001, 'missed-lookback'], [60000, 'missed-lookback'], [60001, 'missed-gap']] as const) {
    const ledger = createPatrolRecurrence(config())
    const first = ledger.scan(at(now))
    expect(first.records[0]!.reason).toBe(reason)
    expect(first.records.length).toBeLessThanOrEqual(2)
    if (now === 60000) {
      expect(first.latch).toBeNull()
      expect(first.records[1]!.state).toBe('awaiting-review')
    }
    if (now === 60001) {
      expect(first.latch).toBe('ledger-scan-gap')
      expect(first.records[1]!.reason).toBe('missed-gap')
      expect(first.summary!.affectedSelected).toBe(2)
      expect(first.summary!.uncomputedOutsideSelection).toBe(true)
      expect(ledger.scan(null)).toEqual(first)
      expect(ledger.review(null, null).handoff).toBeNull()
    }
  }
  const ledger = createPatrolRecurrence(config())
  ledger.scan(at(0))
  const first = ledger.review(review(), context(4999))
  expect(first.outcome).toBe('approved')
  const gap = ledger.scan(at(60001))
  expect(gap.latch).toBe('ledger-scan-gap')
  expect(gap.records[0]!.state).toBe('approved')
  expect(gap.summary!.fromUtcMs).toBe(utc)
  const clock = createPatrolRecurrence(config())
  clock.scan(at(0))
  const failed = clock.scan({ ...at(4), utcMs: utc - 1 })
  expect(failed.lastGood.monoMs).toBe(0)
  expect(failed.records).toHaveLength(1)
  expect(failed.records[0]!.reason).toBe('missed-clock')
  expect(clock.scan(at(60000))).toEqual(failed)
})

test('unknown, unmaterialized, busy and cross-tuple consumed review identities cannot advance another record clock', () => {
  const ledger = createPatrolRecurrence(config())
  const empty = ledger.snapshot()
  expect(ledger.review(review(), context(2000)).reason).toBe('not-materialized')
  expect(ledger.review(review(utc + 60000), context(-1)).reason).toBe('not-due')
  expect(ledger.review(review(utc + 120000), context(-1)).reason).toBe('unknown-tuple')
  expect(ledger.snapshot()).toEqual(empty)
  ledger.scan(at(0))
  ledger.review(review(utc, 'one-id'), context(2000))
  const second = ledger.scan(at(60000))
  expect(ledger.review(review(utc + 60000, 'one-id'), context(-1)).reason).toBe('review-id-consumed')
  expect(ledger.snapshot()).toEqual(second)
  expect(ledger.review(review(utc + 60000, 'second-id'), context(60000)).handoff!.occurrenceId).toBe('patrol-slot-one')
  const consumed = ledger.snapshot()
  for (let n = 0; n < 100; n++) ledger.review(review(utc + 60000, 'changed'), context(0))
  expect(ledger.snapshot()).toEqual(consumed)
  expect(consumed.records).toHaveLength(2)
  expect(consumed.transitions).toHaveLength(4)
  const other = createPatrolRecurrence({ ...config(), revision: 2 })
  expect(other.snapshot().owner.revision).toBe(2)
  expect(other.snapshot().records).toHaveLength(0)
  const busy = createPatrolRecurrence(config())
  expect(busy.scan(at(0, true)).records[0]!.reason).toBe('missed-busy')
  expect(busy.review(review(), context(0)).handoff).toBeNull()
})

test('invalid observation clocks latch without rewriting consumed history or admitting future selected slots', () => {
  for (const bad of [{ ...at(2001), utcMs: utc + 2000 }, at(1999), at(NaN), at(Infinity), at(180001), { ...at(2000), utcMs: 8640000000000001 }]) {
    const ledger = createPatrolRecurrence(config())
    ledger.scan(at(0))
    ledger.review(review(), context(2000))
    const consumed = ledger.snapshot().records[0]
    const failed = ledger.scan(bad)
    expect(failed.latch).toBe('ledger-clock-unqualified')
    expect(failed.lastGood.monoMs).toBe(2000)
    expect(failed.records[0]).toEqual(consumed)
    expect(failed.records).toHaveLength(1)
    expect(failed.summary!.toUtcMs).toBe(utc + 2000)
    expect(ledger.scan(at(60000))).toEqual(failed)
    expect(ledger.review(review(utc + 60000), context(60000)).handoff).toBeNull()
  }
})

test('constructor and inspection boundaries reject invalid fields and dates without reading getters or mutating live history', () => {
  let getterReads = 0
  const accessor = Object.defineProperty(config(), 'scheduleId', { enumerable: true, get() { getterReads++
  return 'patrol' } })
  for (const input of [accessor, { ...config(), profile: '0 * * * * *' }, { ...config(), anchorMonoMs: 1 }, { ...config(), anchorUtcMs: utc + 1 }, { ...config(), anchorUtcMs: -8640000000000000 }, { ...config(), anchorUtcMs: 8640000000000000 - 120000 }, { ...config(), revision: 0 }, { ...config(), revision: 1.5 }, { ...config(), scheduleId: 'Invalid' }, { ...config(), extra: true }]) expect(() => createPatrolRecurrence(input)).toThrow(TypeError)
  expect(getterReads).toBe(0)
  const ledger = createPatrolRecurrence(config())
  ledger.scan(at(0))
  const before = ledger.snapshot()
  const inputs = [null, { ...review(), [Symbol('extra')]: 1 }, Object.create(review()), Object.defineProperty(review(), 'decision', { enumerable: false, value: 'approve' }), new Proxy(review(), { ownKeys() { throw new Error('inspection') } }), { ...review(), scheduleId: 'foreign' }]
  for (const input of inputs) {
    expect(() => ledger.review(input, context(2000))).toThrow(TypeError)
    expect(ledger.snapshot()).toEqual(before)
  }
  expect(() => ledger.review(review(), { ...context(2000), binding: { ...binding(), bootId: '01' } })).toThrow(TypeError)
  expect(() => ledger.review(review(), { ...context(2000), binding: { ...binding(), origin: '\n' } })).toThrow(TypeError)
  expect(ledger.snapshot()).toEqual(before)
})

test('caught reentrant inspection cannot consume or observe partial state and latched handles never inspect later input', () => {
  for (const operation of ['scan', 'review', 'snapshot'] as const) {
    const ledger = createPatrolRecurrence(config())
    ledger.scan(at(0))
    const before = ledger.snapshot()
    let traps = 0, nestedRejected = false
    const input = new Proxy(review(), {
      getPrototypeOf() {
        traps++
        try {
          if (operation === 'scan') ledger.scan(at(2000))
          else if (operation === 'review') ledger.review(review(), context(2000))
          else ledger.snapshot()
        }
        catch (error) { nestedRejected = error instanceof TypeError }
        return Object.prototype
      },
    })
    expect(() => ledger.review(input, context(2000))).toThrow(TypeError)
    expect(traps).toBe(1)
    expect(nestedRejected).toBe(true)
    expect(ledger.snapshot()).toEqual(before)
    expect(ledger.review(review(), context(2000)).outcome).toBe('approved')
  }
  const ledger = createPatrolRecurrence(config())
  ledger.scan(at(0))
  const latched = ledger.scan(at(-1))
  let inspections = 0
  const never = new Proxy({}, { getPrototypeOf() { inspections++
  throw new Error('must not inspect') } })
  for (let n = 0; n < 100; n++) {
    expect(ledger.scan(never)).toEqual(latched)
    expect(ledger.review(never, never).handoff).toBeNull()
  }
  expect(inspections).toBe(0)
  expect(latched.transitions).toHaveLength(3)
  expect(latched.summary!.affectedSelected).toBe(1)
})

import { createNavigationOccurrenceSession } from '../../resources/functions/drone/navigation/runtime'
import { exampleMission } from '../../resources/functions/drone/missions/plan'

test('actual native recurrence reviews compose two retained flights with separate partial charge and measured isolation', () => {
  const session = createNavigationOccurrenceSession({ contact: 'nominal', charge: 'nominal' })
  const ledger = createPatrolRecurrence(config())
  type Snapshot = ReturnType<typeof session.snapshot>
  const busy = (s: Snapshot) => s.occurrences.some(o => o.state === 'queued' || o.state === 'running') || ['pending', 'verified', 'isolating'].includes(s.charge!.phase)
  const actualBinding = (s: Snapshot) => ({ ...binding(), planId: exampleMission().id as 'local-survey-demo', sessionId: String(s.authority.sessionId), bootId: String(s.estimate.bootId), reference: `${s.estimate.bootId}:${Object.values(s.estimate.resets).join(',')}`, origin: JSON.stringify(s.estimate.localPosition!.origin) })
  const emit = (event: string, value: unknown) => {
    // eslint-disable-next-line no-console
    console.log(`PATROL_RECURRENCE_${event} ${JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v)}`)
  }
  const initial = session.advanceTo(0)
  ledger.scan(at(0, busy(initial)))
  expect(session.snapshot()).toEqual(initial)
  expect(initial.counts.armAccepted).toBe(0)
  expect(initial.charge!.output.values).toEqual([0])
  expect(session.snapshot().nowMs).toBeLessThanOrEqual(2000)
  const ready = session.advanceTo(2000)
  const first = ledger.review(review(), { ...at(ready.nowMs, busy(ready)), binding: actualBinding(ready) })
  emit('FIRST_REVIEW', { first, nowMs: ready.nowMs, chargePhase: ready.charge!.phase })
  expect(first.outcome).toBe('approved')
  expect(first.handoff!.binding).toEqual(actualBinding(session.snapshot()))
  expect(session.requestOccurrence({ id: first.handoff!.occurrenceId, issuedAtMs: first.handoff!.issuedAtMs, decision: 'approve' }).state).toBe('queued')
  expect(session.snapshot().nowMs).toBeLessThanOrEqual(47000)
  const landed = session.advanceTo(47000)
  emit('FIRST_CONTACT', { state: landed.occurrences[0]!.state, terminalAtMs: landed.occurrences[0]!.terminalAtMs, contact: landed.contact!.phase, eligible: landed.contact!.currentEligibility, usedWh: landed.energy.usedWh })
  expect(landed.occurrences[0]!.state).toBe('completed')
  expect(landed.contact!.currentEligibility).toBe(true)
  expect(landed.charge!.episodes).toHaveLength(0)
  expect(session.requestCharge!({ id: 'slot-zero-charge', occurrenceId: first.handoff!.occurrenceId, issuedAtMs: landed.nowMs, decision: 'approve' }).state).toBe('queued')
  expect(session.snapshot().nowMs).toBeLessThanOrEqual(60000)
  const isolated = session.advanceTo(60000)
  emit('ISOLATED', { charge: isolated.charge!.phase, electricalIsolation: isolated.charge!.host.electricalIsolation, gain: isolated.charge!.plant.grossGainWh, credit: isolated.charge!.host.verifiedCreditWh, episodes: isolated.charge!.episodes.map(e => ({ started: e.startedAtMs, verified: e.verifiedAtMs, isolated: e.isolatedAtMs })) })
  expect(isolated.charge!.phase).toBe('idle')
  expect(isolated.charge!.host.electricalIsolation).toBe(true)
  expect(isolated.charge!.plant.grossGainWh).toBeCloseTo(.0592, 10)
  expect(isolated.charge!.host.verifiedCreditWh).toBeGreaterThan(.004)
  const due = ledger.scan(at(60000, busy(isolated)))
  expect(due.records[1]!.state).toBe('awaiting-review')
  expect(session.snapshot()).toEqual(isolated)
  expect(isolated.counts.armAccepted).toBe(1)
  const second = ledger.review(review(utc + 60000, 'review-second'), { ...at(isolated.nowMs, busy(isolated)), binding: actualBinding(isolated) })
  emit('SECOND_REVIEW', second)
  expect(second.outcome).toBe('approved')
  expect(second.handoff!.binding).toEqual(actualBinding(session.snapshot()))
  expect(session.requestOccurrence({ id: second.handoff!.occurrenceId, issuedAtMs: second.handoff!.issuedAtMs, decision: 'approve' }).state).toBe('queued')
  expect(session.snapshot().nowMs).toBeLessThanOrEqual(110000)
  const final = session.advanceTo(110000)
  emit('FINAL', { nowMs: final.nowMs, tuples: ledger.snapshot().records.map(r => r.tuple), starts: final.occurrences.map(o => o.startedAtMs), completions: final.occurrences.map(o => o.terminalAtMs), states: final.occurrences.map(o => o.state), contactWindows: final.contact!.outcomes.map(o => o.phase), boot: final.board.bootId, raw: final.sensors.sensors.find(s => s.kind === 'imu')!.observation!.sequence, sequence: final.board.sequence, energy: final.energy, gain: final.charge!.plant.grossGainWh })
  expect(final.occurrences.map(o => o.state)).toEqual(['completed', 'completed'])
  expect(final.contact!.outcomes).toHaveLength(2)
  expect(final.contact!.outcomes.every(o => o.phase === 'verified')).toBe(true)
  expect(final.occurrences[0]).toEqual(landed.occurrences[0])
  expect(final.contact!.outcomes[0]).toEqual(landed.contact!.outcomes[0])
  expect(actualBinding(final)).toEqual(actualBinding(ready))
  expect(final.estimate.resets).toEqual(ready.estimate.resets)
  expect(final.authority.sessionId).toBe(ready.authority.sessionId)
  expect(final.authority.bootId).toBe(ready.authority.bootId)
  expect(final.estimate.bootId).toBe(ready.estimate.bootId)
  expect(final.charge!.output.bootId).toBe(ready.charge!.output.bootId)
  expect(final.charge!.output.bootId).toBe(isolated.charge!.output.bootId)
  expect(final.charge!.episodes).toEqual(isolated.charge!.episodes)
  expect(final.board.bootId).toBe(initial.board.bootId)
  expect(final.board.sequence).toBeGreaterThan(isolated.board.sequence)
  expect(final.sensors.sensors.find(s => s.kind === 'imu')!.observation!.sequence).toBeGreaterThan(isolated.sensors.sensors.find(s => s.kind === 'imu')!.observation!.sequence)
  expect(final.energy.usedWh).toBeGreaterThan(isolated.energy.usedWh)
  expect(final.energy.verifiedCreditWh).toBe(isolated.energy.verifiedCreditWh)
  expect(final.energy.remainingWh).toBeCloseTo(20 - final.energy.usedWh + final.energy.verifiedCreditWh!, 12)
  expect(final.charge!.plant.loadWh).toBeCloseTo(final.energy.usedWh, 10)
  expect(final.charge!.plant.storedWh).toBeCloseTo(20 - final.energy.usedWh + final.charge!.plant.grossGainWh, 8)
  expect(ledger.snapshot().records.map(r => r.review!.consumed)).toEqual([true, true])
}, 30000)


test('a pending review with a rewound clock latches using the prior good epoch without recording a decision', () => {
  const ledger = createPatrolRecurrence(config())
  ledger.scan(at(1000))
  const prior = ledger.snapshot()
  const refused = ledger.review(review(), context(999))
  const failed = ledger.snapshot()
  expect(refused.outcome).toBe('refused')
  expect(refused.reason).toBe('ledger-clock-unqualified')
  expect(refused.review).toBeNull()
  expect(refused.handoff).toBeNull()
  expect(failed.latch).toBe('ledger-clock-unqualified')
  expect(failed.lastGood).toEqual(prior.lastGood)
  expect(failed.records[0]!.state).toBe('missed')
  expect(failed.records[0]!.reason).toBe('missed-clock')
  expect(failed.records[0]!.review).toBeNull()
  expect(failed.summary!.atMonoMs).toBe(1000)
  expect(failed.summary!.toUtcMs).toBe(utc + 1000)
  expect(failed.summary!.affectedSelected).toBe(1)
  expect(ledger.review(review(), context(2000)).handoff).toBeNull()
  expect(ledger.scan(at(60000))).toEqual(failed)
})
