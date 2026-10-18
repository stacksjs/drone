import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { SurveyConfig, SurveyPlan, SurveyPoint } from './types'
import { createCalibratedCamera } from '../camera/calibrated'
import { rotateBodyToNed } from '../controls/physics'

/** Plane intersection. Ray scale is preserved, so optical rays with Z=1 yield optical depth. */
export function intersectSurveyRay(config: SurveyConfig, origin: SensorVector, ray: SensorVector): SensorVector {
  if (![...origin, ...ray, config.terrain.downAtOriginM, ...config.terrain.gradient].every(Number.isFinite)) throw new RangeError('Invalid survey ray')
  const [gn, ge] = config.terrain.gradient
  const denominator = ray[2] - gn * ray[0] - ge * ray[1]
  if (denominator <= .1) throw new RangeError('Survey ray is at or above the terrain horizon')
  const depth = (config.terrain.downAtOriginM + gn * origin[0] + ge * origin[1] - origin[2]) / denominator
  const depths = config.heldOut.map(sample => sample.opticalDepthM)
  if (depth < Math.min(...depths) || depth > Math.max(...depths)) throw new RangeError('Survey terrain outside held-out optical depths')
  return origin.map((value, i) => value + ray[i]! * depth) as SensorVector
}

/** Four image-corner intersections including the calibrated body-to-camera lever arm. */
export function projectSurveyFootprint(plan: SurveyPlan, positionM: SensorVector, quaternionWxyz: Quaternion): SurveyPoint[] {
  if (positionM.length !== 3 || quaternionWxyz.length !== 4 || ![...positionM, ...quaternionWxyz].every(Number.isFinite) || Math.abs(Math.hypot(...quaternionWxyz) - 1) > 1e-6) throw new RangeError('Invalid survey capture pose')
  const camera = createCalibratedCamera(plan.config.calibration, plan.config.heldOut)
  const lever = rotateBodyToNed(quaternionWxyz, camera.originBodyM)
  const origin = positionM.map((n, i) => n + lever[i]!) as SensorVector
  const { width, height } = plan.config.calibration.output
  return ([[0, 0], [width, 0], [width, height], [0, height]] as SurveyPoint[]).map(pixel => {
    const point = intersectSurveyRay(plan.config, origin, rotateBodyToNed(quaternionWxyz, camera.bodyRay(pixel)))
    return [point[0], point[1]]
  })
}
