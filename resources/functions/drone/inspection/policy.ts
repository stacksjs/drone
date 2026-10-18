import type { InspectionAssetObservation, InspectionConfig } from './types'

/** Shared capture gate for live simulation and declared recording consistency. Requires a validated inspection configuration. */
export function inspectionCapturePolicy(config: InspectionConfig, input: { atMs: number, velocityMps: number, positionSigmaM: number, attitudeSigmaRad: number, assetObservation: InspectionAssetObservation }): 'inspection-pose-uncertainty' | 'inspection-range-or-camera-failed' | 'inspection-asset-moved' | 'inspection-clearance-unqualified' | null {
  const { atMs, velocityMps, positionSigmaM, attitudeSigmaRad, assetObservation: asset } = input
  if (![atMs, velocityMps, positionSigmaM, attitudeSigmaRad].every(Number.isFinite) || atMs < 0 || velocityMps < 0 || positionSigmaM <= 0 || attitudeSigmaRad <= 0 || positionSigmaM > config.quality.maxPoseSigmaM || attitudeSigmaRad > config.quality.maxAttitudeSigmaRad) return 'inspection-pose-uncertainty'
  const calibration = config.calibration, clockSeconds = calibration.timing.clockUncertaintyMs / 1000
  const minimumAttitudeSigma = calibration.uncertainty.rotationSigmaRad + 0.003 + atMs / 1000000 + 35 * clockSeconds
  const minimumPositionSigma = calibration.uncertainty.translationSigmaM + velocityMps * clockSeconds + Math.hypot(...calibration.extrinsics.translationM) * attitudeSigmaRad
  if (attitudeSigmaRad < minimumAttitudeSigma || positionSigmaM < minimumPositionSigma) return 'inspection-pose-uncertainty'
  if (![asset.uncertaintyM, asset.registrationDisplacementM, asset.cameraSeparationM].every(Number.isFinite) || asset.uncertaintyM < config.asset.registrationSigmaM + positionSigmaM || asset.registrationDisplacementM < 0 || asset.cameraSeparationM < 0) return 'inspection-range-or-camera-failed'
  if (asset.registrationDisplacementM > config.clearance.assetMotionBoundM + config.asset.registrationSigmaM + positionSigmaM) return 'inspection-asset-moved'
  const stoppingM = velocityMps * config.clearance.reactionMs / 1000 + velocityMps ** 2 / (2 * config.clearance.brakingAccelerationMps2)
  const requiredSeparationM = config.clearance.minSeparationM + config.clearance.bodyRadiusM + Math.max(config.clearance.positionBoundM, asset.uncertaintyM) + config.clearance.assetMotionBoundM + stoppingM
  return asset.cameraSeparationM < requiredSeparationM ? 'inspection-clearance-unqualified' : null
}
