import { expect, test } from 'bun:test'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { createVehicleMeasurementQualifier } from '../../resources/functions/drone/vehicles/measurements'
import { createSurfaceProfile, reduceSurfaceSurvey } from '../../resources/functions/drone/vehicles/surface/index'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

test('vehicle measurement envelope permits retained identical packets and rejects changed replay or fabricated contact', () => {
  const profile = createSurfaceProfile(), ref = '55:0,0,0,0,0', m = profile.renderMeasurement(profile.createPlant().snapshot(), 1000, ref)
  const q = createVehicleMeasurementQualifier('surface')
  expect(q.qualify(m, 1060, ref)!.values.onSurface).toBe(true)
  expect(q.qualify(m, 1080, ref)!.sequence).toBe(m.sequence)
  const altered = structuredClone(m); altered.values.stopped = false
  expect(() => q.qualify(altered, 1080, ref)).toThrow('Replayed')
  expect(() => createVehicleMeasurementQualifier('surface').qualify({ ...m, receivedAtMs: 900 }, 1060, ref)).toThrow()
  expect(() => createVehicleMeasurementQualifier('surface').qualify({ ...m, values: { ...m.values, onSurface: 'true' } }, 1060, ref)).toThrow()
})

test('surface survey executes on raw sensors and owned estimator through shared mission authority and replay', () => {
  const run = runVehicleSimulation(createSurfaceProfile(), { seconds: 120 })
  expect(run.status).toBe('completed')
  expect(run.mission.reason).toBe('stopped')
  expect(run.trace.rows.some(r => r.result.reason === 'payload-confirmed')).toBe(true)
  expect(run.path.some(r => r.positionM && Math.hypot(r.positionM[0], r.positionM[1]) > 4)).toBe(true)
  expect(run.path.some(r => r.actuators.some(v => Math.abs(v) > 0.01))).toBe(true)
  expect(run.path.filter(r => r.measurementPose).every(r => r.measurementPose!.capturedAtMs === r.measurement!.capturedAtMs)).toBe(true)
  expect(replayVehicleMission(run.trace).snapshot()).toEqual(run.mission)
  expect(run.board.actuators).toEqual([0, 0, 0])
  const survey = reduceSurfaceSurvey(run.path, { positionSigmaM: 0.05, timeSigmaMs: 2, attitudeSigmaRad: 0.001 })
  expect(survey.soundings.length).toBeGreaterThan(1000)
  expect(Math.min(...survey.soundings.map(s => s.depthBelowDatumM))).toBeGreaterThan(4.99)
  expect(Math.max(...survey.soundings.map(s => s.depthBelowDatumM))).toBeLessThan(5.14)
  expect(survey.soundings.every(s => s.pose.provenance!.attitudeCapturedAtMs <= s.capturedAtMs && s.pose.provenance!.attitudePredictedToMs === s.capturedAtMs)).toBe(true)
}, 60000)

test('host death expires independent vehicle output lease and sample uncertainty never produces mission completion', () => {
  const host = runVehicleSimulation(createSurfaceProfile('host-loss'), { scenario: 'host-loss', seconds: 120 })
  expect(host.status).toBe('host-lost'); expect(host.board.fault).toBe('output-lease-expired'); expect(host.board.actuators).toEqual([0, 0, 0])
  for (const scenario of ['sample-loss', 'sample-uncertain'] as const) {
    const run = runVehicleSimulation(createSurfaceProfile(scenario), { scenario, seconds: 120 })
    expect(run.status).toBe('blocked'); expect(run.mission.reason).toBe('payload-outcome-uncertain')
    expect(new Set(run.trace.rows.flatMap(row => row.result.payload ? [row.result.payload.eventId] : [])).size).toBe(1)
  }
}, 60000)

import type { SensorObservation } from '../../resources/functions/drone/sensors/types'
import { predictVehicleMeasurementPose } from '../../resources/functions/drone/vehicles/measurements'
import { surfaceContext } from '../fixtures/surface/context'
test('capture pose retains real estimator epochs and predicts attitude only with a qualified matching gyro', () => {
  const e = surfaceContext(1000).estimate
  e.attitude!.capturedAtMs = 980
  const imu: SensorObservation = { kind: 'imu', deviceId: 'fixture-imu', sequence: 1, capturedUs: 980000n, receivedAtMs: 984, estimatedCaptureMs: 980, measurementAgeUpperMs: 20, transportAgeUpperMs: 4, timeUncertaintyUs: 0, quality: [], healthy: true, calibrationId: 'fixture', value: { frame: 'BODY_FRD', temperatureC: 25, specificForceMps2: [0, 0, -9.80665], angularRateRadS: [0, 0, 0.5], specificForceVariance: [0.001, 0.001, 0.001], angularRateVariance: [0.000001, 0.000001, 0.000001] } }
  const pose = predictVehicleMeasurementPose(e, imu, 1000)!
  expect(pose.attitudeCapturedAtMs).toBe(980); expect(pose.attitudePredictedToMs).toBe(1000)
  expect(pose.quaternionWxyz[0]).toBeCloseTo(0.9999875000260416, 12)
  expect(pose.quaternionWxyz[3]).toBeCloseTo(0.004999979166692708, 12)
  expect(predictVehicleMeasurementPose(e, { ...imu, estimatedCaptureMs: 981 }, 1000)).toBeNull()
  expect(predictVehicleMeasurementPose(e, { ...imu, quality: ['timing-unvalidated'] }, 1000)).toBeNull()
})
