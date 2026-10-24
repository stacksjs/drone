import { expect, test } from 'bun:test'
import { createCargoFleetSession } from '../../resources/functions/drone/cargo/fleet'
import { simulateCargoFleetControl } from '../../resources/functions/drone/cargo/fleet-control'

type World = ReturnType<typeof createCargoFleetSession>
function decision(world: World, action: 'cancel' | 'resume', sequence: number) {
  const state = world.snapshot()
  return { version: 1, evidence: 'modeled-cargo-transport-decision-v1', contextId: state.operator.contextId, bootId: 102n, sessionId: 202n, reference: state.receiver!.reference, sourceEventId: state.stationSourceEventId!, sequence, issuedAtMs: state.atMs!, action }
}

// Public retained world seam. Both real runtime sessions and the same point/rail
// keep advancing; operator transport decisions do not replace a body or estimator.
test('scoped operator cancellation and later recovery finish the same parcel on the same receiving session', () => {
  const world = createCargoFleetSession()
  try {
    let nowMs = 0
    for (; nowMs <= 60000; nowMs += 4) {
      world.step(nowMs)
      const station = world.snapshot().station
      if (station?.phase === 'moving' && Math.hypot(...station.parcel!.velocityMps) > .1) break
    }
    expect(nowMs).toBeLessThan(60000)
    const before = world.snapshot(), pendingId = before.receiver!.mission.payload!.eventId, epoch = before.receiver!.authority.epoch
    expect(world.decide(decision(world, 'cancel', 1)).outcome).toBe('accepted')
    expect(world.snapshot().station!.phase).toBe('braking')
    expect(Math.hypot(...world.snapshot().station!.parcel!.velocityMps)).toBeGreaterThan(0)
    while (world.snapshot().station!.phase === 'braking') { nowMs += 4; world.step(nowMs) }
    const stopped = world.snapshot()
    expect(stopped.ownership.owner).toBe('station-actor')
    expect(stopped.ownership.totalMassKg).toBe(3.1)
    expect(Math.hypot(...stopped.station!.parcel!.velocityMps)).toBe(0)
    const waitUntil = nowMs + 1000
    for (nowMs += 4; nowMs <= waitUntil; nowMs += 4) {
      world.step(nowMs)
      expect(world.snapshot().receiver!.board.actuators).toEqual([0, 0, 0, 0])
      expect(world.snapshot().receiver!.mission.payload!.eventId).toBe(pendingId)
    }
    nowMs -= 4
    expect(world.decide(decision(world, 'resume', 2)).outcome).toBe('accepted')
    expect(world.snapshot().station!.parcel).toEqual(stopped.station!.parcel)
    expect(world.snapshot().receiver!.authority.epoch).toBe(epoch)
    while (!world.snapshot().terminal) { nowMs += 4; world.step(nowMs) }
    const run = world.result()
    expect(run.status).toBe('completed')
    expect(run.receiver.runtime.authority.sessionId).toBe(202n)
    expect(run.receiver.runtime.board.bootId).toBe(102n)
    expect(run.receiver.intake.custody.outcome).toBe('received')
    expect(run.receiver.delivery.outcome).toBe('received')
    expect(run.station!.resumptions).toHaveLength(1)
    expect(run.operator!.events.map(e => [e.action, e.outcome])).toEqual([['cancel', 'accepted'], ['resume', 'accepted']])
    expect(run.ownership.transitions.map(e => [e.from, e.to])).toEqual([['source-body', 'station-actor'], ['station-actor', 'receiver-body'], ['receiver-body', 'final-parcel-actor']])
    expect(run.ownership.finalMassKg).toBe(3.1)
    expect(run.ownership.maximumMassErrorKg).toBeLessThan(1e-12)
  }
  finally { world.close() }
})

function advanceUntil(world: World, predicate: (state: ReturnType<World['snapshot']>) => boolean, ceiling = 60000) {
  for (let nowMs = (world.snapshot().atMs ?? -4) + 4; nowMs <= ceiling; nowMs += 4) {
    const progress = world.step(nowMs), state = world.snapshot()
    if (predicate(state)) return nowMs
    if (progress.terminal) break
  }
  throw new Error('Expected bounded world phase')
}
const moving = (state: ReturnType<World['snapshot']>) => state.station?.phase === 'moving' && Math.hypot(...state.station.parcel!.velocityMps) > .1

test('operator scope, exact clock and sequence reject stale or foreign decisions before touching the parcel', () => {
  const world = createCargoFleetSession(), other = createCargoFleetSession()
  try {
    const nowMs = advanceUntil(world, moving)
    advanceUntil(other, moving)
    const packet = decision(world, 'cancel', 1), before = world.snapshot(), otherBefore = other.snapshot()
    expect(other.decide(packet)).toEqual({ outcome: 'refused', reason: 'operator-scope' })
    expect(other.snapshot()).toEqual(otherBefore)
    for (const patch of [{ bootId: 103n }, { sessionId: 203n }, { reference: '102:1,0,0,0,0' }, { sourceEventId: 'foreign-source-event' }]) expect(world.decide({ ...packet, ...patch }).reason).toBe('operator-scope')
    expect(world.decide({ ...packet, issuedAtMs: nowMs - 4 }).reason).toBe('operator-clock')
    expect(world.snapshot()).toEqual(before)
    let invoked = 0
    const unsafe = { ...packet, get action() { invoked++; return 'cancel' } }
    expect(() => world.decide(unsafe)).toThrow('cargo-fleet-operator-declaration')
    expect(invoked).toBe(0)
    expect(() => world.decide(packet, 'extra')).toThrow('cargo-fleet-operator-declaration')
    expect(() => world.step(nowMs + 8)).toThrow('cargo-fleet-clock')
    expect(world.snapshot()).toEqual(before)
    expect(world.decide(packet).outcome).toBe('accepted')
    expect(world.decide(packet).reason).toBe('operator-sequence')
    expect(world.snapshot().operator.events).toHaveLength(1)
  }
  finally { world.close(); other.close() }
  expect(world.decide({}).reason).toBe('session-unavailable')
  expect(() => world.step(0)).toThrow('Cargo fleet session is closed')
  expect(world.result().status).toBe('unqualified')
  expect(world.result().source.runtime.board.actuators).toEqual([0, 0, 0, 0])
  expect(world.result().receiver.runtime.board.actuators).toEqual([0, 0, 0, 0])
})

test('a recovery requested while the parcel still brakes is refused without jumping to the old rail endpoint', () => {
  const world = createCargoFleetSession()
  try {
    advanceUntil(world, moving)
    world.decide(decision(world, 'cancel', 1))
    const braking = world.snapshot().station!
    expect(world.decide(decision(world, 'resume', 2))).toEqual({ outcome: 'refused', reason: 'station-not-stopped' })
    expect(world.snapshot().station).toEqual(braking)
    advanceUntil(world, state => state.station?.phase === 'cancelled')
    expect(world.decide(decision(world, 'resume', 3)).outcome).toBe('accepted')
    const detached = world.snapshot(); detached.operator.events[0]!.reason = 'changed'
    expect(world.snapshot().operator.events[0]!.reason).toBe('transport-cancellation-requested')
  }
  finally { world.close() }
})

test('cancellation between intake grant and mechanism consumes the grant and cannot be recovered into a second attempt', () => {
  const world = createCargoFleetSession()
  try {
    let nowMs = advanceUntil(world, state => state.intake.custody.grantedAtMs !== null)
    expect(world.snapshot().ownership.owner).toBe('station-actor')
    expect(world.decide(decision(world, 'cancel', 1)).outcome).toBe('accepted')
    expect(world.decide(decision(world, 'resume', 2))).toEqual({ outcome: 'refused', reason: 'intake-already-attempted' })
    while (!world.snapshot().terminal) { nowMs += 4; world.step(nowMs) }
    const run = world.result()
    expect(run.status).toBe('unqualified')
    expect(run.transfer.intake).toBeNull()
    expect(run.transfer.stationDeparture).toBeNull()
    expect(run.receiver.finalLoad.properties.totalMassKg).toBe(1.5)
    expect(run.receiver.intake.custody.outcome).toBe('uncertain')
    expect(run.receiver.runtime.mission.reason).toBe('payload-diversion-landed')
    expect(run.station!.phase).toBe('cancelled')
    expect(run.station!.ownedMassKg).toBe(.1)
    expect(run.ownership.finalMassKg).toBe(3.1)
  }
  finally { world.close() }
})

test('a current operator declaration cannot recover transport after receiver navigation authority expires', () => {
  const world = createCargoFleetSession({ scenario: 'receiver-navigation-loss-during-rail' })
  try {
    advanceUntil(world, state => state.station?.phase === 'moving')
    world.decide(decision(world, 'cancel', 1))
    advanceUntil(world, state => state.receiver?.authority.state === 'failsafe')
    const before = world.snapshot().station
    expect(world.decide(decision(world, 'resume', 2))).toEqual({ outcome: 'refused', reason: 'recovery-authority-unavailable' })
    expect(world.snapshot().station).toEqual(before)
    expect(world.snapshot().ownership.owner).toBe('station-actor')
  }
  finally { world.close() }
})

test('closing the retained world reports revoked current board output without pretending the parcel instantly stopped', () => {
  const world = createCargoFleetSession()
  advanceUntil(world, moving)
  const before = world.snapshot(), movingPoint = before.station!.parcel!
  world.close(); world.close()
  const closed = world.snapshot()
  expect(closed.closed).toBe(true)
  expect(closed.terminal).toBe(true)
  expect(closed.source!.hostAvailable).toBe(false)
  expect(closed.receiver!.hostAvailable).toBe(false)
  expect(closed.source!.board.actuators).toEqual([0, 0, 0, 0])
  expect(closed.receiver!.board.actuators).toEqual([0, 0, 0, 0])
  expect(closed.atMs).toBe(before.atMs)
  expect(closed.source!.policyAtMs).toBe(before.source!.policyAtMs)
  expect(closed.receiver!.policyAtMs).toBe(before.receiver!.policyAtMs)
  expect(closed.receiver!.reference).toBe(before.receiver!.reference)
  expect(closed.station!.phase).toBe('braking')
  expect(closed.station!.parcel).toEqual(movingPoint)
  expect(closed.ownership.totalMassKg).toBe(3.1)
  expect(world.decide({}).reason).toBe('session-unavailable')
})

test('a declaration capture that closes the world cannot resume or consume an operator sequence', () => {
  const world = createCargoFleetSession()
  advanceUntil(world, moving)
  const packet = decision(world, 'cancel', 1)
  const proxy = new Proxy(packet, { getOwnPropertyDescriptor(target, key) { world.close(); return Reflect.getOwnPropertyDescriptor(target, key) } })
  expect(world.decide(proxy)).toEqual({ outcome: 'refused', reason: 'session-unavailable' })
  expect(world.snapshot().operator.lastSequence).toBe(0)
  expect(world.snapshot().operator.events).toHaveLength(0)
  expect(world.snapshot().closed).toBe(true)
})

test('operator case admission rejects extra fields, accessors and extra arguments before creating a world', () => {
  let calls = 0
  for (const declaration of [null, { case: 'unknown' }, { case: 'cancel', extra: true }, { get case() { calls++; return 'cancel' } }]) expect(() => simulateCargoFleetControl(declaration)).toThrow('cargo-fleet-control-arguments')
  expect(() => simulateCargoFleetControl({}, true)).toThrow('cargo-fleet-control-arguments')
  expect(calls).toBe(0)
})

for (const completion of ['early-close', 'natural'] as const) {
  test(`fleet terminal results remain detached after ${completion}`, () => {
    const world = createCargoFleetSession({ scenario: completion === 'early-close' ? 'receiver-kill-after-intake' : 'nominal' })
    try {
      if (completion === 'early-close') world.close()
      else for (let nowMs = 0; !world.step(nowMs).terminal; nowMs += 4) { /* Same finite native world. */ }
      const result = world.result(), expected = structuredClone(result)
      result.source.initialLoad.properties.totalMassKg = 0
      result.receiver.initialLoad.properties.totalMassKg = 0
      result.source.linkEvents.length = 0
      result.ownership.transitions.length = 0
      if (result.faultInjection) result.faultInjection.triggeredAtMs = 999
      if (result.transfer.sourceRelease) result.transfer.sourceRelease.eventId = 'rewritten'
      if (result.transfer.intake) result.transfer.intake.receiver.board.actuators[0] = 77
      expect(world.result()).toEqual(expected)
      world.close()
      expect(world.result()).toEqual(expected)
    }
    finally { world.close() }
  })
}
