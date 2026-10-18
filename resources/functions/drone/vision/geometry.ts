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
function dimension(value: unknown): void { number(value, 16, 8192, 'image dimension'); if (!Number.isInteger(value)) fail('integer image dimension') }
function evidence(value: unknown): void { if (value !== 'synthetic' && value !== 'declared-bench') fail('evidence') }

/** Brown5 Jacobian is symmetric. This conservative norm bound certifies no folds on radius <=2. */
function jacobianLowerBound(c: VisionCalibration): number {
  const [k1, k2, p1, p2, k3] = c.intrinsics.distortion
  return 1 - 12 * Math.abs(k1) - 80 * Math.abs(k2) - 448 * Math.abs(k3) - 16 * (Math.abs(p1) + Math.abs(p2))
}
function distort(x: number, y: number, c: VisionCalibration): [number, number, number, number, number] {
  const [k1, k2, p1, p2, k3] = c.intrinsics.distortion
  const r2 = x * x + y * y, radial = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
  const slope = 2 * (k1 + 2 * k2 * r2 + 3 * k3 * r2 ** 2)
  return [x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x), y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y, radial + x * x * slope + 2 * p1 * y + 6 * p2 * x, x * y * slope + 2 * p1 * x + 2 * p2 * y, radial + y * y * slope + 6 * p1 * y + 2 * p2 * x]
}
function ray(pixel: [number, number], c: VisionCalibration): SensorVector {
  tuple(pixel, 2, 8192, 'pixel')
  if (pixel[0] < 0 || pixel[1] < 0 || pixel[0] > c.output.width || pixel[1] > c.output.height) fail('pixel outside calibrated output')
  const i = c.intrinsics, crop = c.output.crop
  const u = (crop[0] + pixel[0] * crop[2] / c.output.width - i.cx) / i.fx
  const v = (crop[1] + pixel[1] * crop[3] / c.output.height - i.cy) / i.fy
  let x = u, y = v
  for (let iteration = 0; iteration < 30; iteration++) {
    if (Math.hypot(x, y) > 2) fail('ray outside certified lens domain')
    const [dx, dy, a, b, d] = distort(x, y, c)
    const ex = dx - u, ey = dy - v, det = a * d - b * b
    if (det <= 0.01 || !Number.isFinite(det)) fail('distortion Jacobian')
    if (Math.hypot(ex * i.fx, ey * i.fy) < 1e-7) return [x, y, 1]
    x -= (d * ex - b * ey) / det
    y -= (a * ey - b * ex) / det
  }
  return fail('distortion inversion did not converge')
}
function bodyPoint(pixel: [number, number], depth: number, c: VisionCalibration): SensorVector {
  const result = rotate(c.extrinsics.quaternionWxyz, ray(pixel, c).map(n => n * depth) as SensorVector)
  return result.map((n, index) => n + c.extrinsics.translationM[index]!) as SensorVector
}
function validateCalibration(value: VisionCalibration): VisionCalibration {
  record(value, ['version', 'id', 'cameraId', 'modeId', 'evidence', 'intrinsics', 'output', 'extrinsics', 'uncertainty', 'timing'], 'calibration')
  if (value.version !== 1) fail('calibration version')
  identifier(value.id, 'calibration id'); identifier(value.cameraId, 'camera id'); identifier(value.modeId, 'mode id'); evidence(value.evidence)
  const i = value.intrinsics, o = value.output, e = value.extrinsics, u = value.uncertainty, t = value.timing
  record(i, ['width', 'height', 'fx', 'fy', 'cx', 'cy', 'distortion'], 'intrinsics')
  dimension(i.width); dimension(i.height)
  number(i.fx, i.width / 10, i.width * 10, 'fx'); number(i.fy, i.height / 10, i.height * 10, 'fy')
  number(i.cx, 0, i.width, 'cx'); number(i.cy, 0, i.height, 'cy'); tuple(i.distortion, 5, 1, 'Brown5 distortion')
  record(o, ['width', 'height', 'crop'], 'output'); dimension(o.width); dimension(o.height); tuple(o.crop, 4, 8192, 'crop')
  if (o.crop.some(n => !Number.isInteger(n)) || o.crop[0] < 0 || o.crop[1] < 0 || o.crop[2] < 16 || o.crop[3] < 16 || o.crop[0] + o.crop[2] > i.width || o.crop[1] + o.crop[3] > i.height) fail('crop outside calibrated sensor mode')
  record(e, ['quaternionWxyz', 'translationM'], 'extrinsics'); quaternion(e.quaternionWxyz); tuple(e.translationM, 3, 2, 'extrinsic translation')
  record(u, ['pixelSigmaPx', 'depthSigmaM', 'translationSigmaM', 'rotationSigmaRad', 'modelSigmaM'], 'uncertainty')
  number(u.pixelSigmaPx, 0.1, 10, 'pixel uncertainty'); number(u.depthSigmaM, 0.0001, 1, 'depth uncertainty'); number(u.translationSigmaM, 0.0001, 0.5, 'translation uncertainty'); number(u.rotationSigmaRad, 0.00001, 0.2, 'rotation uncertainty'); number(u.modelSigmaM, 0.0001, 0.05, 'model uncertainty')
  record(t, ['clockUncertaintyMs', 'maxSkewMs', 'maxAgeMs'], 'timing'); number(t.clockUncertaintyMs, 0, 20, 'camera clock uncertainty'); number(t.maxSkewMs, 0, 20, 'synchronization budget'); number(t.maxAgeMs, 1, 200, 'age budget')
  if (jacobianLowerBound(value) < 0.1) fail('lens may fold inside certified domain')
  for (const pixel of [[0, 0], [o.width, 0], [0, o.height], [o.width, o.height]] as [number, number][]) ray(pixel, value)
  return structuredClone(value)
}

/** Metric output requires a caller-supplied, independently validated registered-depth calibration. */
export function createVisionLocalizer(calibration: VisionCalibration, heldOut: VisionValidationSample[]): { readonly report: VisionCalibrationReport, localize: (input: VisionLocalizationInput) => VisionMetricObservation } {
  const c = validateCalibration(calibration)
  if (!Array.isArray(heldOut) || heldOut.length < 6 || heldOut.length > 256) fail('six to 256 independent held-out samples required')
  const ids = new Set<string>(), depths: number[] = [], xs: number[] = [], ys: number[] = [], errors: number[] = []
  for (const sample of heldOut) {
    record(sample, ['id', 'pixel', 'opticalDepthM', 'bodyPointM'], 'validation sample'); identifier(sample.id, 'validation id')
    if (ids.has(sample.id)) fail('duplicate held-out sample'); ids.add(sample.id)
    number(sample.opticalDepthM, 0.25, 100, 'validation depth'); tuple(sample.bodyPointM, 3, 5000, 'validation body point')
    const calculated = bodyPoint(sample.pixel, sample.opticalDepthM, c)
    errors.push(Math.hypot(...calculated.map((n, index) => n - sample.bodyPointM[index]!)))
    depths.push(sample.opticalDepthM); xs.push(sample.pixel[0]); ys.push(sample.pixel[1])
  }
  const principalX = (c.intrinsics.cx - c.output.crop[0]) * c.output.width / c.output.crop[2], principalY = (c.intrinsics.cy - c.output.crop[1]) * c.output.height / c.output.crop[3]
  if (!(Math.min(...xs) < principalX && Math.max(...xs) > principalX && Math.min(...ys) < principalY && Math.max(...ys) > principalY) || Math.max(...xs) - Math.min(...xs) < c.output.width / 4 || Math.max(...ys) - Math.min(...ys) < c.output.height / 4 || Math.max(...depths) / Math.min(...depths) < 1.5) fail('held-out coverage needs both image axes and multiple depths')
  const report: VisionCalibrationReport = { calibrationId: c.id, evidence: c.evidence, samples: heldOut.length, rmsErrorM: Math.sqrt(errors.reduce((sum, n) => sum + n * n, 0) / errors.length), maxErrorM: Math.max(...errors), minDepthM: Math.min(...depths), maxDepthM: Math.max(...depths), physicalCalibrationVerified: false }
  if (report.maxErrorM > 0.15 || report.maxErrorM > c.uncertainty.modelSigmaM * 3) fail('held-out residual exceeds declared model budget')
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
      if (now - Math.min(camera.capturedAtMs, depth.capturedAtMs, pose.capturedAtMs) + clockUncertaintyMs > c.timing.maxAgeMs) fail('capture age uncertainty budget')
      if (poseSkewMs + depthSkewMs + clockUncertaintyMs > c.timing.maxSkewMs) fail('capture synchronization budget')
      const body = bodyPoint(depth.pixel, depth.opticalDepthM, c)
      const rotated = rotate(pose.quaternionWxyz, body)
      const positionM = rotated.map((n, index) => n + pose.positionM[index]!) as SensorVector
      tuple(positionM, 3, 5000, 'localized position')
      const opticalRay = ray(depth.pixel, c), opticalRangeM = depth.opticalDepthM * Math.hypot(...opticalRay), u = c.uncertainty
      const pixelRaySigma = u.pixelSigmaPx * Math.hypot(c.output.crop[2] / c.output.width / c.intrinsics.fx, c.output.crop[3] / c.output.height / c.intrinsics.fy) / jacobianLowerBound(c)
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
      return { evidence: c.evidence, calibrationId: c.id, cameraSessionId: camera.sessionId, lockId: selected.id, candidateId: association.candidateId, frameSequence: camera.frameSequence, depthSourceId: depth.sourceId, depthSequence: depth.sequence, reference: pose.reference, capturedAtMs: camera.capturedAtMs, receivedAtMs: Math.max(camera.receivedAtMs, depth.receivedAtMs, pose.capturedAtMs), positionM, sigmaM, physicalFlightEnabled: false }
    },
  }
}
