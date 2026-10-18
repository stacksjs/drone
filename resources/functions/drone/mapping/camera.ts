import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { SurveyPlan } from './types'
import { rotateBodyToNed } from '../controls/physics'
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
/** Single request, no retry. A modeled shutter ACK carries the exact image and capture scope. */
export function createSurveyCamera(plan: SurveyPlan, fault: 'none' | 'loss' | 'wrong-ack' = 'none') {
  let latest: { state: RigidBodyState, nowMs: number } | null = null
  let pending: SurveyShutterAck | null = null, closed = false, sequence = 0
  let faultAtMs: number | null = null
  return {
    render(state: RigidBodyState, nowMs: number) { if (!closed) latest = { state: structuredClone(state), nowMs } },
    request(command: SurveyShutterCommand) {
      if (closed || pending || !latest || command.issuedAtMs !== latest.nowMs || command.sequence !== sequence + 1) throw new RangeError('Invalid or ambiguous synthetic shutter request')
      sequence = command.sequence
      const image = renderSurveyImage(plan, latest.state)
      // The stream returns after two seconds, but the collector must retain a fault latch.
      if (command.issuedAtMs >= 12000 && faultAtMs === null) faultAtMs = command.issuedAtMs
      const failed = faultAtMs !== null && command.issuedAtMs < faultAtMs + 2000
      pending = { ...command, reference: failed && fault === 'wrong-ack' ? 'wrong-reference' : command.reference, capturedAtMs: command.issuedAtMs, acknowledgedAtMs: failed && fault === 'loss' ? command.issuedAtMs + 2000 : command.issuedAtMs + 20, rgba: image }
    },
    poll(nowMs: number): SurveyShutterAck | null {
      if (!pending || pending.acknowledgedAtMs > nowMs) return null
      const ack = pending; pending = null; return structuredClone(ack)
    },
    close() { closed = true; latest = null; pending = null },
  }
}
