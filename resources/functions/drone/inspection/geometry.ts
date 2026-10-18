import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { InspectionAsset, InspectionPlan } from './types'
import { createCalibratedCamera } from '../camera/calibrated'
import { rotateBodyToNed } from '../controls/physics'

export function inspectionRotate(q: Quaternion, v: SensorVector): SensorVector { return rotateBodyToNed(q, v) }
export function inspectionAssetPoint(asset: InspectionAsset, uM: number, vM: number): SensorVector {
  return [asset.centerM[0], asset.centerM[1] + uM, asset.centerM[2] - vM]
}
/** Exact minimum distance from a line segment to the finite axis-aligned rectangular face. */
export function inspectionSegmentSeparation(asset: InspectionAsset, from: SensorVector, to: SensorVector): number {
  const low = [asset.centerM[0], asset.centerM[1] - asset.widthM / 2, asset.centerM[2] - asset.heightM / 2]
  const high = [asset.centerM[0], asset.centerM[1] + asset.widthM / 2, asset.centerM[2] + asset.heightM / 2]
  const delta = to.map((n, i) => n - from[i]!), breaks = [0, 1]
  for (let i = 0; i < 3; i++) if (delta[i] !== 0) for (const edge of [low[i]!, high[i]!]) {
    const t = (edge - from[i]!) / delta[i]!
    if (t > 0 && t < 1) breaks.push(t)
  }
  breaks.sort((a, b) => a - b)
  const squared = (t: number) => from.reduce((sum, n, i) => { const p = n + delta[i]! * t; return sum + (p - Math.max(low[i]!, Math.min(high[i]!, p))) ** 2 }, 0)
  let minimum = Math.min(...breaks.map(squared))
  for (let b = 0; b < breaks.length - 1; b++) {
    const left = breaks[b]!, right = breaks[b + 1]!, mid = (left + right) / 2
    let aa = 0, ab = 0
    for (let i = 0; i < 3; i++) {
      const p = from[i]! + delta[i]! * mid
      if (p >= low[i]! && p <= high[i]!) continue
      const edge = p < low[i]! ? low[i]! : high[i]!
      aa += delta[i]! ** 2; ab += delta[i]! * (from[i]! - edge)
    }
    if (aa > 0) minimum = Math.min(minimum, squared(Math.max(left, Math.min(right, -ab / aa))))
  }
  return Math.sqrt(minimum)
}
export function inspectionProjector(plan: InspectionPlan, pose: { positionM: SensorVector, quaternionWxyz: Quaternion }, centerM: SensorVector = plan.config.asset.centerM) {
  if (!Array.isArray(pose.positionM) || pose.positionM.length !== 3 || pose.positionM.some(n => !Number.isFinite(n) || Math.abs(n) > 1000) || !Array.isArray(pose.quaternionWxyz) || pose.quaternionWxyz.length !== 4 || pose.quaternionWxyz.some(n => !Number.isFinite(n)) || Math.abs(Math.hypot(...pose.quaternionWxyz) - 1) > 1e-6 || !Array.isArray(centerM) || centerM.length !== 3 || centerM.some(n => !Number.isFinite(n) || Math.abs(n) > 1000)) throw new RangeError('Invalid inspection projection pose')
  const camera = createCalibratedCamera(plan.config.calibration, plan.config.heldOut)
  const lever = inspectionRotate(pose.quaternionWxyz, camera.originBodyM)
  const origin = pose.positionM.map((n, i) => n + lever[i]!) as SensorVector
  return {
    origin,
    project(pixel: [number, number], finiteFace = true): { pointM: SensorVector, uvM: [number, number], distanceM: number, incidenceRad: number } | null {
      const ray = inspectionRotate(pose.quaternionWxyz, camera.bodyRay(pixel)), norm = Math.hypot(...ray)
      // Visible south side only. Reject parallel/grazing and rear-face projections.
      if (ray[0] / norm < .1 || centerM[0] <= origin[0]) return null
      const t = (centerM[0] - origin[0]) / ray[0]
      if (t < camera.report.minDepthM || t > camera.report.maxDepthM) return null
      const pointM = origin.map((n, i) => n + ray[i]! * t) as SensorVector
      const uvM: [number, number] = [pointM[1] - centerM[1], centerM[2] - pointM[2]]
      if (finiteFace && (Math.abs(uvM[0]) > plan.config.asset.widthM / 2 + 1e-10 || Math.abs(uvM[1]) > plan.config.asset.heightM / 2 + 1e-10)) return null
      return { pointM, uvM, distanceM: t * norm, incidenceRad: Math.acos(Math.max(-1, Math.min(1, ray[0] / norm))) }
    },
  }
}
export function projectInspectionPixel(plan: InspectionPlan, pose: { positionM: SensorVector, quaternionWxyz: Quaternion }, pixel: [number, number], centerM?: SensorVector) {
  return inspectionProjector(plan, pose, centerM).project(pixel)
}
