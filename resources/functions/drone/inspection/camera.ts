import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { InspectionCapture, InspectionCaptureQuality, InspectionImage, InspectionPlan, InspectionRangePacket } from './types'
import { inspectionProjector, inspectionRotate } from './geometry'

/** Pure synthetic face texture sampled by ray intersection, not a defect detector. */
export function renderInspectionImage(plan: InspectionPlan, body: RigidBodyState, centerM?: SensorVector): InspectionImage {
  const { width, height } = plan.config.calibration.output
  const rgba = new Uint8Array(width * height * 4), thermalCentiKelvin = new Uint16Array(width * height)
  const camera = inspectionProjector(plan, body, centerM)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x, hit = camera.project([x + .5, y + .5])
    let color = [15, 23, 32]
    if (hit) {
      const [u, v] = hit.uvM
      const hot = Math.abs(u - .4) <= .12 && Math.abs(v - .2) <= .12
      const central = Math.abs(u) < .08 || Math.abs(v) < .04
      const seam = Math.abs(((u + 10) % .4) - .2) < .014
      color = central ? [38, 49, 61] : seam ? [95, 104, 113] : [180, 186, 190]
      thermalCentiKelvin[index] = hot ? 31315 : 29315
    }
    rgba.set([...color, 255], index * 4)
  }
  return { width, height, rgba, thermalCentiKelvin }
}
/** Exact modeled three-point range instrument. Estimator registration must happen separately. */
export function renderInspectionRange(plan: InspectionPlan, body: RigidBodyState, nowMs: number, sequence: number, centerM: SensorVector = plan.config.asset.centerM): InspectionRangePacket {
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError('Invalid inspection range epoch')
  const asset = plan.config.asset
  const inverse = [body.quaternionWxyz[0], -body.quaternionWxyz[1], -body.quaternionWxyz[2], -body.quaternionWxyz[3]] as typeof body.quaternionWxyz
  const pointsBodyM = ([[-asset.widthM / 2, -asset.heightM / 2], [asset.widthM / 2, -asset.heightM / 2], [-asset.widthM / 2, asset.heightM / 2]] as [number, number][]).map(([u, v]) => inspectionRotate(inverse, [centerM[0] - body.positionM[0], centerM[1] + u - body.positionM[1], centerM[2] - v - body.positionM[2]])) as [SensorVector, SensorVector, SensorVector]
  return { version: 1, evidence: 'modeled-asset-range', assetId: asset.id, revision: asset.revision, sequence, capturedAtMs: nowMs, receivedAtMs: nowMs, rangeSigmaM: .005, clockUncertaintyMs: 1, pointsBodyM }
}
/** Recomputable pixel geometry, translational/rotational blur and declared pose qualification. */
export function inspectCaptureQuality(plan: InspectionPlan, capture: Omit<InspectionCapture, 'quality'>, motion: { velocityMps: number, angularRateRadS: number }): InspectionCaptureQuality {
  const { image } = capture, output = plan.config.calibration.output
  if (image.width !== output.width || image.height !== output.height || !(image.rgba instanceof Uint8Array) || image.rgba.length !== output.width * output.height * 4 || !(image.thermalCentiKelvin instanceof Uint16Array) || image.thermalCentiKelvin.length !== output.width * output.height || ![motion.velocityMps, motion.angularRateRadS, capture.positionSigmaM, capture.attitudeSigmaRad].every(n => Number.isFinite(n) && n >= 0)) throw new RangeError('Invalid inspection quality input')
  const station = plan.stations.find(s => s.id === capture.stationId)
  if (!station) throw new RangeError('Unknown inspection capture station')
  const camera = inspectionProjector(plan, capture.pose, capture.assetObservation.centerM), reasons: string[] = []
  let gsdM = 0, visible = 0, incidence = 0, mismatches = 0
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = y * image.width + x, temperature = image.thermalCentiKelvin[index]!
    if (image.rgba[index * 4 + 3] !== 255 || temperature !== 0 && (temperature < 15000 || temperature > 50000)) throw new RangeError('Invalid inspection image values')
    const hit = camera.project([x + .5, y + .5])
    if ((temperature !== 0) !== !!hit) mismatches++
    if (temperature === 0) continue
    visible++
    if (!hit) continue
    incidence = Math.max(incidence, hit.incidenceRad)
    for (const neighbor of [[Math.min(x + 1.5, image.width), y + .5], [x + .5, Math.min(y + 1.5, image.height)]] as [number, number][]) {
      const next = camera.project(neighbor, false)
      if (next) {
        const pixelStep = Math.hypot(neighbor[0] - x - .5, neighbor[1] - y - .5)
        gsdM = Math.max(gsdM, Math.hypot(...next.pointM.map((n, i) => n - hit.pointM[i]!)) / pixelStep)
      }
    }
  }
  if (!visible || gsdM <= 0) reasons.push('asset not resolved')
  // Estimator pose is uncertain; modest silhouette displacement is expected. Large mismatch fails qualification.
  if (mismatches / (image.width * image.height) > .1) reasons.push('image geometry disagreement')
  // Finite zero metrics carry explicit rejection reasons when no face pixels intersect.
  const focalPx = Math.max(plan.config.calibration.intrinsics.fx * image.width / output.crop[2], plan.config.calibration.intrinsics.fy * image.height / output.crop[3])
  const blurPx = capture.exposureTimeUs / 1e6 * (motion.velocityMps / Math.max(gsdM, 1e-12) + motion.angularRateRadS * focalPx)
  const expected = [capture.assetObservation.centerM[0] - plan.config.standOffM, capture.assetObservation.centerM[1] + station.uM, capture.assetObservation.centerM[2] - station.vM]
  const stationOffsetM = Math.hypot(...capture.pose.positionM.map((n, i) => n - expected[i]!))
  const assetFraction = visible / (image.width * image.height), q = plan.config.quality
  if (gsdM > q.maxGsdM) reasons.push('GSD exceeded')
  if (blurPx > q.maxBlurPx) reasons.push('motion blur exceeded')
  if (assetFraction < q.minAssetFraction) reasons.push('asset fraction insufficient')
  if (capture.positionSigmaM > q.maxPoseSigmaM) reasons.push('position uncertainty exceeded')
  if (capture.attitudeSigmaRad > q.maxAttitudeSigmaRad) reasons.push('attitude uncertainty exceeded')
  if (stationOffsetM > q.maxStationOffsetM) reasons.push('station offset exceeded')
  if (incidence > Math.PI / 3) reasons.push('view incidence exceeded')
  return { qualified: reasons.length === 0, reasons: [...new Set(reasons)], gsdM, blurPx, assetFraction, stationOffsetM, viewIncidenceRad: incidence, velocityMps: motion.velocityMps, angularRateRadS: motion.angularRateRadS }
}
