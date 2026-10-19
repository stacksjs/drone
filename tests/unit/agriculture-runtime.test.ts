import { expect, test } from 'bun:test'
import { simulateAgriculture } from '../../resources/functions/drone/agriculture/runtime'
import { renderAgricultureImage, createAgricultureCamera } from '../../resources/functions/drone/agriculture/camera'
import { createAgriculturePlan } from '../../resources/functions/drone/agriculture/planner'
import { exampleAgricultureConfig } from '../../resources/functions/drone/agriculture/fixtures'
import { calibrateAgricultureImage } from '../../resources/functions/drone/agriculture/radiometry'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'
import { replayMission } from '../../resources/functions/drone/missions/engine'
import { simulateSurvey } from '../../resources/functions/drone/mapping/runtime'
import { createSurveyCamera } from '../../resources/functions/drone/mapping/camera'

// These public seams prove modeled numeric acquisition and admitted frame scope.
// They do not establish physical calibration, full sensor replay or agronomic truth.
test('owned agriculture collects raw red and NIR through the actual estimator mission authority and shutter pipeline', () => {
  const run = simulateAgriculture()
  expect(run.status).toBe('completed')
  expect(run.survey.boardNeutral).toBe(true)
  expect(replayMission(run.survey.trace).snapshot().state).toBe('completed')
  expect(run.captures.length).toBeGreaterThan(20)
  expect(run.captures).toHaveLength(run.survey.captures.length)
  for (const [i, capture] of run.captures.entries()) {
    const visible = run.survey.captures[i]!
    expect([capture.captureId, capture.sessionId, capture.sequence, capture.reference, capture.issuedAtMs, capture.capturedAtMs, capture.acknowledgedAtMs]).toEqual([visible.id, visible.sessionId, visible.sequence, visible.pose.reference, visible.issuedAtMs, visible.capturedAtMs, visible.acknowledgedAtMs])
    expect(capture.image.rgba).toEqual(visible.rgba)
    expect(capture.image.bands.map(band => band.band)).toEqual(['red', 'nir'])
    expect(capture.image.bands.every(band => band.counts instanceof Uint16Array && band.capturedAtMs === capture.capturedAtMs)).toBe(true)
    expect(capture.image.rgba).not.toBe(visible.rgba)
    expect(calibrateAgricultureImage(run.plan.config.radiometry, capture.image, capture.capturedAtMs).qualified).toBe(true)
  }
  expect(run.captures[0]!.image.bands[0].irradiance.valueWm2Nm).not.toBe(run.captures.at(-1)!.image.bands[0].irradiance.valueWm2Nm)
})

test('independent ground zones yield numeric NDVI while changing band irradiance changes DN instead of reflectance', () => {
  const plan = createAgriculturePlan(exampleAgricultureConfig())
  const body = createRigidBody({ positionM: [0, 0, -1.5] }).snapshot()
  const a = renderAgricultureImage(plan, body, 9000), b = renderAgricultureImage(plan, body, 14000)
  const calibratedA = calibrateAgricultureImage(plan.config.radiometry, a, 9000), calibratedB = calibrateAgricultureImage(plan.config.radiometry, b, 14000)
  for (const [x, y, red, nir, ndvi] of [[48, 18, .1, .7, .75], [24, 54, .25, .15, -.25], [72, 54, .2, .4, 1 / 3]]) {
    const index = y! * a.width + x!
    expect(calibratedA.valid[index]).toBe(1)
    expect(calibratedA.red[index]).toBeCloseTo(red!, 3)
    expect(calibratedA.nir[index]).toBeCloseTo(nir!, 3)
    expect(calibratedA.ndvi[index]).toBeCloseTo(ndvi!, 3)
    expect(calibratedB.ndvi[index]).toBeCloseTo(ndvi!, 3)
    expect(a.bands[0].counts[index]).not.toBe(b.bands[0].counts[index])
  }
  expect(a.rgba).toEqual(b.rgba)
  expect(a.bands[0].counts).not.toEqual(a.bands[1].counts)
})

test('opaque modeled animal materials share the visible and raw-band ray intersection without identifying animals', () => {
  const plan = createAgriculturePlan(exampleAgricultureConfig())
  const body = createRigidBody({ positionM: [0, 0, -1.5] }).snapshot()
  const image = renderAgricultureImage(plan, body, 9000)
  const calibrated = calibrateAgricultureImage(plan.config.radiometry, image, 9000)
  // Depth1.46m and focal60px put these pixel-centre rays near N/E[-.353,-.304]
  // and[+.353,+.304]. Brown5 correction is <.004m, inside both declared ellipses.
  const samples = [
    { x: 60, y: 21, rgba: [235, 230, 211, 255], red: .35, nir: .4, ndvi: 1 / 15 },
    { x: 35, y: 50, rgba: [48, 42, 36, 255], red: .06, nir: .08, ndvi: 1 / 7 },
  ]
  for (const sample of samples) {
    const index = sample.y * image.width + sample.x
    expect(Array.from(image.rgba.slice(index * 4, index * 4 + 4))).toEqual(sample.rgba)
    expect(calibrated.valid[index]).toBe(1)
    expect(calibrated.red[index]).toBeCloseTo(sample.red, 3)
    expect(calibrated.nir[index]).toBeCloseTo(sample.nir, 3)
    expect(calibrated.ndvi[index]).toBeCloseTo(sample.ndvi, 3)
  }
  expect(Object.keys(image).sort()).toEqual(['bands', 'height', 'registrationErrorPx', 'registrationId', 'rgba', 'width'])
})

test('transient raw-band and uncertain shutter failures latch abort after one admitted frame', () => {
  const expected = { 'irradiance-loss': 'agriculture-irradiance-unqualified', 'band-skew': 'agriculture-band-synchronization', saturation: 'agriculture-insufficient-valid-pixels', 'camera-loss': 'agriculture-camera-ack-deadline', 'wrong-ack': 'agriculture-camera-ack-scope-or-timing' } as const
  for (const scenario of Object.keys(expected) as (keyof typeof expected)[]) {
    const run = simulateAgriculture({ scenario })
    expect(run.status).toBe('aborted')
    expect(run.reason).toBe(expected[scenario])
    expect(run.captures).toHaveLength(1)
    expect(run.survey.captures).toHaveLength(1)
    expect(run.survey.boardNeutral).toBe(true)
    expect(run.survey.trace.rows.at(-1)!.observation.nowMs).toBeLessThan(12000)
    expect(run.survey.trace.rows.at(-1)!.result.targetM).toBeNull()
  }
})

test('authority and position failures revoke collection and partial runs cannot imply an unobserved fault', () => {
  for (const scenario of ['position-loss', 'rc-override', 'abort'] as const) {
    const run = simulateAgriculture({ scenario })
    expect(run.status).toBe(scenario === 'abort' ? 'aborted' : 'blocked')
    expect(run.captures).toHaveLength(0)
    expect(run.survey.boardNeutral).toBe(true)
  }
  const partial = simulateAgriculture({ scenario: 'irradiance-loss', seconds: 10 })
  expect(partial.status).toBe('incomplete')
  expect(partial.captures).toHaveLength(1)
  expect(partial.reason).not.toBe('agriculture-irradiance-unqualified')
  expect(partial.survey.boardNeutral).toBe(true)
  expect(() => simulateAgriculture({ seconds: 7 })).toThrow()
  expect(() => simulateAgriculture({ visitId: '../unsafe' })).toThrow()
})

test('expired panel calibration aborts the owned survey before admitting its first numeric packet', () => {
  const config = exampleAgricultureConfig()
  config.radiometry.maxPanelAgeMs = 1000
  const run = simulateAgriculture({ config })
  expect(run.status).toBe('aborted')
  expect(run.reason).toBe('agriculture-radiometry-unqualified')
  expect(run.captures).toHaveLength(0)
  expect(run.survey.captures).toHaveLength(0)
  expect(run.survey.boardNeutral).toBe(true)
})

test('whole agriculture ACK snapshots are isolated, cancelled and never reused after ambiguous exposure', () => {
  const plan = createAgriculturePlan(exampleAgricultureConfig()), body = createRigidBody({ positionM: [0, 0, -1.5] }).snapshot()
  const camera = createAgricultureCamera(plan)
  camera.render(body, 9000)
  camera.request({ sessionId: 'test-visit', sequence: 1, issuedAtMs: 9000, reference: 'test-origin' })
  expect(camera.poll(9019)).toBeNull()
  const ack = camera.poll(9020)!
  expect(ack.capturedAtMs).toBe(9000)
  const first = camera.captures()[0]!
  first.image.bands[0].counts.fill(0); ack.rgba.fill(0)
  expect(camera.captures()[0]!.image.bands[0].counts[0]).toBeGreaterThan(4000)
  expect(camera.captures()[0]!.image.rgba[3]).toBe(255)
  camera.render(body, 9040)
  camera.request({ sessionId: 'test-visit', sequence: 2, issuedAtMs: 9040, reference: 'test-origin' })
  camera.close()
  expect(camera.poll(9060)).toBeNull()
  expect(camera.captures()).toHaveLength(1)
  const lost = createAgricultureCamera(plan, 'camera-loss')
  lost.render(body, 11000)
  lost.request({ sessionId: 'test-visit', sequence: 1, issuedAtMs: 11000, reference: 'test-origin' })
  expect(() => lost.poll(11080)).toThrow('ack-deadline')
  lost.render(body, 14000)
  expect(() => lost.request({ sessionId: 'test-visit', sequence: 2, issuedAtMs: 14000, reference: 'test-origin' })).toThrow()
  expect(lost.captures()).toHaveLength(0)
})

test('survey camera factory preserves the default visible path exactly', () => {
  const original = simulateSurvey({ seconds: 12 })
  const injected = simulateSurvey({ seconds: 12, cameraFactory: (plan, fault) => createSurveyCamera(plan, fault) })
  expect(injected).toEqual(original)
})
