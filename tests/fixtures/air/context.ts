import type { VehicleControllerContext } from '../../../resources/functions/drone/vehicles/types'
import { createEstimator } from '../../../resources/functions/drone/estimation/estimator'
import { createAirProfile } from '../../../resources/functions/drone/vehicles/air'
/** Isolated policy fixture. Full pipeline tests use the common raw-sensor runtime. */
export function airContext(): VehicleControllerContext {
  const estimate = createEstimator().snapshot(1000)
  estimate.bootId = 1n
  estimate.health.tilt = true; estimate.health.localPosition = true
  estimate.attitude = { reference: 'GRAVITY_ALIGNED_RELATIVE_YAW', quaternionWxyz: [1, 0, 0, 0], eulerRad: [0, 0, 0], capturedAtMs: 1000, covarianceRad2: null, absoluteHeadingObserved: false }
  estimate.localPosition = { frame: 'LOCAL_NED', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, altitudeDatum: 'WGS84_ELLIPSOID', positionM: [100, 0, -15], velocityMps: [13, 0, 0], covarianceBlocks: [0, 1, 2].map(() => ({ positionM2: 0.1, positionVelocityM2S: 0, velocityM2S2: 0.1 })), capturedAtMs: 960, predictedToMs: 1000 }
  const profile = createAirProfile(), state = profile.createPlant().snapshot()
  state.positionM = [100, 0, -15]; state.velocityMps = [13, 0, 0]; state.onSurface = false; state.details.airspeedMps = 13
  return { nowMs: 1000, enabled: true, estimate, measurement: profile.renderMeasurement(state, 940, `1:${Object.values(estimate.resets).join(',')}`), mission: { version: 2, vehicle: 'fixed-wing', evidence: 'owned-vehicle-mission-simulation', physicalFlightEnabled: false, state: 'running', taskId: 'survey', taskKind: 'waypoint', targetM: [350, 0, -20], payload: null, reason: 'fixture', elapsedMs: 400 } }
}
