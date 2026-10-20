import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { VisionCalibration, VisionValidationSample } from '../vision/types'
import type { CinemaImage, CinemaQuality } from './types'
import { createCalibratedCamera } from '../camera/calibrated'
import { multiplyQuaternion } from '../estimation/frames'
import { rotateBodyToNed } from '../controls/physics'
import { cinemaJointQuaternion, neutralOptical } from './gimbal'

export function cinemaModel() {
  const calibration: VisionCalibration = {
    version: 1, id: 'synthetic-cinema-forward-v1', cameraId: 'cinema-camera-fixture', modeId: '64x48-fixed-forward-v1', evidence: 'synthetic',
    intrinsics: { width: 64, height: 48, fx: 40, fy: 40, cx: 32, cy: 24, distortion: [0, 0, 0, 0, 0] }, output: { width: 64, height: 48, crop: [0, 0, 64, 48] },
    extrinsics: { quaternionWxyz: [0.5, 0.5, 0.5, 0.5], translationM: [0, 0, 0] }, uncertainty: { pixelSigmaPx: 0.5, depthSigmaM: 0.01, translationSigmaM: 0.001, rotationSigmaRad: 0.001, modelSigmaM: 0.001 }, timing: { clockUncertaintyMs: 0, maxSkewMs: 20, maxAgeMs: 100 },
  }
  const heldOut: VisionValidationSample[] = [
    { id: 'upper-left', pixel: [16, 12], opticalDepthM: 1, bodyPointM: [1, -0.4, -0.3] },
    { id: 'upper-right', pixel: [48, 12], opticalDepthM: 2, bodyPointM: [2, 0.8, -0.6] },
    { id: 'lower-left', pixel: [16, 36], opticalDepthM: 4, bodyPointM: [4, -1.6, 1.2] },
    { id: 'lower-right', pixel: [48, 36], opticalDepthM: 6, bodyPointM: [6, 2.4, 1.8] },
    { id: 'near-left', pixel: [24, 30], opticalDepthM: 8, bodyPointM: [8, -1.6, 1.2] },
    { id: 'near-right', pixel: [40, 18], opticalDepthM: 10, bodyPointM: [10, 2, -1.5] },
  ]
  return {
    clock: { domain: 'owned-fixture-ms', vehiclePlantStepMs: 4, policyStepMs: 20, firstInstrumentAtMs: 600, gimbalStepMs: 4, encoderDelayMs: 20, tailMs: 2000 },
    frames: { world: 'LOCAL_NED', body: 'BODY_FRD', optical: 'RIGHT_DOWN_FORWARD', jointOrder: 'RzRyRx', neutralQuaternion: [0.5, 0.5, 0.5, 0.5], heading: 'initial-simulation-north' },
    gimbal: { inertiaKgM2: 0.01, dampingNmsRad: 0.01, torqueLimitNm: 0.02, torqueSlewNmS: 0.02, kpNmRad: 0.12, kdNmsRad: 0.04, encoderQuantumRad: 0.001, travelDeg: [[-20, 20], [-45, 45], [-45, 45]] },
    referencePath: { legMs: 3000, holdMs: 2000, yawOffsetDeg: 8, triggerOffsetsMs: [1000, 3000, 7000] }, calibration, heldOut,
    marker: { widthM: 0.8, heightM: 0.6, backgroundRgba: [16, 20, 24, 255], baseRgba: [96, 104, 112, 255], regions: [{ bounds: [-0.12, 0.12, -0.12, 0.12], rgba: [240, 20, 180, 255] }, { bounds: [-0.32, -0.20, -0.20, -0.08], rgba: [230, 40, 30, 255] }, { bounds: [0.18, 0.30, 0.10, 0.22], rgba: [20, 80, 230, 255] }] },
    readiness: { durationMs: 500, maxSpeedMps: 0.15, maxPositionOffsetM: 0.15, maxJointErrorDeg: 0.5, maxEncoderRateRadS: 0.05, maxTargetAgeMs: 100, latestStartAfterLoiterMs: 1600, qualityPixels: 2 },
    disturbance: { beginAfterShotMs: 400, durationMs: 6000, rollAmplitudeNm: 0.0005, pitchAmplitudeNm: 0.0004, rollPeriodMs: 1000, pitchPeriodMs: 1400, envelope: 'sin-squared' },
  }
}
/** Actual pose/joints are confined to this optical renderer and retained exposure facts. */
export function createCinemaRenderer(model: ReturnType<typeof cinemaModel>, target: SensorVector) {
  const geometry = createCalibratedCamera(model.calibration, model.heldOut)
  return (state: RigidBodyState, joints: SensorVector): CinemaImage => {
    const q = multiplyQuaternion(multiplyQuaternion(state.quaternionWxyz, cinemaJointQuaternion(joints)), neutralOptical)
    const bytes = new Uint8Array(64 * 48 * 4)
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
      const ray = rotateBodyToNed(q, geometry.opticalRay([x + 0.5, y + 0.5]))
      const depth = ray[0] > 1e-9 ? (target[0] - state.positionM[0]) / ray[0] : -1
      let color = model.marker.backgroundRgba
      if (depth >= 1 && depth <= 10) {
        const right = state.positionM[1] + depth * ray[1] - target[1], down = state.positionM[2] + depth * ray[2] - target[2]
        if (right >= -0.4 && right < 0.4 && down >= -0.3 && down < 0.3) {
          color = model.marker.baseRgba
          for (const region of model.marker.regions) if (right >= region.bounds[0]! && right < region.bounds[1]! && down >= region.bounds[2]! && down < region.bounds[3]!) { color = region.rgba; break }
        }
      }
      bytes.set(color, (y * 64 + x) * 4)
    }
    return { width: 64, height: 48, rgba: Array.from(bytes) }
  }
}
/** Independent image-color centroid against the analytic intended pinhole pixel. */
export function cinemaImageQuality(image: CinemaImage | null, offset: number): CinemaQuality {
  const expectedPixel: [number, number] = [32 - 40 * Math.tan(offset), 24]
  let x = 0, y = 0, count = 0
  if (image) for (let pixel = 0; pixel < 3072; pixel++) {
    const i = pixel * 4
    if (image.rgba[i] === 240 && image.rgba[i + 1] === 20 && image.rgba[i + 2] === 180) { x += pixel % 64 + 0.5; y += Math.floor(pixel / 64) + 0.5; count++ }
  }
  const observedPixel: [number, number] | null = count ? [x / count, y / count] : null
  const errorPx = observedPixel ? Math.hypot(observedPixel[0] - expectedPixel[0], observedPixel[1] - expectedPixel[1]) : null
  return { expectedPixel, observedPixel, errorPx, markerPixels: count, qualified: errorPx !== null && errorPx <= 2 }
}
