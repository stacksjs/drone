import { expect, test } from 'bun:test'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { createVehicleMeasurementQualifier } from '../../resources/functions/drone/vehicles/measurements'
import { createSurfaceProfile } from '../../resources/functions/drone/vehicles/surface/index'
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
