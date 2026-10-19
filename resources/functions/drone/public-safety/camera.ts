import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { SurveyCamera, SurveyShutterAck } from '../mapping/camera'
import type { PublicSafetyImage, PublicSafetyPlan, PublicSafetyThermalAck } from './types'
import { createCalibratedCamera } from '../camera/calibrated'
import { rotateBodyToNed } from '../controls/physics'
import { intersectSurveyRay } from '../mapping/geometry'
import { createModeledShutter } from '../payloads/modeled-shutter'
import { volumeInsideRing } from '../volumes/geometry'
import { planPublicSafetyMission } from './planner'

/** Analytic synthetic ground texture, never a detector or an evidence annotation. */
function scene(plan: PublicSafetyPlan, north: number, east: number): { rgb: [number, number, number], temperature: number } {
  const checker = (Math.floor(north * 4) + Math.floor(east * 4)) % 2 === 0
  let rgb: [number, number, number] = checker ? [80, 110, 65] : [100, 125, 80], temperature = 29315
  if (plan.config.purpose === 'fire-observation') {
    if (north >= .25 && north <= .65 && east >= -.35 && east <= -.05) { rgb = [80, 65, 55]; temperature = 35315 }
    if (north >= .38 && north <= .48 && east >= -.25 && east <= -.15) temperature = 38315
  }
  else if (plan.config.purpose === 'disaster-assessment') {
    if (north >= .1 && north <= .65 && east >= -.5 && east <= .1) { rgb = [145, 150, 155]; temperature = 29615 }
    if (north >= -.6 && north <= -.2 && east >= .2 && east <= .6) { rgb = [45, 90, 120]; temperature = 28515 }
  }
  else if (Math.hypot(north - .35, east - .15) <= .12) { rgb = [220, 100, 40]; temperature = 31015 }
  // A separate blue registration patch is not a thermal hotspot.
  if (Math.hypot(north + .45, east + .4) <= .1) rgb = [30, 80, 230]
  return { rgb, temperature }
}
function renderer(plan: PublicSafetyPlan) {
  const camera = createCalibratedCamera(plan.config.survey.calibration, plan.config.survey.heldOut)
  const { width, height } = camera.calibration.output
  return (body: RigidBodyState): PublicSafetyImage => {
    if (!Array.isArray(body.positionM) || body.positionM.length !== 3 || !Array.isArray(body.quaternionWxyz) || body.quaternionWxyz.length !== 4 || ![...body.positionM, ...body.quaternionWxyz].every(Number.isFinite) || Math.abs(Math.hypot(...body.quaternionWxyz) - 1) > 1e-6) throw new RangeError('Invalid public-safety rendering pose')
    const rgba = new Uint8Array(width * height * 4), thermalCentiKelvin = new Uint16Array(width * height), support = new Uint8Array(width * height)
    const lever = rotateBodyToNed(body.quaternionWxyz, camera.originBodyM)
    const origin = body.positionM.map((n, i) => n + lever[i]!) as SensorVector
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = y * width + x
      rgba[index * 4 + 3] = 255
      let hit: SensorVector
      try { hit = intersectSurveyRay(plan.config.survey, origin, rotateBodyToNed(body.quaternionWxyz, camera.bodyRay([x + .5, y + .5]))) }
      catch { continue }
      const ground: [number, number] = [hit[0], hit[1]]
      // The same truth ray performs privacy redaction before scene sampling or shutter retention.
      if (plan.config.noObserveZones.some(zone => volumeInsideRing(ground, zone))) { support[index] = 2; continue }
      if (!volumeInsideRing(ground, plan.config.survey.boundary) || plan.config.survey.holes.some(hole => volumeInsideRing(ground, hole))) continue
      const sample = scene(plan, hit[0], hit[1])
      rgba.set(sample.rgb, index * 4); thermalCentiKelvin[index] = sample.temperature; support[index] = 1
    }
    return { width, height, rgba, thermalCentiKelvin, support }
  }
}
/** Ground-plane truth supplies only pixels; estimated pose admission and geolocation stay separate. */
export function renderPublicSafetyImage(plan: PublicSafetyPlan, body: RigidBodyState): PublicSafetyImage {
  return renderer(planPublicSafetyMission(plan.config))(body)
}
/** Numeric thermal data is retained only on actual scoped ACKs, never regenerated after collection. */
export function createPublicSafetyCamera(plan: PublicSafetyPlan, fault: 'none' | 'loss' | 'wrong-ack' = 'none'): { camera: SurveyCamera, thermalAcks: () => PublicSafetyThermalAck[] } {
  const validated = planPublicSafetyMission(plan.config)
  const render = renderer(validated)
  const retained: PublicSafetyThermalAck[] = []
  const shutter = createModeledShutter<PublicSafetyImage>(render, image => ({ width: image.width, height: image.height, rgba: new Uint8Array(image.rgba), thermalCentiKelvin: new Uint16Array(image.thermalCentiKelvin), support: new Uint8Array(image.support) }), { fault })
  const camera: SurveyCamera = {
    render: shutter.render,
    request: shutter.request,
    poll(nowMs: number): SurveyShutterAck | null {
      const ack = shutter.poll(nowMs)
      if (!ack) return null
      if (retained.length >= 256) throw new RangeError('Public-safety capture capacity exceeded')
      const { image, ...scope } = ack
      retained.push({ ...scope, width: image.width, height: image.height, thermalCentiKelvin: new Uint16Array(image.thermalCentiKelvin), support: new Uint8Array(image.support) })
      return { ...scope, rgba: new Uint8Array(image.rgba) }
    },
    close: shutter.close,
  }
  return { camera, thermalAcks: () => retained.map(ack => ({ ...ack, thermalCentiKelvin: new Uint16Array(ack.thermalCentiKelvin), support: new Uint8Array(ack.support) })) }
}
