import type { VehicleControllerContext } from '../../../resources/functions/drone/vehicles/types'
import { createEstimator } from '../../../resources/functions/drone/estimation/estimator'
import { createSurfacePlant } from '../../../resources/functions/drone/vehicles/surface/plant'
import { renderSurfaceMeasurement } from '../../../resources/functions/drone/vehicles/surface/sensors'
export function surfaceContext(nowMs = 1000): VehicleControllerContext {
  const estimate = createEstimator().snapshot(nowMs)
  estimate.bootId = 1n; estimate.evidence = 'fixture'; estimate.health.tilt = true; estimate.health.localPosition = true
  estimate.attitude = { reference: 'GRAVITY_ALIGNED_RELATIVE_YAW', quaternionWxyz: [1, 0, 0, 0], eulerRad: [0, 0, 0], capturedAtMs: nowMs, covarianceRad2: null, absoluteHeadingObserved: false }
  estimate.localPosition = { frame: 'LOCAL_NED', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, altitudeDatum: 'WGS84_ELLIPSOID', positionM: [0, 0, 0], velocityMps: [0, 0, 0], covarianceBlocks: [0, 1, 2].map(() => ({ positionM2: 0.001, positionVelocityM2S: 0, velocityM2S2: 0.001 })), capturedAtMs: nowMs, predictedToMs: nowMs }
  const reference = `1:${Object.values(estimate.resets).join(',')}`
  return { nowMs, enabled: true, estimate, measurement: renderSurfaceMeasurement(createSurfacePlant().snapshot(), nowMs - 60, reference, nowMs / 20), mission: { version: 2, vehicle: 'surface', evidence: 'owned-vehicle-mission-simulation', physicalFlightEnabled: false, state: 'running', taskId: 'survey', taskKind: 'waypoint', targetM: [5, 0, 0], payload: null, reason: 'fixture', elapsedMs: 0 } }
}
