import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { SurveyPlan } from './types'
import { rotateBodyToNed } from '../controls/physics'
import { createModeledCamera } from '../payloads/modeled-camera'
import { createCalibratedCamera } from '../camera/calibrated'
import { intersectSurveyRay } from './geometry'

/** An independently declared ground scene. Colours and marks are in fixed LOCAL_NED metres. */
export function surveyWorldColour(north: number, east: number): [number, number, number] {
  if (!Number.isFinite(north) || !Number.isFinite(east)) throw new RangeError('Invalid synthetic world coordinate')
  if (Math.hypot(north, east) < 0.16) return [240, 40, 30]
  if (Math.hypot(north - 0.5, east + 0.5) < 0.13) return [30, 80, 240]
  const checker = (Math.floor(north * 5) + Math.floor(east * 5)) % 2 === 0
  return [checker ? 90 : 140, Math.round(115 + 35 * Math.sin(north * 11 + east * 7)), checker ? 50 : 85]
}

/** Model truth enters pixels here; capture metadata is supplied separately by the owned estimator. */
export function renderSurveyImage(plan: SurveyPlan, body: RigidBodyState): Uint8Array {
  const camera = createCalibratedCamera(plan.config.calibration, plan.config.heldOut)
  const { width, height } = plan.config.calibration.output
  if (width * height > 65536) throw new RangeError('Synthetic raster budget is 65536 pixels')
  const lever = rotateBodyToNed(body.quaternionWxyz, camera.originBodyM)
  const origin = body.positionM.map((n, i) => n + lever[i]!) as SensorVector
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ray = rotateBodyToNed(body.quaternionWxyz, camera.bodyRay([x + 0.5, y + 0.5]))
    const hit = intersectSurveyRay(plan.config, origin, ray)
    const colour = surveyWorldColour(hit[0], hit[1]), offset = (y * width + x) * 4
    rgba.set([...colour, 255], offset)
  }
  return rgba
}

export interface SurveyShutterCommand { sessionId: string, sequence: number, issuedAtMs: number, reference: string }
export interface SurveyShutterAck extends SurveyShutterCommand { capturedAtMs: number, acknowledgedAtMs: number, rgba: Uint8Array }
export interface SurveyCamera {
  render: (state: RigidBodyState, nowMs: number) => void
  request: (command: SurveyShutterCommand) => void
  poll: (nowMs: number) => SurveyShutterAck | null
  close: () => void
}
/** Mapping adapter preserves the visible-only shutter interface. */
export function createSurveyCamera(plan: SurveyPlan, fault: 'none' | 'loss' | 'wrong-ack' = 'none'): SurveyCamera {
  const camera = createModeledCamera(body => ({ rgba: renderSurveyImage(plan, body), thermalCentiKelvin: null }), { fault })
  return {
    render: camera.render,
    request: camera.request,
    poll(nowMs: number): SurveyShutterAck | null {
      const ack = camera.poll(nowMs)
      if (!ack) return null
      const { thermalCentiKelvin, ...visible } = ack
      void thermalCentiKelvin
      return visible
    },
    close: camera.close,
  }
}
