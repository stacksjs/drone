import type { VehicleControllerContext } from '../../../resources/functions/drone/vehicles/types'
import type { EstimatorSnapshot } from '../../../resources/functions/drone/estimation/estimator'
import { createEstimator } from '../../../resources/functions/drone/estimation/estimator'
export function subseaContext(nowMs = 1000): VehicleControllerContext {
  const estimate: EstimatorSnapshot = createEstimator().snapshot(nowMs)
  estimate.bootId = 1n; estimate.evidence = 'fixture'; estimate.health.tilt = true; estimate.health.localPosition = true
  estimate.attitude = { reference: 'GRAVITY_ALIGNED_RELATIVE_YAW', quaternionWxyz: [1, 0, 0, 0], eulerRad: [0, 0, 0], capturedAtMs: nowMs, covarianceRad2: null, absoluteHeadingObserved: false }
  estimate.localPosition = { frame: 'LOCAL_NED', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, altitudeDatum: 'LOCAL_WATER_SURFACE', positionM: [0, 0, 2], velocityMps: [0, 0, 0], covarianceBlocks: [0, 1, 2].map(() => ({ positionM2: 0.001, positionVelocityM2S: 0, velocityM2S2: 0.001 })), capturedAtMs: nowMs - 60, predictedToMs: nowMs }
  const reference = `1:${Object.values(estimate.resets).join(',')}`
  return { nowMs, enabled: true, estimate, measurement: { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'subsea', sequence: nowMs / 20, reference, capturedAtMs: nowMs - 60, receivedAtMs: nowMs, values: { onSurface: false, stopped: true, calibration: 'subsea-dvl-pressure-v1', clockSigmaMs: 1, pressurePa: 121428.6325, surfacePressurePa: 101325, waterDensityKgM3: 1025, dvlVelocityBodyMps: [0, 0, 0], angularRateBodyRadS: [0, 0, 0], dvlLocked: true, leak: false, tetherLengthM: 2, tetherTensionN: 0, linkConnected: true, emergency: false, bottomRangeM: 8, structureRangeM: 6, structureHit: true, cameraLuma: Array(16).fill(100), cameraFrameId: `subsea-model-${nowMs / 20}-${nowMs - 60}` } }, mission: { version: 2, vehicle: 'subsea', evidence: 'owned-vehicle-mission-simulation', physicalFlightEnabled: false, state: 'running', taskId: 'dive', taskKind: 'waypoint', targetM: [0, 0, 2], payload: null, reason: 'fixture', elapsedMs: 0 } }
}
