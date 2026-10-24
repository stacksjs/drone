import { expect, test } from 'bun:test'
import { createEstimator } from '../../resources/functions/drone/estimation/estimator'
import { createPhysicsSensorFeed } from '../../resources/functions/drone/controls/sensors'

// Public estimator seam through actual modeled raw packets and calibration.
// Analytic acceleration is the independent oracle, never an estimator input.
test('fixture IMU prediction carries acceleration between GNSS fixes without refreshing their source', () => {
  const feed = createPhysicsSensorFeed(0)
  const estimator = createEstimator({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  for (let atMs = 0; atMs <= 788; atMs += 4) {
    const t = Math.max(0, (atMs - 600) / 1000)
    feed.capture({ positionM: [0.5 * t * t, 0, 0], velocityMps: [t, 0, 0], accelerationMps2: [atMs >= 600 ? 1 : 0, 0, 0], quaternionWxyz: [1, 0, 0, 0], angularRateRadS: [0, 0, 0] }, atMs)
    estimator.update(feed.advanceTo(atMs))
  }
  const result = estimator.snapshot(788), p = result.localPosition!
  expect(p.velocityMps[0]).toBeCloseTo(0.188, 2)
  expect(Math.abs(p.positionM[0]! - 0.017672)).toBeLessThan(0.02)
  expect(p.capturedAtMs).toBe(700)
  expect(p.predictedToMs).toBe(788)
  expect(result.quality).toContain('fixture-inertial-position-prediction')
  expect(result.health.absoluteHeading).toBe(false)
  expect(result.physicalFlightEnabled).toBe(false)
})

test('a sparse calibrated force sample revokes inertial navigation without a constant-velocity fallback', () => {
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  const stationary = { positionM: [0, 0, 0] as [number, number, number], velocityMps: [0, 0, 0] as [number, number, number], accelerationMps2: [0, 0, 0] as [number, number, number], quaternionWxyz: [1, 0, 0, 0] as [number, number, number, number], angularRateRadS: [0, 0, 0] as [number, number, number] }
  for (let at = 0; at <= 620; at += 4) { feed.capture(stationary, at); estimator.update(feed.advanceTo(at)) }
  const input = feed.advanceTo(624)
  const value = input.sensors.find(row => row.kind === 'imu')!.observation!.value!
  if (!('specificForceMps2' in value)) throw new TypeError('Expected calibrated IMU')
  Reflect.deleteProperty(value.specificForceMps2, '0')
  const result = estimator.update(input)
  expect(result.health.tilt).toBe(false)
  expect(result.health.localPosition).toBe(false)
  expect(result.localPosition).toBeNull()
})

test('fixture IMU mode rejects explicit null and physical evidence', () => {
  expect(() => createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: null as never })).toThrow('prediction mode')
  const estimator = createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  const input = createPhysicsSensorFeed(0).advanceTo(0)
  expect(() => estimator.update({ ...input, evidence: 'handshake' })).toThrow('fixture evidence')
  expect(estimator.snapshot(0).localPosition).toBeNull()
})

function stationaryState() {
  return { positionM: [0, 0, 0] as [number, number, number], velocityMps: [0, 0, 0] as [number, number, number], accelerationMps2: [0, 0, 0] as [number, number, number], quaternionWxyz: [1, 0, 0, 0] as [number, number, number, number], angularRateRadS: [0, 0, 0] as [number, number, number] }
}

test('an IMU outage withdraws fixture prediction while fresh GNSS remains available', () => {
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  for (let at = 0; at <= 800; at += 4) { feed.capture(stationaryState(), at, at > 600); estimator.update(feed.advanceTo(at)) }
  const result = estimator.snapshot(800)
  expect(result.health.tilt).toBe(false)
  expect(result.health.localPosition).toBe(false)
  expect(result.localPosition).toBeNull()
  expect(result.resets.attitude).toBeGreaterThan(0)
})

test('IMU prediction never refreshes an absent GNSS fix or extends its original age bound', () => {
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  for (let at = 0; at <= 2000; at += 4) { feed.capture(stationaryState(), at, false, at > 600); estimator.update(feed.advanceTo(at)) }
  expect(estimator.snapshot(2000).localPosition!.capturedAtMs).toBe(600)
  for (let at = 2004; at <= 2200; at += 4) { feed.capture(stationaryState(), at, false, true); estimator.update(feed.advanceTo(at)) }
  const result = estimator.snapshot(2200)
  expect(result.health.localPosition).toBe(false)
  expect(result.localPosition).toBeNull()
})

test('retained sensor refreshes do not integrate an IMU sample twice', () => {
  const feed = createPhysicsSensorFeed(0), options = { gravityCorrection: 'initialization-only' as const, positionPrediction: 'fixture-imu' as const }
  const frequent = createEstimator(options), sparse = createEstimator(options)
  for (let at = 0; at <= 788; at += 4) {
    const t = Math.max(0, (at - 600) / 1000)
    feed.capture({ ...stationaryState(), positionM: [0.5 * t * t, 0, 0], velocityMps: [t, 0, 0], accelerationMps2: [at >= 600 ? 1 : 0, 0, 0] }, at)
    const frame = feed.advanceTo(at)
    frequent.update(frame)
    if (at % 20 === 4) sparse.update(frame)
  }
  expect(frequent.snapshot(788)).toEqual(sparse.snapshot(788))
})

test('assumed attitude error remains correlated over the GNSS prediction interval', () => {
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  let initialVariance = 0
  for (let at = 0; at <= 684; at += 4) {
    feed.capture(stationaryState(), at)
    const result = estimator.update(feed.advanceTo(at))
    if (at === 604) initialVariance = result.localPosition!.covarianceBlocks[0]!.velocityM2S2
  }
  const result = estimator.snapshot(684)
  expect(result.localPosition!.capturedAtMs).toBe(600)
  // A held 0.03 rad gravity-direction error accumulates velocity error across
  // the whole 84 ms interval, rather than gaining confidence from more samples.
  // (0.03 * 9.80665)^2 * (0.084^2 - 0.004^2) is about 0.0006093 m²/s².
  expect(result.localPosition!.covarianceBlocks[0]!.velocityM2S2 - initialVariance).toBeGreaterThan(0.00060)
})

test.each(['imu', 'gnss'] as const)('retiming a retained %s sample withdraws fixture prediction', (kind) => {
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  for (let at = 0; at <= 604; at += 4) { feed.capture(stationaryState(), at); estimator.update(feed.advanceTo(at)) }
  const before = estimator.snapshot(604), input = feed.advanceTo(608)
  input.sensors.find(row => row.kind === kind)!.observation!.estimatedCaptureMs += 1
  const result = estimator.update(input)
  expect(result.health.localPosition).toBe(false)
  expect(result.localPosition).toBeNull()
  expect(result.resets.attitude + result.resets.position).toBeGreaterThan(before.resets.attitude + before.resets.position)
})

// A new sequence still has to share the fixed raw-capture/local-time mapping.
test('retiming a newly sequenced GNSS fix withdraws prediction and changes its reference', () => {
  const feed = createPhysicsSensorFeed(0), estimator = createEstimator({ gravityCorrection: 'initialization-only', positionPrediction: 'fixture-imu' })
  for (let at = 0; at < 704; at += 4) { feed.capture(stationaryState(), at); estimator.update(feed.advanceTo(at)) }
  const before = estimator.snapshot(700)
  expect(before.health.localPosition).toBe(true)
  expect(before.localPosition!.capturedAtMs).toBe(600)
  feed.capture(stationaryState(), 704)
  const input = feed.advanceTo(704), fix = input.sensors.find(row => row.kind === 'gnss')!.observation!
  expect(fix.capturedUs).toBe(1700000n)
  expect(fix.estimatedCaptureMs).toBe(700)
  fix.estimatedCaptureMs = 701
  const result = estimator.update(input)
  expect(result.health.localPosition).toBe(false)
  expect(result.localPosition).toBeNull()
  expect(result.resets.position).toBe(before.resets.position + 1)
  expect(result.events.at(-1)!.reason).toBe('inertial-epoch-remapped')
  for (let at = 708; at <= 804; at += 4) {
    feed.capture(stationaryState(), at)
    const refreshed = estimator.update(feed.advanceTo(at))
    if (at < 804) expect(refreshed.health.localPosition).toBe(false)
  }
  const recovered = estimator.snapshot(804)
  expect(recovered.health.localPosition).toBe(true)
  expect(recovered.localPosition!.capturedAtMs).toBe(800)
  expect(recovered.resets.position).toBeGreaterThan(before.resets.position)
})
