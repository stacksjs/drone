import { createCalibratedCamera } from '../camera/calibrated'
import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { VisionCalibration, VisionCalibrationReport, VisionLocalizationInput, VisionMetricObservation, VisionValidationSample } from './types'

function fail(message: string): never { throw new RangeError(`Unqualified vision measurement: ${message}`) }
function record(value: unknown, fields: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) fail(`${name} fields`)
}
function number(value: unknown, min: number, max: number, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(name)
}
function identifier(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001F\u007F]/.test(value)) fail(name)
}
function tuple(value: unknown, length: number, limit: number, name: string): void {
  if (!Array.isArray(value) || value.length !== length) fail(name)
  for (const n of value) number(n, -limit, limit, name)
}
function quaternion(value: unknown): asserts value is Quaternion {
  tuple(value, 4, 1, 'quaternion')
  if (Math.abs(Math.hypot(...value as number[]) - 1) > 1e-6) fail('quaternion norm')
}
function rotate(q: Quaternion, vector: SensorVector): SensorVector {
  const [w, x, y, z] = q, [a, b, c] = vector
  return [(1 - 2 * (y * y + z * z)) * a + 2 * (x * y - z * w) * b + 2 * (x * z + y * w) * c, 2 * (x * y + z * w) * a + (1 - 2 * (x * x + z * z)) * b + 2 * (y * z - x * w) * c, 2 * (x * z - y * w) * a + 2 * (y * z + x * w) * b + (1 - 2 * (x * x + y * y)) * c]
}
function evidence(value: unknown): void { if (value !== 'synthetic' && value !== 'declared-bench') fail('evidence') }

/** Metric output requires a caller-supplied, independently validated registered-depth calibration. */
export function createVisionLocalizer(calibration: VisionCalibration, heldOut: VisionValidationSample[]): { readonly report: VisionCalibrationReport, localize: (input: VisionLocalizationInput) => VisionMetricObservation } {
  const calibrated = createCalibratedCamera(calibration, heldOut)
  const c = calibrated.calibration, report = calibrated.report
  return {
    get report() { return structuredClone(report) },
    localize(input) {
      record(input, ['nowMs', 'tracking', 'camera', 'depth', 'pose'], 'localization input'); number(input.nowMs, 0, Number.MAX_SAFE_INTEGER, 'clock')
      const { tracking, camera, depth, pose } = input, now = input.nowMs
      record(camera, ['cameraId', 'sessionId', 'modeId', 'frameSequence', 'capturedAtMs', 'receivedAtMs'], 'camera epoch')
      identifier(camera.sessionId, 'camera session'); number(camera.frameSequence, 0, Number.MAX_SAFE_INTEGER, 'camera sequence')
      if (!Number.isSafeInteger(camera.frameSequence) || camera.cameraId !== c.cameraId || camera.modeId !== c.modeId) fail('camera mode or sequence')
      for (const time of [camera.capturedAtMs, camera.receivedAtMs]) number(time, Math.max(0, now - c.timing.maxAgeMs), now, 'camera age')
      if (camera.receivedAtMs < camera.capturedAtMs) fail('camera receipt precedes capture')
      const association = tracking?.association, selected = tracking?.selected
      if (!association || tracking.state !== 'tracking' || !tracking.confirmed || !tracking.observation || !selected || tracking.sequence !== camera.frameSequence || association.frameSequence !== camera.frameSequence || association.capturedAtMs !== camera.capturedAtMs || selected.lastSeenAtMs !== camera.capturedAtMs || selected.confirmations < 3) fail('current confirmed visual association required')
      identifier(selected.id, 'lock id'); identifier(association.candidateId, 'candidate id')
      if (!Array.isArray(tracking.candidates) || tracking.candidates.length > 32) fail('candidates')
      const candidates = tracking.candidates.filter(candidate => candidate.id === association.candidateId)
      if (candidates.length !== 1) fail('ambiguous associated candidate')
      const candidate = candidates[0]!, box = selected.box
      number(selected.confidence, 0.65, 1, 'selected confidence'); number(candidate.confidence, 0.65, 1, 'candidate confidence'); number(selected.confirmations, 3, Number.MAX_SAFE_INTEGER, 'confirmations')
      if (!Number.isSafeInteger(selected.confirmations) || candidate.confidence !== selected.confidence) fail('confirmed detection confidence')
      number(tracking.observation.horizontalError, -1, 1, 'horizontal image observation'); number(tracking.observation.verticalError, -1, 1, 'vertical image observation')
      record(box, ['x', 'y', 'width', 'height'], 'selected box')
      for (const n of [box.x, box.y, box.width, box.height]) number(n, 0, 1, 'normalized selected box')
      if (!box.width || !box.height || box.x + box.width > 1 || box.y + box.height > 1 || candidate.label !== 'person' || candidate.box.x !== box.x || candidate.box.y !== box.y || candidate.box.width !== box.width || candidate.box.height !== box.height) fail('selected detection does not match association')
      if (!depth || !pose) fail('registered depth and aligned capture pose required')
      record(depth, ['evidence', 'sourceId', 'sequence', 'calibrationId', 'cameraSessionId', 'frameSequence', 'candidateId', 'capturedAtMs', 'receivedAtMs', 'pixel', 'opticalDepthM', 'sigmaM', 'clockUncertaintyMs'], 'registered depth')
      evidence(depth.evidence); identifier(depth.sourceId, 'depth source'); number(depth.sequence, 0, Number.MAX_SAFE_INTEGER, 'depth sequence')
      if (!Number.isSafeInteger(depth.sequence) || depth.evidence !== c.evidence || depth.calibrationId !== c.id || depth.cameraSessionId !== camera.sessionId || depth.frameSequence !== camera.frameSequence || depth.candidateId !== association.candidateId) fail('registered depth association')
      number(depth.opticalDepthM, report.minDepthM, report.maxDepthM, 'depth outside held-out coverage'); number(depth.sigmaM, c.uncertainty.depthSigmaM, 1, 'understated depth uncertainty'); number(depth.clockUncertaintyMs, 0, 20, 'depth clock uncertainty')
      for (const time of [depth.capturedAtMs, depth.receivedAtMs]) number(time, Math.max(0, now - c.timing.maxAgeMs), now, 'depth age')
      if (depth.receivedAtMs < depth.capturedAtMs) fail('depth receipt precedes capture')
      tuple(depth.pixel, 2, 8192, 'registered pixel')
      const centre: [number, number] = [(box.x + box.width / 2) * c.output.width, (box.y + box.height / 2) * c.output.height]
      if (Math.hypot(depth.pixel[0] - centre[0], depth.pixel[1] - centre[1]) > 1e-6) fail('depth is not registered at selected detection centre')
      record(pose, ['evidence', 'reference', 'capturedAtMs', 'positionM', 'quaternionWxyz', 'positionSigmaM', 'attitudeSigmaRad', 'clockUncertaintyMs', 'headingAlignment'], 'capture pose')
      evidence(pose.evidence); identifier(pose.reference, 'pose reference'); tuple(pose.positionM, 3, 5000, 'pose position'); quaternion(pose.quaternionWxyz)
      if (pose.evidence !== c.evidence || (pose.headingAlignment !== 'initial-simulation-north' && pose.headingAlignment !== 'surveyed-body-to-ned') || (pose.evidence === 'declared-bench' && pose.headingAlignment !== 'surveyed-body-to-ned')) fail('qualified heading alignment required')
      number(pose.capturedAtMs, Math.max(0, now - c.timing.maxAgeMs), now, 'pose age'); number(pose.positionSigmaM, 0.0001, 5, 'pose position uncertainty'); number(pose.attitudeSigmaRad, 0.00001, 0.2, 'pose attitude uncertainty'); number(pose.clockUncertaintyMs, 0, 20, 'pose clock uncertainty')
      const poseSkewMs = Math.abs(pose.capturedAtMs - camera.capturedAtMs), depthSkewMs = Math.abs(depth.capturedAtMs - camera.capturedAtMs), clockUncertaintyMs = c.timing.clockUncertaintyMs + depth.clockUncertaintyMs + pose.clockUncertaintyMs
      // Unknown clock correlations share the same additive budget as synchronization.
      // Every contributing capture must remain fresh even at its oldest possible epoch.
      const validUntilMs = Math.min(camera.capturedAtMs, depth.capturedAtMs, pose.capturedAtMs) + c.timing.maxAgeMs - clockUncertaintyMs
      number(validUntilMs, camera.capturedAtMs, Number.MAX_SAFE_INTEGER, 'capture age uncertainty expiry')
      if (now > validUntilMs) fail('capture age uncertainty budget')
      if (poseSkewMs + depthSkewMs + clockUncertaintyMs > c.timing.maxSkewMs) fail('capture synchronization budget')
      const body = calibrated.bodyPoint(depth.pixel, depth.opticalDepthM)
      const rotated = rotate(pose.quaternionWxyz, body)
      const positionM = rotated.map((n, index) => n + pose.positionM[index]!) as SensorVector
      tuple(positionM, 3, 5000, 'localized position')
      const opticalRay = calibrated.opticalRay(depth.pixel), opticalRangeM = depth.opticalDepthM * Math.hypot(...opticalRay), u = c.uncertainty
      const pixelRaySigma = calibrated.pixelRaySigma
      if (Math.hypot(opticalRay[0], opticalRay[1]) + pixelRaySigma > 2) fail('pixel uncertainty leaves certified lens domain')
      // Add finite depth/pixel and transform cross terms instead of assuming independent errors.
      const opticalPointSigmaM = Math.hypot(...opticalRay) * depth.sigmaM + (depth.opticalDepthM + depth.sigmaM) * pixelRaySigma
      const cameraTransformSigmaM = opticalPointSigmaM + u.translationSigmaM + (opticalRangeM + opticalPointSigmaM) * u.rotationSigmaRad
      const vehicleTimingMotionSigmaM = 3 * (poseSkewMs + clockUncertaintyMs) / 1000
      const targetTimingMotionSigmaM = 2 * (depthSkewMs + clockUncertaintyMs) / 1000
      // The estimator rejects rates above 35rad/s. Even a stationary vehicle may
      // rotate through the full synchronization interval, including depth skew.
      const angularTimingMotionSigmaM = Math.max(opticalRangeM, Math.hypot(...body)) * 35 * (poseSkewMs + depthSkewMs + clockUncertaintyMs) / 1000
      const sigmaM = pose.positionSigmaM + cameraTransformSigmaM + (Math.hypot(...body) + cameraTransformSigmaM) * pose.attitudeSigmaRad + u.modelSigmaM + vehicleTimingMotionSigmaM + targetTimingMotionSigmaM + angularTimingMotionSigmaM
      number(sigmaM, 0.0001, 10, 'localization uncertainty')
      return { evidence: c.evidence, calibrationId: c.id, cameraSessionId: camera.sessionId, lockId: selected.id, candidateId: association.candidateId, frameSequence: camera.frameSequence, depthSourceId: depth.sourceId, depthSequence: depth.sequence, reference: pose.reference, capturedAtMs: camera.capturedAtMs, receivedAtMs: Math.max(camera.receivedAtMs, depth.receivedAtMs, pose.capturedAtMs), validUntilMs, positionM, sigmaM, physicalFlightEnabled: false }
    },
  }
}
