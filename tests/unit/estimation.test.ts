import { describe, expect, test } from 'bun:test'
import { geodeticToEcef, geodeticToNed } from '../../resources/functions/drone/estimation/frames'

describe('owned estimator frames', () => {
  test('GeographicLib reference, ellipsoid height and NED axes agree', () => {
    const point = { latitudeDeg: 33.3, longitudeDeg: 44.4, ellipsoidHeightM: 6000 }
    const result = geodeticToEcef(point)
    expect(result[0]).toBeCloseTo(3816209.60, 2)
    expect(result[1]).toBeCloseTo(3737108.55, 2)
    expect(result[2]).toBeCloseTo(3485109.57, 2)
    const local = geodeticToNed(point, { latitudeDeg: 33, longitudeDeg: 44, ellipsoidHeightM: 20 })
    expect(Math.abs(local[0] - 33374.29)).toBeLessThan(0.01)
    expect(Math.abs(local[1] - 37288.97)).toBeLessThan(0.01)
    expect(Math.abs(local[2] + 5783.64)).toBeLessThan(0.01)
    const origin = { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }
    expect(geodeticToNed({ ...origin, ellipsoidHeightM: 110 }, origin)).toEqual([0, 0, -10])
    expect(geodeticToNed({ ...origin, latitudeDeg: 0.001 }, origin)[0]).toBeGreaterThan(110)
    expect(geodeticToNed({ ...origin, longitudeDeg: 0.001 }, origin)[1]).toBeGreaterThan(111)
    expect(() => geodeticToEcef({ ...origin, latitudeDeg: 91 })).toThrow()
  })
})

import { createEstimator } from '../../resources/functions/drone/estimation/estimator'
import type { SensorSnapshot } from '../../resources/functions/drone/sensors/pipeline'
import type { SensorObservation } from '../../resources/functions/drone/sensors/types'
function sample(nowMs: number, value: SensorObservation['value'], kind: SensorObservation['kind'] = 'imu', sequence = Math.round(nowMs / 20) + 1): SensorSnapshot {
  const observation: SensorObservation = { kind, deviceId: `test/${kind}`, sequence, capturedUs: BigInt(Math.round(nowMs * 1000)), receivedAtMs: nowMs, estimatedCaptureMs: nowMs, measurementAgeUpperMs: 0, transportAgeUpperMs: 0, timeUncertaintyUs: 0, healthy: true, quality: ['synthetic-fixture', 'calibration-fixture'], calibrationId: 'fixture', value }
  return { nowMs, bootId: 1n, evidence: 'fixture', physicalFlightEnabled: false, rejected: 0, sensors: [{ kind, healthy: true, quality: observation.quality, observation }] }
}
const imu = (force: [number, number, number] = [0, 0, -9.80665], rates: [number, number, number] = [0, 0, 0]) => ({ frame: 'BODY_FRD' as const, temperatureC: 25, specificForceMps2: force, angularRateRadS: rates, specificForceVariance: [0.001, 0.001, 0.001] as [number, number, number], angularRateVariance: [0.000001, 0.000001, 0.000001] as [number, number, number] })
test('stationary tilt aligns BODY_FRD without inventing absolute heading', () => {
  const estimator = createEstimator()
  for (let t = 0; t <= 500; t += 20) estimator.update(sample(t, imu([0, -4.903325, -8.492808026])) )
  const result = estimator.snapshot(500)
  expect(result.attitude!.eulerRad[0]).toBeCloseTo(Math.PI / 6, 6)
  expect(result.attitude!.eulerRad[1]).toBeCloseTo(0, 6)
  expect(result.health.tilt).toBe(true)
  expect(result.health.absoluteHeading).toBe(false)
  expect(result.physicalFlightEnabled).toBe(false)
})

import motion from '../fixtures/estimation/motion-v1.json'
import truth from '../fixtures/estimation/truth-v1.json'
import { createEstimatorReplay } from '../../resources/functions/drone/estimation/replay'
import { createSimulator } from '../../resources/functions/drone/simulator'

test('analytic wire motion measures attitude and position errors at capture epochs', () => {
  const replay = createEstimatorReplay(motion)
  let maximumAngle = 0, maximumPosition = 0
  for (const row of truth.truth.slice(25)) {
    const result = replay.advanceTo(row.atMs + 40).estimate
    expect(result.health.tilt).toBe(true)
    expect(result.health.localPosition).toBe(true)
    const target = truth.truth.find(t => t.atMs === result.attitude!.capturedAtMs)!
    for (let i = 0; i < 3; i++) maximumAngle = Math.max(maximumAngle, Math.abs(result.attitude!.eulerRad[i]! - target.eulerRad[i]!))
    const at = result.localPosition!.predictedToMs / 1000
    maximumPosition = Math.max(maximumPosition, Math.hypot(...result.localPosition!.positionM.map((v, i) => v - [2 * at, at, -0.5 * at][i]!)))
  }
  expect(maximumAngle).toBeLessThan(0.03)
  expect(maximumPosition).toBeLessThan(0.08)
})
test('replay is identical for one large step and arbitrary playback chunks', () => {
  const single = createEstimatorReplay(motion), chunks = createEstimatorReplay(motion)
  for (let at = 37; at < 6040; at += 37) chunks.advanceTo(at)
  expect(chunks.advanceTo(6040)).toEqual(single.advanceTo(6040))
  const sim = createSimulator({ estimatorReplay: createEstimatorReplay(motion) }); sim.command('start')
  for (let i = 0; i < 6; i++) sim.step(1000)
  expect(sim.snapshot().estimate!.health.tilt).toBe(true)
  const paused = sim.command('pause').estimate; sim.step(200)
  expect(sim.snapshot().estimate).toEqual(paused)
  expect(single.advanceTo(601000).estimate.health.localPosition).toBe(false)
})

const gnss = (north = 0, east = 0, up = 0) => ({ frame: 'WGS84_GEODETIC_NED_VELOCITY' as const, sourceTowMs: 100000, latitudeDeg: north / 6335539.3272928195 * 180 / Math.PI, longitudeDeg: east / 6378237 * 180 / Math.PI, ellipsoidHeightM: 100 + up, mslHeightM: 70 + up, velocityNedMps: [2, 1, -0.5] as [number, number, number], positionVarianceNedM2: [0.04, 0.04, 0.09] as [number, number, number], velocityVarianceNedM2S2: [0.0004, 0.0004, 0.0004] as [number, number, number] })
function aligned() {
  const estimator = createEstimator()
  for (let t = 0; t <= 500; t += 20) estimator.update(sample(t, imu()))
  return estimator
}
test('right-handed gyro integration follows a 90 degree yaw turn and keeps heading unobserved', () => {
  const estimator = aligned()
  for (let t = 520; t <= 2500; t += 20) estimator.update(sample(t, imu(undefined, [0, 0, Math.PI / 4])))
  const result = estimator.snapshot(2500)
  expect(result.attitude!.eulerRad[2]).toBeCloseTo(Math.PI / 2, 8)
  expect(result.health.absoluteHeading).toBe(false)
  expect(Math.hypot(...result.attitude!.quaternionWxyz)).toBeCloseTo(1, 12)
  expect(result.attitude!.covarianceRad2).toBeNull()
})
test('dynamic acceleration suppresses gravity correction and outages require realignment', () => {
  const estimator = aligned()
  const accelerated = estimator.update(sample(520, imu([0, 0, -19.6133])))
  expect(accelerated.quality).toContain('gravity-correction-suppressed')
  expect(estimator.snapshot(700).health.tilt).toBe(false)
  expect(estimator.update(sample(800, imu())).attitude).toBeNull()
  for (let t = 820; t <= 1200; t += 20) estimator.update(sample(t, imu()))
  expect(estimator.snapshot(1200).health.tilt).toBe(true)
  expect(estimator.snapshot(1200).resets.attitude).toBe(1)
  const rebooted = estimator.update({ ...sample(1220, imu()), bootId: 2n })
  expect(rebooted.attitude).toBeNull()
  expect(rebooted.resets.boot).toBe(1)
})
test('bad quality, mounting, covariance and source replay cannot sustain attitude', () => {
  for (const fault of ['unknown-age', 'wrong-frame', 'invalid-noise', 'overrun', 'replay', 'identity']) {
    const estimator = aligned(), input = sample(520, imu()), o = input.sensors[0]!.observation!
    if (fault === 'unknown-age') o.measurementAgeUpperMs = null
    if (fault === 'wrong-frame') (o.value as ReturnType<typeof imu>).frame = 'SENSOR_XYZ' as 'BODY_FRD'
    if (fault === 'invalid-noise') (o.value as ReturnType<typeof imu>).angularRateVariance[0] = NaN
    if (fault === 'overrun') o.quality.push('stream-overrun')
    if (fault === 'replay') { o.sequence = 1; o.capturedUs = 0n }
    if (fault === 'identity') o.calibrationId = 'new-mount'
    expect(estimator.update(input).health.tilt).toBe(false)
  }
})
test('clock reversal and explicit reset clear state without rewinding the consumer clock', () => {
  const estimator = aligned()
  expect(() => estimator.snapshot(499)).toThrow('monotonic')
  expect(estimator.snapshot(501).attitude).toBeNull()
  expect(estimator.snapshot(501).resets.clock).toBe(1)
  expect(estimator.reset(502).resets.manual).toBe(1)
  expect(() => createEstimator({ origin: { latitudeDeg: NaN, longitudeDeg: 0, ellipsoidHeightM: 0 } })).toThrow()
})
test('GNSS local constant-velocity estimates reject jumps and reset on reacquisition in the same origin', () => {
  const estimator = createEstimator()
  estimator.update(sample(0, gnss(), 'gnss', 1))
  const predicted = estimator.snapshot(500).localPosition!
  expect(predicted.positionM).toEqual([1, 0.5, -0.25])
  expect(predicted.altitudeDatum).toBe('WGS84_ELLIPSOID')
  const update = estimator.update(sample(1000, gnss(2, 1, 0.5), 'gnss', 2))
  expect(update.localPosition!.positionM[0]).toBeCloseTo(2, 5)
  const jump = estimator.update(sample(1100, gnss(1000, 0), 'gnss', 3))
  expect(jump.quality).toContain('gnss-innovation-rejected')
  expect(jump.health.localPosition).toBe(false)
  expect(jump.localPosition!.positionM[0]).toBeLessThan(3)
  expect(estimator.update(sample(1200, gnss(2.4, 1.2, 0.6), 'gnss', 4)).health.localPosition).toBe(true)
  expect(estimator.snapshot(3000).health.localPosition).toBe(false)
  const recovered = estimator.update(sample(3200, gnss(6.4, 3.2, 1.6), 'gnss', 5))
  expect(recovered.health.localPosition).toBe(true)
  expect(recovered.resets.position).toBe(1)
  expect(recovered.localPosition!.origin).toEqual({ latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 })
  expect(recovered.localPosition!.positionM[0]).toBeCloseTo(6.4, 4)
  expect(recovered.health.absoluteHeading).toBe(false)
})
test('MSL changes cannot move ellipsoid position, and unaligned GNSS is rejected', () => {
  const first = createEstimator(), second = createEstimator(), value = gnss()
  const altered = { ...value, mslHeightM: -2000 }
  expect(first.update(sample(0, value, 'gnss')).localPosition).toEqual(second.update(sample(0, altered, 'gnss')).localPosition)
  const unknown = sample(10, value, 'gnss'); unknown.sensors[0]!.observation!.timeUncertaintyUs = null
  expect(createEstimator().update(unknown).localPosition).toBeNull()
  const outside = createEstimator({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 } }).update(sample(0, gnss(6000), 'gnss'))
  expect(outside.health.localPosition).toBe(false)
  expect(outside.quality).toContain('outside-local-frame')
})
test('position covariance blocks stay positive semidefinite through repeated corrections', () => {
  const estimator = createEstimator()
  for (let i = 0; i < 200; i++) {
    const t = i / 10, result = estimator.update(sample(i * 100, gnss(2 * t, t, 0.5 * t), 'gnss', i + 1))
    for (const block of result.localPosition!.covarianceBlocks) {
      expect(block.positionM2).toBeGreaterThan(0)
      expect(block.velocityM2S2).toBeGreaterThan(0)
      expect(block.positionM2 * block.velocityM2S2 - block.positionVelocityM2S ** 2).toBeGreaterThanOrEqual(0)
    }
  }
})
test('pressure height has a separate relative datum and expires independently', () => {
  const estimator = createEstimator()
  estimator.update(sample(0, { pressurePa: 101325, temperatureC: 15, variancePa2: 4 }, 'barometer', 1))
  const result = estimator.update(sample(200, { pressurePa: 100129.4, temperatureC: 15, variancePa2: 4 }, 'barometer', 2))
  expect(result.pressureHeight!.downM).toBeCloseTo(-100, 1)
  expect(result.pressureHeight!.frame).toBe('PRESSURE_RELATIVE_INITIAL')
  expect(result.localPosition).toBeNull()
  expect(estimator.snapshot(501).health.pressureHeight).toBe(false)
})

import { nedRotation } from '../../resources/functions/drone/estimation/frames'
import { command } from '@stacksjs/testing'
test('velocity basis rotates into fixed NED even where longitude axes diverge', () => {
  const rotation = nedRotation({ latitudeDeg: 0, longitudeDeg: 90, ellipsoidHeightM: 0 }, { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 0 })
  expect(rotation[0]![0]).toBeCloseTo(1, 12)
  expect(rotation[2]![1]).toBeCloseTo(1, 12)
  expect(rotation[1]![2]).toBeCloseTo(-1, 12)
})
test('native Stacks estimator CLI runs recorded input and rejects invalid time', async () => {
  const result = await command(['estimator:replay', 'tests/fixtures/estimation/motion-v1.json', '--at-ms', '6000']).withTimeout(10000)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout).estimate.health.tilt).toBe(true)
  const invalid = await command(['estimator:replay', 'tests/fixtures/estimation/motion-v1.json', '--at-ms', 'nan']).withTimeout(10000)
  expect(invalid.exitCode).toBe(1)
}, 20000)

test('a wire-level IMU outage clears attitude and requires rest even after packets return', () => {
  const interrupted = structuredClone(motion)
  interrupted.records = interrupted.records.filter(row => {
    const b = Uint8Array.fromHex(row.hex), v = new DataView(b.buffer)
    const at = Number(v.getBigUint64(16, true) - 1000000n) / 1000
    return b[3] !== 1 || at < 2000 || at >= 2400
  })
  const replay = createEstimatorReplay(interrupted)
  const lost = replay.advanceTo(2250).estimate
  expect(lost.health.tilt).toBe(false)
  expect(lost.health.localPosition).toBe(true)
  const restored = replay.advanceTo(3000).estimate
  expect(restored.health.tilt).toBe(false)
  expect(restored.attitude).toBeNull()
  expect(restored.health.localPosition).toBe(true)
  expect(restored.resets.attitude).toBeGreaterThan(0)
  expect(restored.events.some(e => e.reason === 'imu-unhealthy')).toBe(true)
})
test('unobserved yaw bias drifts explicitly rather than being replaced with GNSS course', () => {
  const estimator = aligned()
  for (let t = 520; t <= 4500; t += 20) estimator.update(sample(t, imu(undefined, [0, 0, 0.02])))
  expect(estimator.snapshot(4500).attitude!.eulerRad[2]).toBeCloseTo(0.08, 8)
  expect(estimator.snapshot(4500).health.absoluteHeading).toBe(false)
})

test('qualified clock corrections do not change gyro or GNSS measurement intervals', () => {
  const base = createEstimatorReplay(motion).advanceTo(4020).estimate
  for (const correction of [-5, 5]) {
    const shifted = structuredClone(motion)
    shifted.anchors[0]!.receivedAtMs = 4005
    shifted.anchors[0]!.anchor.localMs = 4000 + correction
    shifted.anchors[0]!.anchor.uncertaintyUs = 10000
    const result = createEstimatorReplay(shifted).advanceTo(4020).estimate
    expect(result.attitude!.quaternionWxyz).toEqual(base.attitude!.quaternionWxyz)
    expect(result.localPosition!.covarianceBlocks).not.toEqual(base.localPosition!.covarianceBlocks) // Snapshot epoch projection changes, measurement intervals do not.
    expect(result.localPosition!.capturedAtMs).toBe(base.localPosition!.capturedAtMs! + correction)
  }
})
test('retained samples adopt tighter expiry after clock uncertainty grows', () => {
  const estimator = aligned(), input = sample(520, imu())
  estimator.update(input)
  const changed = structuredClone(input); changed.nowMs = 540
  changed.sensors[0]!.observation!.measurementAgeUpperMs = 60
  changed.sensors[0]!.observation!.timeUncertaintyUs = 40000
  estimator.update(changed)
  expect(estimator.snapshot(561).health.tilt).toBe(false)
})
test('pressure datum resets on calibration/boot changes and fixture calibration cannot qualify physical sources', () => {
  const estimator = createEstimator()
  estimator.update(sample(0, { pressurePa: 100000, temperatureC: 25, variancePa2: 4 }, 'barometer', 1))
  const changed = sample(200, { pressurePa: 99000, temperatureC: 25, variancePa2: 4 }, 'barometer', 2)
  changed.sensors[0]!.observation!.calibrationId = 'other-pressure'
  expect(estimator.update(changed).pressureHeight!.downM).toBe(0)
  const reboot = { ...sample(400, { pressurePa: 98000, temperatureC: 25, variancePa2: 4 }, 'barometer', 1), bootId: 2n }
  expect(estimator.update(reboot).pressureHeight!.referencePa).toBe(98000)
  const physical = { ...sample(0, imu()), evidence: 'handshake' as const }
  expect(createEstimator().update(physical).health.tilt).toBe(false)
})
