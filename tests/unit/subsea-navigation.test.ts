import { expect, test } from 'bun:test'
import type { EstimatorSnapshot } from '../../resources/functions/drone/estimation/estimator'
import type { VehiclePlantState } from '../../resources/functions/drone/vehicles/types'
import { createSubseaNavigation, pressureDepthM } from '../../resources/functions/drone/vehicles/subsea/navigation'
import { qualifySubseaMeasurement, renderSubseaMeasurement } from '../../resources/functions/drone/vehicles/subsea/sensors'

const reference = '55:0,0,0,0,0'
function truth(): VehiclePlantState { const state = moving(); state.positionM = [0, 0, 0]; state.velocityMps = [0, 0, 0]; state.onSurface = true; return state }
function base(nowMs: number, yaw = 0): EstimatorSnapshot {
  return { nowMs, bootId: 55n, evidence: 'fixture', physicalFlightEnabled: false, health: { tilt: true, absoluteHeading: false, localPosition: false, pressureHeight: false, navigation: false }, quality: ['bench-estimator', 'absolute-heading-unobservable', 'gnss-unhealthy'], attitude: { reference: 'GRAVITY_ALIGNED_RELATIVE_YAW', quaternionWxyz: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], eulerRad: [0, 0, yaw], capturedAtMs: nowMs, covarianceRad2: null, absoluteHeadingObserved: false }, localPosition: null, pressureHeight: null, resets: { attitude: 0, position: 0, boot: 0, manual: 0, clock: 0 }, events: [] }
}
function moving(): VehiclePlantState {
  return { positionM: [0, 0, 2], velocityMps: [0, 1, 0], accelerationMps2: [0, 0, 0], quaternionWxyz: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], angularRateRadS: [0, 0, 0], onSurface: false, details: { tetherLengthM: 2.2, tetherTensionN: 1, bottomRangeM: 8, structureRangeM: 3, leak: false, linkConnected: true, dvlLocked: true } }
}

test('pressure depth and DVL body velocity use the declared local water surface and capture attitude', () => {
  // 101325 Pa atmosphere + 1025 kg/m3 * 9.80665 m/s2 * 2 m = 121428.6325 Pa.
  expect(pressureDepthM(121428.6325, 101325, 1025)).toBeCloseTo(2, 10)
  const nav = createSubseaNavigation()
  for (let t = 0; t <= 60; t += 4) nav.update(base(t, Math.PI / 2), null, t)
  nav.update(base(60, Math.PI / 2), renderSubseaMeasurement(truth(), 0, reference, 1), 60)
  for (let t = 64; t < 80; t += 4) nav.update(base(t, Math.PI / 2), null, t)
  const packet = renderSubseaMeasurement(moving(), 20, reference, 2)
  expect(packet.values.dvlVelocityBodyMps).toEqual([1, 0, 0])
  const first = nav.update(base(80, 0), packet, 80)
  expect(first.health.localPosition).toBe(true)
  expect(first.health.absoluteHeading).toBe(false)
  expect(first.localPosition?.altitudeDatum).toBe('LOCAL_WATER_SURFACE')
  expect(first.localPosition?.velocityMps[0]).toBeCloseTo(0, 8)
  expect(first.localPosition?.velocityMps[1]).toBeCloseTo(1, 8)
  expect(first.localPosition?.positionM[2]).toBeCloseTo(2, 7)
  expect(first.localPosition?.capturedAtMs).toBe(20)
  expect(first.localPosition?.predictedToMs).toBe(80)
})

test('retained packets are idempotent and capture integration uncertainty grows without GNSS correction', () => {
  const nav = createSubseaNavigation(), state = truth()
  for (let t = 0; t <= 60; t += 4) nav.update(base(t, Math.PI / 2), null, t)
  const firstPacket = renderSubseaMeasurement(state, 0, reference, 1)
  const first = nav.update(base(60, Math.PI / 2), firstPacket, 60)
  expect(nav.update(base(60, Math.PI / 2), firstPacket, 60)).toEqual(first)
  const initialVariance = first.localPosition!.covarianceBlocks[0]!.positionM2
  let result = first
  for (let t = 64; t <= 1060; t += 4) {
    const capture = Math.floor((t - 60) / 20) * 20
    result = nav.update(base(t, Math.PI / 2), renderSubseaMeasurement(capture === 0 ? state : moving(), capture, reference, capture / 20 + 1), t)
    // Runtime policy can read twice at the same local clock without integrating twice.
    if (t % 20 === 0) expect(nav.update(base(t, Math.PI / 2), renderSubseaMeasurement(capture === 0 ? state : moving(), capture, reference, capture / 20 + 1), t)).toEqual(result)
  }
  expect(result.localPosition!.positionM[0]).toBeCloseTo(0, 8)
  expect(result.localPosition!.positionM[1]).toBeCloseTo(1.05, 8)
  expect(result.localPosition!.covarianceBlocks[0]!.positionM2).toBeGreaterThan(initialVariance)
  expect(result.health.absoluteHeading).toBe(false)
  expect(result.quality).toContain('surface-origin-initial-alignment-assumed')
})

test('qualified subsea records reject invalid calibration, timing, finite quantities and modeled frame identity', () => {
  const good = renderSubseaMeasurement(truth(), 0, reference, 1)
  expect(qualifySubseaMeasurement(good, 60, reference)).toEqual(good)
  for (const mutate of [
    (m: typeof good) => { m.values.calibration = 'different' },
    (m: typeof good) => { m.values.clockSigmaMs = 0 },
    (m: typeof good) => { m.values.pressurePa = NaN },
    (m: typeof good) => { m.values.pressurePa = 0 },
    (m: typeof good) => { m.values.waterDensityKgM3 = 1000 },
    (m: typeof good) => { m.values.dvlVelocityBodyMps = [Infinity, 0, 0] },
    (m: typeof good) => { m.values.angularRateBodyRadS = [35, 35, 0] },
    (m: typeof good) => { m.values.cameraLuma = [1] },
    (m: typeof good) => { m.values.tetherTensionN = -1 },
    (m: typeof good) => { m.reference = '1:0,0,0,0,0' },
    (m: typeof good) => { m.receivedAtMs = 61 },
  ]) {
    const bad = structuredClone(good); mutate(bad)
    expect(qualifySubseaMeasurement(bad, 60, reference)).toBe(null)
  }
  expect(qualifySubseaMeasurement(good, 59)).toBe(null)
  expect(qualifySubseaMeasurement(good, 120)).toBe(null)
  expect(() => pressureDepthM(101325, 101325, 0)).toThrow()
  expect(() => pressureDepthM(Infinity, 101325, 1025)).toThrow()
})

test('navigation loss latches after initialization and cannot revive on healthy retained or replacement records', () => {
  for (const fault of ['bottom-lock', 'pressure', 'mutation', 'reorder', 'base-reset', 'imu', 'clock-gap', 'capture-gap', 'stale', 'future']) {
    const nav = createSubseaNavigation()
    for (let t = 0; t <= 60; t += 4) nav.update(base(t), null, t)
    const state = truth(), initial = renderSubseaMeasurement(state, 0, reference, 1)
    expect(nav.update(base(60), initial, 60).health.localPosition).toBe(true)
    const at = fault === 'clock-gap' ? 104 : fault === 'capture-gap' || fault === 'stale' ? 124 : 80
    for (let t = 64; t < at; t += 4) if (fault !== 'clock-gap') nav.update(base(t), initial, t)
    const b = base(at), m = renderSubseaMeasurement(state, at - 60, reference, 2)
    if (fault === 'bottom-lock') m.values.dvlLocked = false
    if (fault === 'pressure') m.values.pressurePa = 0
    if (fault === 'mutation') { Object.assign(m, initial); m.values = { ...initial.values, bottomRangeM: 7 } }
    if (fault === 'reorder') { m.sequence = 1; m.capturedAtMs = 20; m.receivedAtMs = 80 }
    if (fault === 'base-reset') b.resets.boot++
    if (fault === 'imu') b.health.tilt = false
    if (fault === 'stale') Object.assign(m, initial)
    if (fault === 'future') m.receivedAtMs = at + 1
    const failed = nav.update(b, m, at)
    expect(failed.health.localPosition).toBe(false)
    const recoveredAt = at + 20
    expect(nav.update(base(recoveredAt), renderSubseaMeasurement(state, recoveredAt - 60, reference, 3), recoveredAt).health.localPosition).toBe(false)
  }
})

test('warmup without an attitude or packet does not permanently poison later owned alignment', () => {
  const nav = createSubseaNavigation()
  for (let t = 0; t < 400; t += 4) {
    const b = base(t); b.attitude = null; b.health.tilt = false
    expect(nav.update(b, null, t).health.localPosition).toBe(false)
  }
  for (let t = 400; t <= 460; t += 4) nav.update(base(t), null, t)
  expect(nav.update(base(460), renderSubseaMeasurement(truth(), 400, reference, 1), 460).health.localPosition).toBe(true)
})

test('local horizontal origin cannot initialize from an underwater or moving unaligned position', () => {
  for (const state of [moving(), { ...truth(), onSurface: false }, { ...truth(), velocityMps: [0.1, 0, 0] as [number, number, number] }]) {
    const nav = createSubseaNavigation()
    for (let t = 0; t <= 60; t += 4) nav.update(base(t), null, t)
    const waiting = nav.update(base(60), renderSubseaMeasurement(state, 0, reference, 1), 60)
    expect(waiting.health.localPosition).toBe(false)
    expect(waiting.localPosition).toBe(null)
    for (let t = 64; t <= 80; t += 4) nav.update(base(t), null, t)
    expect(nav.update(base(80), renderSubseaMeasurement(truth(), 20, reference, 2), 80).health.localPosition).toBe(true)
  }
  const alteredId = renderSubseaMeasurement(truth(), 0, reference, 1)
  alteredId.values.cameraFrameId = 'subsea-model-2-0'
  expect(qualifySubseaMeasurement(alteredId, 60)).toBe(null)
})

test('nonfinite or reversed clocks latch loss while retaining finite inspectable navigation state', () => {
  for (const badTime of [NaN, Infinity, 59]) {
    const nav = createSubseaNavigation()
    for (let t = 0; t <= 60; t += 4) nav.update(base(t), null, t)
    const packet = renderSubseaMeasurement(truth(), 0, reference, 1)
    expect(nav.update(base(60), packet, 60).health.localPosition).toBe(true)
    const failed = nav.update(base(badTime), packet, badTime)
    expect(failed.health.localPosition).toBe(false)
    expect(failed.nowMs).toBe(60)
    expect(failed.localPosition!.positionM.every(Number.isFinite)).toBe(true)
    expect(nav.update(base(80), renderSubseaMeasurement(truth(), 20, reference, 2), 80).health.localPosition).toBe(false)
  }
})

test('DVL lock loss preserves independently fresh pressure height without reviving horizontal navigation', () => {
  const nav = createSubseaNavigation()
  for (let t = 0; t <= 60; t += 4) nav.update(base(t), null, t)
  nav.update(base(60), renderSubseaMeasurement(truth(), 0, reference, 1), 60)
  for (let t = 64; t <= 80; t += 4) nav.update(base(t), null, t)
  const packet = renderSubseaMeasurement(moving(), 20, reference, 2)
  packet.values.dvlLocked = false
  const loss = nav.update(base(80), packet, 80)
  expect(loss.health.localPosition).toBe(false)
  expect(loss.health.pressureHeight).toBe(true)
  expect(loss.pressureHeight?.downM).toBeCloseTo(2, 7)
  expect(loss.pressureHeight?.capturedAtMs).toBe(20)
  expect(loss.pressureHeight?.varianceM2).toBe(0.0001)
  packet.values.dvlLocked = true
  expect(nav.update(base(80), packet, 80).health.localPosition).toBe(false)
})
