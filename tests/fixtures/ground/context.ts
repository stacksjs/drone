import { createEstimator } from '../../../resources/functions/drone/estimation/estimator'
import type { VehicleControllerContext, VehicleMeasurement } from '../../../resources/functions/drone/vehicles/types'

export function groundContext(nowMs = 1000): VehicleControllerContext {
  const estimate = createEstimator().snapshot(nowMs)
  estimate.bootId = 1n; estimate.evidence = 'fixture'; estimate.health.tilt = true; estimate.health.localPosition = true
  estimate.attitude = { reference: 'GRAVITY_ALIGNED_RELATIVE_YAW', quaternionWxyz: [1, 0, 0, 0], eulerRad: [0, 0, 0], capturedAtMs: nowMs - 40, covarianceRad2: null, absoluteHeadingObserved: false }
  estimate.localPosition = { frame: 'LOCAL_NED', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, altitudeDatum: 'WGS84_ELLIPSOID', positionM: [0, 0, 0], velocityMps: [0, 0, 0], covarianceBlocks: [0, 1, 2].map(() => ({ positionM2: 0.0001, positionVelocityM2S: 0, velocityM2S2: 0.0001 })), capturedAtMs: nowMs - 40, predictedToMs: nowMs }
  return { nowMs, enabled: true, estimate, measurement: groundPacket(nowMs), mission: { version: 2, vehicle: 'ground', evidence: 'owned-vehicle-mission-simulation', physicalFlightEnabled: false, state: 'running', taskId: 'row-a', taskKind: 'waypoint', targetM: [3, 0, 0], payload: null, reason: 'fixture', elapsedMs: 400 } }
}
export function groundPacket(nowMs = 1000): VehicleMeasurement {
  return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'ground', sequence: Math.round(nowMs / 20), reference: '1:0,0,0,0,0', capturedAtMs: nowMs - 40, receivedAtMs: nowMs, values: { calibration: 'ground-4096-015-060-v1', clockUncertaintyMs: 1, encoderCounts: [0, 0], onSurface: true, stopped: true, obstacleMm: 20000, personMm: 20000, guardClosed: true, emergency: false, bumper: false } }
}
