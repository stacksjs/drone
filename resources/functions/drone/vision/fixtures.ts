import type { VisionCalibration, VisionValidationSample } from './types'

/** Synthetic worked example only. This is not a Pi lens or physical calibration. */
export function exampleVisionCalibration(): VisionCalibration {
  return {
    version: 1, id: 'synthetic-brown5', cameraId: 'fixture-camera', modeId: '640x480-final-isp', evidence: 'synthetic',
    intrinsics: { width: 640, height: 480, fx: 400, fy: 400, cx: 320, cy: 240, distortion: [0.04, 0, 0, 0, 0] },
    output: { width: 640, height: 480, crop: [0, 0, 640, 480] },
    extrinsics: { quaternionWxyz: [0.5, 0.5, 0.5, 0.5], translationM: [0.08, 0, 0] },
    uncertainty: { pixelSigmaPx: 1, depthSigmaM: 0.03, translationSigmaM: 0.01, rotationSigmaRad: 0.003, modelSigmaM: 0.03 },
    timing: { clockUncertaintyMs: 1, maxSkewMs: 20, maxAgeMs: 200 },
  }
}

/**
 * Independent tabulated correspondences: normalized rays (+/-0.4,+/-0.3)
 * have radial multiplier 1.01; (+/-0.2,-/+0.1) have multiplier 1.002.
 * Body coordinates are [Z+0.08, X, Y]. No production projection generates this table.
 */
export function exampleVisionValidation(): VisionValidationSample[] {
  return [
    { id: 'upper-left', pixel: [158.4, 118.8], opticalDepthM: 2, bodyPointM: [2.08, -0.8, -0.6] },
    { id: 'upper-right', pixel: [481.6, 118.8], opticalDepthM: 4, bodyPointM: [4.08, 1.6, -1.2] },
    { id: 'lower-left', pixel: [158.4, 361.2], opticalDepthM: 6, bodyPointM: [6.08, -2.4, 1.8] },
    { id: 'lower-right', pixel: [481.6, 361.2], opticalDepthM: 8, bodyPointM: [8.08, 3.2, 2.4] },
    { id: 'near-left', pixel: [239.84, 280.08], opticalDepthM: 10, bodyPointM: [10.08, -2, 1] },
    { id: 'near-right', pixel: [400.16, 199.92], opticalDepthM: 12, bodyPointM: [12.08, 2.4, -1.2] },
  ]
}
