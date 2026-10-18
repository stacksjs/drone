import type { InspectionConfig } from './types'

/** Independent pinhole correspondences for a forward-facing synthetic camera. */
export function exampleInspectionConfig(): InspectionConfig {
  return {
    version: 1, id: 'synthetic-bridge',
    asset: { version: 1, id: 'bridge-face-a', revision: 'synthetic-v1', kind: 'bridge-face', frame: 'LOCAL_NED', axes: 'EAST_UP_SOUTH', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, centerM: [3, 0, -1.8], widthM: 1.6, heightM: 1.2, registrationSigmaM: .01 },
    stations: [{ id: 'left', uM: -.5, vM: 0 }, { id: 'center', uM: 0, vM: 0 }, { id: 'right', uM: .5, vM: 0 }],
    standOffM: 2, speedMps: .4,
    clearance: { minSeparationM: .5, bodyRadiusM: .22, positionBoundM: .15, assetMotionBoundM: .15, brakingAccelerationMps2: 1, reactionMs: 100 },
    quality: { maxGsdM: .05, maxBlurPx: 1, minAssetFraction: .2, maxPoseSigmaM: .15, maxAttitudeSigmaRad: .1, maxStationOffsetM: .35 },
    exposureTimeUs: 1000, power: { availableWh: 30, hoverW: 240, reservePercent: 30 },
    calibration: {
      version: 1, id: 'synthetic-inspection-pinhole', cameraId: 'inspection-fixture', modeId: '640x480-to-96x72', evidence: 'synthetic',
      intrinsics: { width: 640, height: 480, fx: 400, fy: 400, cx: 320, cy: 240, distortion: [0, 0, 0, 0, 0] },
      output: { width: 96, height: 72, crop: [0, 0, 640, 480] },
      extrinsics: { quaternionWxyz: [.5, .5, .5, .5], translationM: [.04, 0, 0] },
      uncertainty: { pixelSigmaPx: .5, depthSigmaM: .01, translationSigmaM: .005, rotationSigmaRad: .001, modelSigmaM: .01 },
      timing: { clockUncertaintyMs: 1, maxSkewMs: 20, maxAgeMs: 100 },
    },
    // Optical [X,Y,Z] maps to body [Z+.04,X,Y]. These literals are independent of projection code.
    heldOut: [
      { id: 'upper-left', pixel: [24, 18], opticalDepthM: .5, bodyPointM: [.54, -.2, -.15] },
      { id: 'upper-right', pixel: [72, 18], opticalDepthM: 1, bodyPointM: [1.04, .4, -.3] },
      { id: 'lower-left', pixel: [24, 54], opticalDepthM: 2, bodyPointM: [2.04, -.8, .6] },
      { id: 'lower-right', pixel: [72, 54], opticalDepthM: 3, bodyPointM: [3.04, 1.2, .9] },
      { id: 'near-left', pixel: [36, 42], opticalDepthM: 4, bodyPointM: [4.04, -.8, .4] },
      { id: 'near-right', pixel: [60, 30], opticalDepthM: 5, bodyPointM: [5.04, 1, -.5] },
    ],
  }
}
