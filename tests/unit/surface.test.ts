import { expect, test } from 'bun:test'
import { correctSurfaceSounding, exportSurfaceSurvey } from '../../resources/functions/drone/vehicles/surface/survey'

test('single beam reduction retains travel time, sound speed, draft, water level, datum and independent uncertainty', () => {
  const raw = { id: 'ping-1', reference: 'boot:1', capturedAtMs: 1000, receivedAtMs: 1060, twoWayTravelS: 0.01, soundSpeedMps: 1500, draftM: 0.3, waterLevelAboveDatumM: 1.2, datum: 'LOCAL_TEST_DATUM', timeSigmaS: 0.00001, soundSpeedSigmaMps: 2, draftSigmaM: 0.02, waterLevelSigmaM: 0.03, motionSigmaM: 0.01 }
  const pose = { reference: raw.reference, atMs: 1000, positionM: [4, 2, 0] as [number, number, number], rollRad: 0, pitchRad: 0, yawRad: 0, attitudeSigmaRad: 0, positionSigmaM: 0.05, timeSigmaMs: 2, speedMps: 1 }
  const reduced = correctSurfaceSounding(raw, pose)
  expect(reduced.depthBelowDatumM).toBeCloseTo(6.6, 10)
  // Independent worked sum: (1500/2*10us)^2 + (.01/2*2)^2 + .02^2 + .03^2 + .01^2.
  expect(reduced.verticalSigmaM).toBeCloseTo(Math.sqrt(0.00155625), 10)
  expect(reduced.horizontalSigmaM).toBeCloseTo(Math.sqrt(0.002504), 10)
  const exported = exportSurfaceSurvey([reduced])
  raw.draftM = 9; pose.positionM[0] = 99; reduced.positionM[0] = 98
  expect(exported.soundings[0]!.positionM[0]).toBe(4)
  expect(exported.metadata.physicalValidation).toBe(false)
  expect(() => correctSurfaceSounding({ ...raw, receivedAtMs: 1300 }, pose)).toThrow()
})

import { createSurfacePlant } from '../../resources/functions/drone/vehicles/surface/plant'
test('surface hull obeys force/mass, current-relative drag and yaw inertia without teleporting', () => {
  const plant = createSurfacePlant()
  const env = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
  const first = plant.step([0.6, 0, 0], 0.004, env)
  expect(first.accelerationMps2[0]).toBeCloseTo(1, 8)
  expect(first.velocityMps[0]).toBeCloseTo(0.004, 8)
  expect(first.positionM[0]).toBeCloseTo(0.000016, 8)
  const copy = plant.snapshot(); copy.positionM[0] = 900
  expect(plant.snapshot().positionM[0]).toBeLessThan(1)
  const yaw = createSurfacePlant().step([0, 0, 1], 0.004, env)
  expect(yaw.angularRateRadS[2]).toBeCloseTo(0.006, 8)
  const drift = createSurfacePlant().step([0, 0, 0], 0.004, { ...env, currentMps: [0, 0.2, 0] })
  expect(drift.accelerationMps2[1]).toBeCloseTo(0.2, 8)
  expect(() => plant.step([2, 0, 0], 0.004, env)).toThrow()
})

import { createSurfaceController } from '../../resources/functions/drone/vehicles/surface/controller'
import { createSurfaceSampler } from '../../resources/functions/drone/vehicles/surface/payload'
import { createSurfaceProfile } from '../../resources/functions/drone/vehicles/surface/index'
import { surfaceContext } from '../fixtures/surface/context'
test('surface control uses estimated pose and qualified range, latches collision, stale and replay faults', () => {
  const c = surfaceContext(), controller = createSurfaceController()
  const out = controller.step(c)
  expect(out.inhibited).toBe(false); expect(out.actuators[0]).toBeGreaterThan(0)
  c.mission.targetM![0] = -99
  expect(out.actuators[0]).toBeGreaterThan(0)
  for (const fault of ['stale', 'collision', 'replay', 'reference', 'clock'] as const) {
    const ctrl = createSurfaceController(); ctrl.step(surfaceContext())
    const next = surfaceContext(1020)
    if (fault === 'stale') next.measurement!.capturedAtMs = 100
    if (fault === 'collision') next.measurement!.values.closestRangeM = 0.4
    if (fault === 'replay') next.measurement!.sequence = 1
    if (fault === 'reference') next.measurement!.reference = 'other'
    if (fault === 'clock') next.nowMs = 1200
    expect(ctrl.step(next).inhibited).toBe(true)
    expect(ctrl.step(surfaceContext(1040)).actuators).toEqual([0, 0, 0])
  }
})

test('sample acknowledgement scopes actual observed capture location/time and container, uncertainty cannot auto-retry', () => {
  const port = createSurfaceSampler(), c = surfaceContext(1000)
  const command = { eventId: 'sample-1', taskId: 'sample', operation: 'water-sample' as const, containerId: 'bottle-001', issuedAtMs: 1000, expiresAtMs: 2000, positionM: [0, 0, 0] as [number, number, number], reference: c.measurement!.reference }
  port.request(command); command.positionM[0] = 9
  expect(port.poll(1180)).toBeNull()
  const at = surfaceContext(1200); at.estimate.localPosition!.positionM[0] = 0.1
  port.observe!(at); at.estimate.localPosition!.positionM[0] = 100
  const ack = port.poll(1200)!
  expect(ack.outcome).toBe('confirmed'); expect(ack.positionM[0]).toBe(0.1); expect(ack.capturedAtMs).toBe(1200); expect(ack.containerId).toBe('bottle-001')
  expect(() => port.request({ ...command, eventId: 'different' })).toThrow('container')
  const lost = createSurfaceSampler(); lost.request({ ...command, positionM: [0, 0, 0] })
  expect(lost.poll(1200)!.outcome).toBe('uncertain')
  expect(() => lost.request({ ...command, positionM: [0, 0, 0] })).toThrow()
  const noAck = createSurfaceSampler('loss'); noAck.request(command); expect(noAck.poll(2500)).toBeNull()
})

test('surface profile declares bounded owned survey/sample/return and isolated caller state', () => {
  const profile = createSurfaceProfile()
  expect(profile.mission.tasks.some(t => t.kind === 'payload' && t.operation === 'water-sample')).toBe(true)
  expect(profile.actuators.map(a => a.name)).toEqual(['body-surge', 'body-sway', 'body-yaw'])
  profile.mission.rallyM[0] = 99
  expect(createSurfaceProfile().mission.rallyM).toEqual([0, 0, 0])
})

test('surface controller rejects healthy-looking estimates from another boot and expired pose epochs', () => {
  for (const field of ['boot', 'stale-pose', 'future-pose'] as const) {
    const c = surfaceContext()
    if (field === 'boot') c.estimate.bootId = 99n
    if (field === 'stale-pose') c.estimate.attitude!.capturedAtMs = 1
    if (field === 'future-pose') c.estimate.localPosition!.capturedAtMs = 1001
    expect(createSurfaceController().step(c).inhibited).toBe(true)
  }
})

import { reduceSurfaceSurvey } from '../../resources/functions/drone/vehicles/surface/survey'
test('survey reduction deduplicates received packets and rejects capture-pose mismatches', () => {
  const c = surfaceContext(), m = c.measurement!
  const row = { atMs: c.nowMs, measurement: m, measurementPose: { capturedAtMs: m.capturedAtMs, reference: m.reference, positionCapturedAtMs: m.capturedAtMs, positionPredictedToMs: m.capturedAtMs, attitudeCapturedAtMs: m.capturedAtMs, attitudePredictedToMs: m.capturedAtMs, gyroCapturedAtMs: m.capturedAtMs, attitudePrediction: 'qualified-gyro-hold' as const, positionM: [0, 0, 0] as [number, number, number], quaternionWxyz: [1, 0, 0, 0] as [number, number, number, number] } }
  const exported = reduceSurfaceSurvey([row, row], { positionSigmaM: 0.05, timeSigmaMs: 2, attitudeSigmaRad: 0.001 })
  expect(exported.soundings).toHaveLength(1)
  expect(exported.soundings[0]!.depthBelowDatumM).toBeCloseTo(5, 3)
  row.measurementPose.capturedAtMs--
  expect(() => reduceSurfaceSurvey([row], { positionSigmaM: 0.05, timeSigmaMs: 2, attitudeSigmaRad: 0.001 })).toThrow('capture')
})

test('survey export cannot relabel a reduced ping timestamp or acoustic identifier', () => {
  const c = surfaceContext(), m = c.measurement!
  const row = { atMs: c.nowMs, measurement: m, measurementPose: { capturedAtMs: m.capturedAtMs, reference: m.reference, positionCapturedAtMs: m.capturedAtMs, positionPredictedToMs: m.capturedAtMs, attitudeCapturedAtMs: m.capturedAtMs, attitudePredictedToMs: m.capturedAtMs, gyroCapturedAtMs: m.capturedAtMs, attitudePrediction: 'qualified-gyro-hold' as const, positionM: [0, 0, 0] as [number, number, number], quaternionWxyz: [1, 0, 0, 0] as [number, number, number, number] } }
  const sounding = reduceSurfaceSurvey([row], { positionSigmaM: 0.05, timeSigmaMs: 2, attitudeSigmaRad: 0.001 }).soundings[0]!
  expect(() => exportSurfaceSurvey([{ ...sounding, capturedAtMs: sounding.capturedAtMs + 1 }])).toThrow()
  expect(() => exportSurfaceSurvey([{ ...sounding, id: 'different-ping' }])).toThrow()
})

test('sampler does not confirm a sample from a stale position despite an asserted healthy flag', () => {
  const c = surfaceContext(1200), port = createSurfaceSampler()
  port.request({ eventId: 'stale-sample', taskId: 'sample', operation: 'water-sample', containerId: 'bottle-stale', issuedAtMs: 1000, expiresAtMs: 2000, positionM: [0, 0, 0], reference: c.measurement!.reference })
  c.estimate.localPosition!.capturedAtMs = 1
  port.observe!(c)
  expect(port.poll(1200)!.outcome).toBe('uncertain')
})

test('survey export preserves uncertainty inputs and rejects relabeling a horizontal sigma', () => {
  const c = surfaceContext(), m = c.measurement!
  const row = { atMs: c.nowMs, measurement: m, measurementPose: { capturedAtMs: m.capturedAtMs, reference: m.reference, positionCapturedAtMs: m.capturedAtMs, positionPredictedToMs: m.capturedAtMs, attitudeCapturedAtMs: m.capturedAtMs, attitudePredictedToMs: m.capturedAtMs, gyroCapturedAtMs: m.capturedAtMs, attitudePrediction: 'qualified-gyro-hold' as const, positionM: [0, 0, 0] as [number, number, number], quaternionWxyz: [1, 0, 0, 0] as [number, number, number, number] } }
  const sounding = reduceSurfaceSurvey([row], { positionSigmaM: 0.05, timeSigmaMs: 2, attitudeSigmaRad: 0.001 }).soundings[0]!
  expect(() => exportSurfaceSurvey([{ ...sounding, horizontalSigmaM: 0.000001 }])).toThrow()
})

test('harbour return mission has an explicit reserve decision that can omit uncertain new collection work', () => {
  const plan = createSurfaceProfile('harbour-return').mission
  expect(plan.tasks.some(t => t.kind === 'branch' && t.otherwise === 'return')).toBe(true)
})

test('tilted single beam projects its acoustic footprint and propagates angular uncertainty', () => {
  const c = surfaceContext(), m = c.measurement!
  const pitch = 0.04
  const row = { atMs: c.nowMs, measurement: m, measurementPose: { capturedAtMs: m.capturedAtMs, reference: m.reference, positionCapturedAtMs: m.capturedAtMs, positionPredictedToMs: m.capturedAtMs, attitudeCapturedAtMs: m.capturedAtMs, attitudePredictedToMs: m.capturedAtMs, gyroCapturedAtMs: m.capturedAtMs, attitudePrediction: 'qualified-gyro-hold' as const, positionM: [0, 0, 0] as [number, number, number], quaternionWxyz: [Math.cos(pitch / 2), 0, Math.sin(pitch / 2), 0] as [number, number, number, number] } }
  const sounding = reduceSurfaceSurvey([row], { positionSigmaM: 0.05, timeSigmaMs: 2, attitudeSigmaRad: 0.001 }).soundings[0]!
  // The rendered range is 5.10008m; a 0.04rad forward tilt projects about0.203949m north.
  expect(sounding.positionM[0]).toBeCloseTo(0.20394880373, 7)
  expect(sounding.positionM[2]).toBeCloseTo(5.39600047, 6)
  expect(sounding.depthBelowDatumM).toBeCloseTo(4.99600047, 6)
  expect(sounding.horizontalSigmaM).toBeGreaterThan(0.05)
  const invalid = structuredClone(row); invalid.measurementPose.quaternionWxyz = [Math.cos(0.1), 0, Math.sin(0.1), 0]
  expect(() => reduceSurfaceSurvey([invalid], { positionSigmaM: 0.05, timeSigmaMs: 2, attitudeSigmaRad: 0.001 })).toThrow()
})
