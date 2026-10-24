import { expect, test } from 'bun:test'
import { createCargoStationHandler } from '../../resources/functions/drone/cargo/station'
import { createReceivingRigidBody, createRigidBody } from '../../resources/functions/drone/controls/physics'

// Physical function seam: one real separated parcel crosses a finite station path
// and enters actual receiving dynamics. This is not vehicle authority or a custody ACK.
test('one separated point load moves continuously to the receiving joint and leaves the station once', () => {
  const load = { id: 'parcel-a', massKg: .1, forwardM: .08 }
  const source = createRigidBody({ positionM: [0, 0, 0], carriedPointLoad: load })
  const receiver = createReceivingRigidBody({ positionM: [1, 0, 0], expectedPointLoad: load })
  source.step([0, 0, 0, 0], .004); receiver.step([0, 0, 0, 0], .004)
  const release = source.separateCarriedLoad()
  if (release.outcome !== 'separated') throw new Error('Expected actual source separation')
  const station = createCargoStationHandler({ atMs: 4, parcel: { id: load.id, ...release.parcel }, pickup: { centerM: [.08, 0, 0], radiusM: .1 }, destinationM: receiver.intakePoint().positionM, maxSpeedMps: .5, maxAccelerationMps2: 1 })
  expect(station.snapshot().ownedMassKg).toBe(.1)
  expect(source.loadSnapshot().properties.totalMassKg + receiver.loadSnapshot().properties.totalMassKg + station.snapshot().ownedMassKg).toBe(3.1)
  expect(station.start()).toEqual({ outcome: 'started', atMs: 4, durationMs: 3752 })
  let previous = station.snapshot().parcel!.positionM
  for (let nowMs = 8; nowMs <= 3756; nowMs += 4) {
    receiver.step([0, 0, 0, 0], .004)
    const state = station.step(nowMs), parcel = state.parcel!
    expect(Math.hypot(...parcel.positionM.map((n, i) => n - previous[i]!))).toBeLessThanOrEqual(.002 + 1e-12)
    if (nowMs === 1880) { expect(parcel.positionM[0]).toBeCloseTo(.58, 14); expect(parcel.velocityMps[0]).toBeCloseTo(.4997334754797441, 13) }
    previous = parcel.positionM
  }
  expect(station.snapshot().phase).toBe('ready')
  const exit = station.takeReadyParcel()
  if (exit.outcome !== 'departed') throw new Error('Expected actual station exit')
  expect(receiver.attachParcel(exit.parcel).outcome).toBe('attached')
  expect(station.snapshot().parcel).toBeNull()
  expect(station.snapshot().ownedMassKg).toBe(0)
  expect(source.loadSnapshot().properties.totalMassKg + receiver.loadSnapshot().properties.totalMassKg).toBe(3.1)
  expect(station.takeReadyParcel()).toEqual({ outcome: 'refused', reason: 'not-ready' })
  expect(Math.abs(station.snapshot().energy.residualJ)).toBeLessThan(1e-12)
})

test('the actual released point falls before surface capture and retains its impact energy and epoch', () => {
  const load = { id: 'parcel-a', massKg: .1, forwardM: .08 }, gravity = 9.80665
  const source = createRigidBody({ positionM: [0, 0, -1], carriedPointLoad: load })
  source.step([0, 0, 0, 0], .004)
  const release = source.separateCarriedLoad()
  if (release.outcome !== 'separated') throw new Error('Expected airborne source separation')
  const initial = release.parcel, v0 = initial.velocityMps[2], height = -initial.positionM[2]
  const hitAtMs = 4 + 1000 * (Math.sqrt(v0 ** 2 + 2 * gravity * height) - v0) / gravity
  const station = createCargoStationHandler({ atMs: 4, parcel: { id: load.id, ...initial }, pickup: { centerM: [.08, 0, 0], radiusM: .1 }, destinationM: [1.08, 0, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 })
  expect(station.snapshot().phase).toBe('falling')
  expect(station.start()).toEqual({ outcome: 'refused', reason: 'not-held' })
  let nowMs = 4
  while (station.snapshot().phase === 'falling') {
    nowMs += 4
    const state = station.step(nowMs), seconds = (nowMs - 4) / 1000
    expect(Math.abs(state.energy.residualJ)).toBeLessThan(1e-12)
    if (state.phase === 'falling') expect(state.parcel!.positionM[2]).toBeCloseTo(initial.positionM[2] + v0 * seconds + .5 * gravity * seconds ** 2, 12)
    expect(nowMs).toBeLessThan(1000)
  }
  const landed = station.snapshot()
  expect(landed.phase).toBe('held')
  expect(landed.parcel!.positionM).toEqual([.08, 0, 0])
  expect(landed.parcel!.velocityMps).toEqual([0, 0, 0])
  expect(landed.impact!.atMs).toBeCloseTo(hitAtMs, 9)
  expect(landed.impact!.impulseNs[2]).toBeCloseTo(-.1 * Math.sqrt(v0 ** 2 + 2 * gravity * height), 12)
  expect(landed.energy.planeDissipationJ).toBeCloseTo(.05 * v0 ** 2 + .1 * gravity * height, 12)
  expect(landed.energy.stationNetWorkJ).toBe(0)
  expect(station.start().outcome).toBe('started')
})

test('cancellation brakes the real moving parcel finitely and retains it instead of transferring it', () => {
  const station = createCargoStationHandler({ atMs: 4, parcel: { id: 'parcel-a', massKg: .1, positionM: [.08, 0, 0], velocityMps: [0, 0, 0] }, pickup: { centerM: [.08, 0, 0], radiusM: .1 }, destinationM: [1.08, 0, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 })
  station.start()
  for (let atMs = 8; atMs <= 1880; atMs += 4) station.step(atMs)
  const before = station.snapshot(), v0 = before.parcel!.velocityMps[0]
  expect(station.cancel()).toEqual({ outcome: 'cancelling', atMs: 1880 })
  expect(station.snapshot().phase).toBe('braking')
  expect(station.snapshot().parcel).toEqual(before.parcel)
  expect(station.takeReadyParcel()).toEqual({ outcome: 'refused', reason: 'not-ready' })
  let atMs = 1880, previous = before.parcel!
  while (station.snapshot().phase === 'braking') {
    atMs += 4
    const row = station.step(atMs), p = row.parcel!
    expect(p.velocityMps[0]).toBeGreaterThanOrEqual(0)
    expect(p.velocityMps[0]).toBeLessThan(previous.velocityMps[0])
    expect(Math.abs(p.velocityMps[0] - previous.velocityMps[0])).toBeLessThanOrEqual(.004 + 1e-12)
    expect(Math.hypot(...p.positionM.map((n, i) => n - previous.positionM[i]!))).toBeLessThanOrEqual(.002 + 1e-12)
    expect(Math.abs(row.energy.residualJ)).toBeLessThan(1e-12)
    expect(atMs).toBeLessThan(2500)
    previous = p
  }
  const stopped = station.snapshot()
  expect(stopped.phase).toBe('cancelled')
  expect(stopped.parcel!.velocityMps).toEqual([0, 0, 0])
  expect(stopped.parcel!.positionM[0]).toBeCloseTo(.58 + v0 ** 2 / 2, 12)
  expect(stopped.stoppedAtMs).toBeCloseTo(1880 + v0 * 1000, 9)
  expect(stopped.ownedMassKg).toBe(.1)
  expect(station.start()).toEqual({ outcome: 'refused', reason: 'not-held' })
  expect(station.cancel()).toEqual({ outcome: 'refused', reason: 'already-cancelled' })
  expect(station.step(atMs + 4).parcel).toEqual(stopped.parcel)
})

test('a drifting parcel misses the declared pickup instead of being pulled onto the rail', () => {
  const station = createCargoStationHandler({ atMs: 0, parcel: { id: 'parcel-a', massKg: .1, positionM: [0, 0, -1], velocityMps: [1, 0, 0] }, pickup: { centerM: [0, 0, 0], radiusM: .1 }, destinationM: [1, 0, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 })
  let atMs = 0
  while (station.snapshot().phase === 'falling') station.step(atMs += 4)
  const missed = station.snapshot()
  expect(missed.phase).toBe('missed')
  // Independent one-metre drop: flight time sqrt(2/g), with constant 1 m/s north velocity.
  expect(missed.parcel!.positionM[0]).toBeCloseTo(Math.sqrt(2 / 9.80665), 12)
  expect(missed.energy.planeDissipationJ).toBeCloseTo(1.030665, 12)
  expect(missed.impact!.impulseNs[0]).toBe(-.1)
  expect(missed.ownedMassKg).toBe(.1)
  expect(Math.abs(missed.energy.residualJ)).toBeLessThan(1e-12)
  expect(station.start()).toEqual({ outcome: 'refused', reason: 'not-held' })
  expect(station.takeReadyParcel()).toEqual({ outcome: 'refused', reason: 'not-ready' })
  expect(station.step(atMs + 4).parcel).toEqual(missed.parcel)
})

test('cancelling a rising parcel retains gravity and impact before it can settle', () => {
  const station = createCargoStationHandler({ atMs: 0, parcel: { id: 'parcel-a', massKg: .1, positionM: [0, 0, 0], velocityMps: [0, 0, -1] }, pickup: { centerM: [0, 0, 0], radiusM: .1 }, destinationM: [1, 0, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 })
  expect(station.cancel()).toEqual({ outcome: 'cancelling', atMs: 0 })
  expect(station.snapshot().phase).toBe('falling')
  expect(station.snapshot().forceN).toEqual([0, 0, 0])
  expect(station.step(4).parcel!.positionM[2]).toBeCloseTo(-.0039215468, 12)
  let atMs = 4
  while (station.snapshot().phase === 'falling') station.step(atMs += 4)
  const stopped = station.snapshot()
  expect(stopped.phase).toBe('cancelled')
  expect(stopped.impact!.atMs).toBeCloseTo(2000 / 9.80665, 9)
  expect(stopped.stoppedAtMs).toBe(stopped.impact!.atMs)
  expect(stopped.energy.planeDissipationJ).toBeCloseTo(.05, 12)
  expect(stopped.energy.stationNetWorkJ).toBe(0)
  expect(Math.abs(stopped.energy.residualJ)).toBeLessThan(1e-12)
  expect(station.start().outcome).toBe('refused')
  expect(station.takeReadyParcel().outcome).toBe('refused')
})

test('lifting retains mechanical work and speed/acceleration limits on the full spatial path', () => {
  const station = createCargoStationHandler({ atMs: 0, parcel: { id: 'parcel-a', massKg: .2, positionM: [0, 0, 0], velocityMps: [0, 0, 0] }, pickup: { centerM: [0, 0, 0], radiusM: .1 }, destinationM: [1, 2, -1], maxSpeedMps: .5, maxAccelerationMps2: 1 })
  station.start()
  let atMs = 0, previous = station.snapshot()
  while (station.snapshot().phase === 'moving') {
    const row = station.step(atMs += 4)
    expect(Math.hypot(...row.parcel!.velocityMps)).toBeLessThanOrEqual(.5 + 1e-12)
    expect(Math.hypot(...row.parcel!.velocityMps.map((n, i) => (n - previous.parcel!.velocityMps[i]!) / .004))).toBeLessThanOrEqual(1 + 1e-12)
    expect(Math.abs(row.energy.residualJ)).toBeLessThan(1e-12)
    previous = row
  }
  expect(previous.parcel!.positionM).toEqual([1, 2, -1])
  expect(Math.hypot(...previous.parcel!.velocityMps)).toBe(0)
  expect(previous.energy.stationNetWorkJ).toBeCloseTo(1.96133, 12)
  expect(previous.energy.positiveWorkJ).toBeGreaterThanOrEqual(previous.energy.stationNetWorkJ)
  expect(previous.energy.positiveWorkJ + previous.energy.negativeWorkJ).toBeCloseTo(previous.energy.stationNetWorkJ, 12)
  expect(station.takeReadyParcel().outcome).toBe('departed')
  expect(station.snapshot().energy.departedJ).toBeCloseTo(1.96133, 12)
  expect(Math.abs(station.snapshot().energy.residualJ)).toBeLessThan(1e-12)
})

test('station admission captures data without invoking caller accessors and rejects invalid declarations privately', () => {
  const input = { atMs: 0, parcel: { id: 'parcel-a', massKg: .1, positionM: [0, 0, 0], velocityMps: [0, 0, 0] }, pickup: { centerM: [0, 0, 0], radiusM: .1 }, destinationM: [1, 0, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 }
  const station = createCargoStationHandler(input), original = station.snapshot()
  input.parcel.positionM[0] = 20; input.parcel.massKg = .2; input.pickup.centerM[0] = 10; input.destinationM[0] = 40
  const detached = station.snapshot()
  detached.parcel!.positionM[0] = 88; detached.impact!.impulseNs[0] = 19; detached.energy.initialJ = 500
  expect(station.snapshot()).toEqual(original)
  expect(station.start()).toEqual({ outcome: 'started', atMs: 0, durationMs: 3752 })
  expect(station.start()).toEqual({ outcome: 'refused', reason: 'not-held' })
  const fresh = { atMs: 0, parcel: { id: 'parcel-a', massKg: .1, positionM: [0, 0, 0], velocityMps: [0, 0, 0] }, pickup: { centerM: [0, 0, 0], radiusM: .1 }, destinationM: [1, 0, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 }
  const getter = structuredClone(fresh)
  let invoked = 0
  Object.defineProperty(getter.parcel, 'positionM', { enumerable: true, get() { invoked++; throw new Error('private-source') } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const bad = [null, {}, { ...fresh, extra: true }, { ...fresh, atMs: 3 }, { ...fresh, atMs: -4 }, { ...fresh, atMs: Number.MAX_SAFE_INTEGER }, { ...fresh, maxSpeedMps: 0 }, { ...fresh, maxAccelerationMps2: Infinity }, { ...fresh, parcel: { ...fresh.parcel, massKg: .251 } }, { ...fresh, parcel: { ...fresh.parcel, positionM: [0, 0, .01] } }, { ...fresh, parcel: { ...fresh.parcel, positionM: [0, 0, -3.01] } }, { ...fresh, parcel: { ...fresh.parcel, velocityMps: [0, 0, NaN] } }, { ...fresh, destinationM: [50, 0, 0] }, getter, revoked.proxy]
  for (const v of bad) expect(() => createCargoStationHandler(v)).toThrow('cargo-station-constructor')
  expect(invoked).toBe(0)
})

test('invalid and exhausted clocks cannot change the parcel, and delayed starts preserve the lifetime bound', () => {
  const config = { atMs: 0, parcel: { id: 'parcel-a', massKg: .1, positionM: [0, 0, 0], velocityMps: [0, 0, 0] }, pickup: { centerM: [0, 0, 0], radiusM: .1 }, destinationM: [1, 0, 0], maxSpeedMps: .5, maxAccelerationMps2: 1 }
  const station = createCargoStationHandler(config), initial = station.snapshot()
  for (const invalid of [0, -4, 1, 8, NaN, Infinity]) expect(() => station.step(invalid)).toThrow('cargo-station-clock')
  expect(() => station.step(4, 'extra')).toThrow('cargo-station-clock')
  expect(() => station.start('extra')).toThrow('cargo-station-arguments')
  expect(() => station.cancel('extra')).toThrow('cargo-station-arguments')
  expect(() => station.takeReadyParcel('extra')).toThrow('cargo-station-arguments')
  expect(station.snapshot()).toEqual(initial)
  for (let atMs = 4; atMs <= 179996; atMs += 4) station.step(atMs)
  const held = station.snapshot()
  expect(station.start()).toEqual({ outcome: 'refused', reason: 'deadline' })
  expect(station.snapshot()).toEqual(held)
  station.step(180000)
  const end = station.snapshot()
  expect(() => station.step(180004)).toThrow('cargo-station-clock')
  expect(station.snapshot()).toEqual(end)
  expect(station.cancel()).toEqual({ outcome: 'cancelled', atMs: 180000 })
  expect(station.takeReadyParcel().outcome).toBe('refused')
})
