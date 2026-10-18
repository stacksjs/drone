import type { SurveyConfig } from './types'

/** Independent synthetic nadir-camera correspondences, never a Pi calibration. */
export function exampleSurveyConfig(): SurveyConfig {
  return {
    version: 1, id: 'synthetic-survey', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 },
    boundary: [[-.8, -.8], [.8, -.8], [.8, .8], [-.8, .8]], holes: [],
    altitudeAglM: 1.5, maxGsdM: .1, overlap: { front: .6, side: .6 }, headingDeg: 0, crosshatch: false,
    terrain: { downAtOriginM: 0, gradient: [0, 0] }, speedMps: .4, minTriggerIntervalMs: 200, exposureTimeUs: 1000,
    power: { availableWh: 30, hoverW: 240, reservePercent: 30 },
    calibration: {
      version: 1, id: 'synthetic-survey-brown5', cameraId: 'survey-fixture', modeId: '640x480-to-96x72', evidence: 'synthetic',
      intrinsics: { width: 640, height: 480, fx: 400, fy: 400, cx: 320, cy: 240, distortion: [.04, 0, 0, 0, 0] },
      output: { width: 96, height: 72, crop: [0, 0, 640, 480] },
      extrinsics: { quaternionWxyz: [Math.SQRT1_2, 0, 0, -Math.SQRT1_2], translationM: [0, 0, .04] },
      uncertainty: { pixelSigmaPx: .5, depthSigmaM: .01, translationSigmaM: .005, rotationSigmaRad: .001, modelSigmaM: .01 },
      timing: { clockUncertaintyMs: 1, maxSkewMs: 20, maxAgeMs: 100 },
    },
    // Rays (+/-.4,+/-.3) have radial factor1.01. Body[Y,-X,Z+.04].
    heldOut: [
      { id: 'upper-left', pixel: [23.76, 17.82], opticalDepthM: .5, bodyPointM: [-.15, .2, .54] },
      { id: 'upper-right', pixel: [72.24, 17.82], opticalDepthM: 1, bodyPointM: [-.3, -.4, 1.04] },
      { id: 'lower-left', pixel: [23.76, 54.18], opticalDepthM: 2, bodyPointM: [.6, .8, 2.04] },
      { id: 'lower-right', pixel: [72.24, 54.18], opticalDepthM: 3, bodyPointM: [.9, -1.2, 3.04] },
      { id: 'near-left', pixel: [35.976, 42.012], opticalDepthM: 4, bodyPointM: [.4, .8, 4.04] },
      { id: 'near-right', pixel: [60.024, 29.988], opticalDepthM: 5, bodyPointM: [-.5, -1, 5.04] },
    ],
  }
}
