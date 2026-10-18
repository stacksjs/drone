import { expect, test } from 'bun:test'
import type { VehicleMissionObservation, VehicleMissionPlan } from '../../resources/functions/drone/vehicles/types'
import { createVehicleMissionEngine, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'
function plan(): VehicleMissionPlan {
  return { version: 2, vehicle: 'ground', id: 'ground-route', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 20, minDownM: -0.5, maxDownM: 0.5 }, rallyM: [0, 0, 0], power: { availableWh: 10, maxW: 100, reservePercent: 30 }, start: 'begin', tasks: [{ id: 'begin', kind: 'start', next: 'drive' }, { id: 'drive', kind: 'waypoint', positionM: [2, 0, 0], acceptanceM: 0.2, maxArrivalSpeedMps: 0.2, settleMs: 100, timeoutMs: 10000, next: 'park' }, { id: 'park', kind: 'stop', positionM: [2, 0, 0], acceptanceM: 0.2, maxArrivalSpeedMps: 0.1, settleMs: 100, timeoutMs: 3000 }] }
}
function observation(nowMs: number): VehicleMissionObservation { return { kind: 'simulation', nowMs, reference: '55:0,0,0,0,0', origin: plan().origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true, payloadAck: null } }
test('vehicle missions require explicit operator start and emit the full profile goal', () => {
  const input = plan()
  expect(validateVehicleMission(input).worstCaseMs).toBe(13020)
  const engine = createVehicleMissionEngine(input)
  input.tasks.length = 0
  expect(engine.step(observation(1000)).state).toBe('ready')
  expect(engine.step(observation(1020), 'start').taskId).toBe('drive')
  expect(engine.step(observation(1040)).targetM).toEqual([2, 0, 0])
  expect(engine.snapshot().physicalFlightEnabled).toBe(false)
})
