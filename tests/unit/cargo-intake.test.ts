import { expect, test } from 'bun:test'
import { createReceivingRigidBody, createRigidBody } from '../../resources/functions/drone/controls/physics'
import type { SensorVector } from '../../resources/functions/drone/sensors/types'
import type { Quaternion } from '../../resources/functions/drone/estimation/frames'

const plus = (a: SensorVector, b: SensorVector) => a.map((n, i) => n + b[i]!) as SensorVector
const minus = (a: SensorVector, b: SensorVector) => a.map((n, i) => n - b[i]!) as SensorVector
const scale = (a: SensorVector, n: number) => a.map(v => v * n) as SensorVector
const cross = (a: SensorVector, b: SensorVector): SensorVector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: SensorVector, b: SensorVector) => a.reduce((sum, n, i) => sum + n * b[i]!, 0)
function rotate([w, x, y, z]: Quaternion, v: SensorVector): SensorVector {
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]].map(row => row.reduce((sum, n, i) => sum + n * v[i]!, 0)) as SensorVector
}
function closeVector(actual: SensorVector, expected: SensorVector) { expect(Math.max(...minus(actual, expected).map(Math.abs))).toBeLessThanOrEqual(2e-12) }
function mechanical(state: ReturnType<ReturnType<typeof createReceivingRigidBody>['snapshot']>, parcel: { massKg: number, positionM: SensorVector, velocityMps: SensorVector }) {
  const origin: SensorVector = [7, -3, 5], inertia: SensorVector = [.03, .03, .05]
  const baseP = scale(state.velocityMps, 1.5), parcelP = scale(parcel.velocityMps, parcel.massKg)
  const spin = rotate(state.quaternionWxyz, state.angularRateRadS.map((n, i) => n * inertia[i]!) as SensorVector)
  return { momentum: plus(baseP, parcelP), angular: plus(spin, plus(cross(minus(state.positionM, origin), baseP), cross(minus(parcel.positionM, origin), parcelP))),
    kinetic: .75 * dot(state.velocityMps, state.velocityMps) + .5 * state.angularRateRadS.reduce((sum, n, i) => sum + inertia[i]! * n * n, 0) + .5 * parcel.massKg * dot(parcel.velocityMps, parcel.velocityMps),
    potential: -9.80665 * (1.5 * state.positionM[2] + parcel.massKg * parcel.positionM[2]) }
}

// Actual physics seam: proves point-load capture and state continuity, not a
// mechanism acknowledgement, vehicle authority or fleet custody protocol.
test('a receiving body captures one coincident point mass with the worked inelastic momentum result', () => {
  const body = createReceivingRigidBody({ positionM: [0, 0, -1], expectedPointLoad: { id: 'parcel-a', massKg: .1, forwardM: .08 } })
  expect(body.loadSnapshot().properties.phase).toBe('awaiting')
  expect(body.loadSnapshot().properties.totalMassKg).toBe(1.5)
  const before = body.snapshot(), point = body.intakePoint()
  expect(point.positionM).toEqual([.08, 0, -1])
  const event = body.attachParcel({ id: 'parcel-a', massKg: .1, positionM: point.positionM, velocityMps: [0, 1, 0] })
  expect(event.outcome).toBe('attached')
  if (event.outcome !== 'attached') throw new Error('Expected actual modeled capture')
  expect(event.before.properties.phase).toBe('awaiting')
  expect(event.after.properties.phase).toBe('attached')
  expect(event.after.properties.totalMassKg).toBe(1.6)
  expect(event.after.properties.cgBodyM).toEqual([.005, 0, 0])
  // Rational expected values allow the binary64 accumulation error, not a model change.
  for (const [i, expected] of [.03, .0306, .0506].entries()) expect(event.after.properties.inertiaDiagonalKgM2[i]!).toBeCloseTo(expected, 14)
  expect(body.snapshot().angularRateRadS[2]).toBeCloseTo(.1482213438735178, 13)
  expect(body.snapshot().velocityMps[1]).toBeCloseTo(.06175889328063241, 13)
  expect(event.energy.kineticBeforeJ).toBeCloseTo(.05, 14)
  expect(event.energy.kineticAfterJ).toBeCloseTo(.003680830039525692, 14)
  expect(event.energy.dissipatedJ).toBeCloseTo(.04631916996047431, 14)
  expect(body.snapshot().positionM).toEqual(before.positionM)
  expect(body.snapshot().quaternionWxyz).toEqual(before.quaternionWxyz)
  expect(body.snapshot().motorsN).toEqual(before.motorsN)
  expect(body.attachParcel({ id: 'parcel-a', massKg: .1, positionM: point.positionM, velocityMps: [0, 1, 0] })).toEqual({ outcome: 'refused', reason: 'intake-consumed' })
  const separated = body.separateCarriedLoad()
  expect(separated.outcome).toBe('separated')
  if (separated.outcome !== 'separated') throw new Error('Expected actual subsequent release')
  expect(mechanical(body.snapshot(), separated.parcel).kinetic).toBeCloseTo(.003680830039525692, 14)
})

test('rotated captures conserve world momentum about an independent origin and dissipate relative motion', () => {
  for (const massKg of [.01, .1, .25]) for (const forwardM of [-.1, 0, .1]) {
    const body = createReceivingRigidBody({ positionM: [1, -2, -1], motorsN: [2, 2, 2, 2], expectedPointLoad: { id: 'parcel-a', massKg, forwardM } })
    for (let i = 0; i < 40; i++) body.step([3, 2.9, 3.1, 3], .004, { windMps: [.2, -.1, 0], torqueNm: [.02, -.01, .03] })
    const before = body.snapshot(), point = body.intakePoint()
    const parcel = { id: 'parcel-a', massKg, ...point, velocityMps: plus(point.velocityMps, [.2, -.3, .1]) }
    closeVector(point.positionM, plus(before.positionM, rotate(before.quaternionWxyz, [forwardM, 0, 0])))
    const initial = mechanical(before, parcel), event = body.attachParcel(parcel)
    expect(event.outcome).toBe('attached')
    if (event.outcome !== 'attached') throw new Error('Expected rotated capture')
    const after = body.snapshot(), afterPoint = { massKg, positionM: plus(after.positionM, rotate(after.quaternionWxyz, [forwardM, 0, 0])), velocityMps: plus(after.velocityMps, rotate(after.quaternionWxyz, cross(after.angularRateRadS, [forwardM, 0, 0]))) }
    const final = mechanical(after, afterPoint)
    closeVector(final.momentum, initial.momentum)
    closeVector(final.angular, initial.angular)
    expect(Math.abs(final.potential - initial.potential)).toBeLessThanOrEqual(2e-12)
    expect(initial.kinetic - final.kinetic).toBeGreaterThan(0)
    expect(event.energy.kineticBeforeJ).toBeCloseTo(initial.kinetic, 12)
    expect(event.energy.kineticAfterJ).toBeCloseTo(final.kinetic, 12)
    expect(event.energy.dissipatedJ).toBeCloseTo(initial.kinetic - final.kinetic, 12)
    expect(event.energy.potentialBeforeJ).toBeCloseTo(initial.potential, 12)
    expect(event.energy.potentialAfterJ).toBeCloseTo(final.potential, 12)
    expect(after.positionM).toEqual(before.positionM)
    expect(after.quaternionWxyz).toEqual(before.quaternionWxyz)
    expect(after.motorsN).toEqual(before.motorsN)
    event.after.bodyVelocityMps[0] = 999; event.parcel.positionM[0] = 999
    expect(body.snapshot()).toEqual(after)
  }
})

test('co-moving intake preserves body motion through a later separation', () => {
  const body = createReceivingRigidBody({ positionM: [0, 0, -1], expectedPointLoad: { id: 'parcel-a', massKg: .1, forwardM: -.08 } })
  for (let i = 0; i < 30; i++) body.step([4, 3.8, 4.1, 4], .004, { torqueNm: [.01, -.02, .03] })
  const before = body.snapshot(), parcel = { id: 'parcel-a', massKg: .1, ...body.intakePoint() }, event = body.attachParcel(parcel)
  expect(event.outcome).toBe('attached')
  if (event.outcome !== 'attached') throw new Error('Expected co-moving capture')
  closeVector(body.snapshot().velocityMps, before.velocityMps)
  closeVector(body.snapshot().angularRateRadS, before.angularRateRadS)
  expect(Math.abs(event.energy.dissipatedJ)).toBeLessThanOrEqual(2e-12)
  const separated = body.separateCarriedLoad()
  expect(separated.outcome).toBe('separated')
  if (separated.outcome !== 'separated') throw new Error('Expected subsequent separation')
  closeVector(separated.parcel.positionM, parcel.positionM)
  closeVector(separated.parcel.velocityMps, parcel.velocityMps)
  closeVector(body.snapshot().velocityMps, before.velocityMps)
  closeVector(body.snapshot().angularRateRadS, before.angularRateRadS)
  expect(body.loadSnapshot().properties.phase).toBe('separated')
  expect(body.loadSnapshot().properties.totalMassKg).toBe(1.5)
  expect(body.attachParcel(parcel)).toEqual({ outcome: 'refused', reason: 'intake-consumed' })
  expect(body.separateCarriedLoad()).toEqual({ outcome: 'refused', reason: 'already-separated' })
})

test('the actual subsequent acceleration uses the received mass and the empty receiver has no phantom load', () => {
  for (const attached of [false, true]) {
    const body = createReceivingRigidBody({ positionM: [0, 0, -1], expectedPointLoad: { id: 'parcel-a', massKg: .1, forwardM: 0 } })
    if (attached) expect(body.attachParcel({ id: 'parcel-a', massKg: .1, ...body.intakePoint() }).outcome).toBe('attached')
    const state = body.step([4, 4, 4, 4], .004), mass = attached ? 1.6 : 1.5
    const thrust = 16 * (1 - Math.exp(-.004 / .04))
    expect(state.accelerationMps2[2]).toBeCloseTo(9.80665 - thrust / mass, 12)
    expect(body.loadSnapshot().properties.totalMassKg).toBe(mass)
  }
})

test('intake refuses foreign or noncoincident parcels without consuming or moving the body', () => {
  const body = createReceivingRigidBody({ positionM: [0, 0, -1], expectedPointLoad: { id: 'parcel-a', massKg: .1, forwardM: .08 } })
  const before = body.snapshot(), point = { id: 'parcel-a', massKg: .1, ...body.intakePoint() }
  expect(body.separateCarriedLoad()).toEqual({ outcome: 'refused', reason: 'awaiting-load' })
  for (const candidate of [{ ...point, id: 'parcel-b' }, { ...point, massKg: .2 }]) expect(body.attachParcel(candidate)).toEqual({ outcome: 'refused', reason: 'unexpected-parcel' })
  expect(body.attachParcel({ ...point, positionM: [.081, 0, -1] })).toEqual({ outcome: 'refused', reason: 'mount-not-coincident' })
  expect(body.snapshot()).toEqual(before)
  expect(body.loadSnapshot().properties.phase).toBe('awaiting')
  expect(body.attachParcel(point).outcome).toBe('attached')
})

test('intake captures exact own data and malformed input cannot evaluate getters or mutate state', () => {
  const body = createReceivingRigidBody({ positionM: [0, 0, -1], expectedPointLoad: { id: 'parcel-a', massKg: .1, forwardM: 0 } })
  const before = body.snapshot(), point = { id: 'parcel-a', massKg: .1, ...body.intakePoint() }
  let called = false
  const accessor = { ...point, get velocityMps() { called = true; return [0, 0, 0] } }
  const tuple = [0, 0, 0]; Object.defineProperty(tuple, '0', { enumerable: true, get() { called = true; return 0 } })
  for (const value of [null, { ...point, extra: true }, { ...point, massKg: NaN }, { ...point, velocityMps: [0, Infinity, 0] }, accessor, { ...point, velocityMps: tuple }, { ...point, positionM: [, 0, -1] }]) expect(() => body.attachParcel(value)).toThrow('cargo-intake-parcel')
  const proxy = new Proxy(point, { ownKeys() { throw new Error('private-caller-sentinel') } })
  expect(() => body.attachParcel(proxy)).toThrow(/^cargo-intake-parcel$/)
  expect(() => Reflect.apply(body.attachParcel, body, [point, true])).toThrow('cargo-intake-parcel')
  expect(called).toBe(false)
  expect(body.snapshot()).toEqual(before)
  expect(body.loadSnapshot().properties.phase).toBe('awaiting')
  expect(() => createReceivingRigidBody({ expectedPointLoad: { get id() { called = true; return 'parcel-a' }, massKg: .1, forwardM: 0 } })).toThrow()
  expect(called).toBe(false)
  expect(body.attachParcel(point).outcome).toBe('attached')
})

test('joint contact is current physical state and the planned identity is captured once', () => {
  const expected = { id: 'parcel-a', massKg: .1, forwardM: .08 }
  const body = createReceivingRigidBody({ positionM: [0, 0, -1], expectedPointLoad: expected })
  const stale = { id: 'parcel-a', massKg: .1, ...body.intakePoint() }
  expected.id = 'parcel-b'; expected.massKg = .2; expected.forwardM = -.08
  body.step([0, 0, 0, 0], .004)
  expect(body.attachParcel(stale)).toEqual({ outcome: 'refused', reason: 'mount-not-coincident' })
  expect(body.loadSnapshot().properties.phase).toBe('awaiting')
  const current = { id: 'parcel-a', massKg: .1, ...body.intakePoint() }
  expect(body.attachParcel(current).outcome).toBe('attached')
  expect(body.loadSnapshot().properties.forwardM).toBe(.08)
})

test('legacy body factories keep their original methods and attached/separated phases', () => {
  expect(Object.keys(createRigidBody())).toEqual(['snapshot', 'step'])
  const legacy = createRigidBody({ carriedPointLoad: { id: 'parcel-a', massKg: .1, forwardM: .08 } })
  expect(Object.keys(legacy)).toEqual(['snapshot', 'step', 'loadSnapshot', 'separateCarriedLoad'])
  expect(legacy.loadSnapshot().properties.phase).toBe('attached')
  expect(legacy.separateCarriedLoad().outcome).toBe('separated')
  expect(legacy.loadSnapshot().properties.phase).toBe('separated')
})
