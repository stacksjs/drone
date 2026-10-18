import type { InspectionCapture, InspectionCaptureQuality, InspectionComparison, InspectionReview, InspectionReviewInput, InspectionRun } from './types'
import { rotateBodyToNed } from '../controls/physics'
import { missionLimits, replayMission } from '../missions/engine'
import { inspectCaptureQuality } from './camera'
import { projectInspectionPixel } from './geometry'
import { createInspectionPlan } from './planner'
import { inspectionCapturePolicy } from './policy'

export const inspectionEvidenceLimits = Object.freeze({ captures: 64, pixels: 65536, rawBytes: 64 * 1024 * 1024, recordingBytes: 8 * 1024 * 1024, manifestBytes: 16 * 1024 * 1024, reviews: 1024, acknowledgementMs: 80, clockUncertaintyMs: 5 })
function fail(message: string): never { throw new TypeError(`Invalid inspection evidence: ${message}`) }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype }
function fields(value: unknown, expected: readonly string[]) {
  if (!record(value)) fail('expected record')
  let count = 0
  for (const key in value) { if (!Object.hasOwn(value, key) || !expected.includes(key) || ++count > expected.length) fail('unsupported fields') }
  if (count !== expected.length) fail('missing fields')
}
function finite(value: unknown, min = -100000, max = 100000): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}
function vector(value: unknown, length: number): value is number[] { return Array.isArray(value) && value.length === length && value.every(n => finite(n)) }
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) }
function text(value: unknown, max = 1000): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)
}
function near(a: readonly number[], b: readonly number[], tolerance = 1e-6) {
  return a.length === b.length && a.every((n, i) => Math.abs(n - b[i]!) <= tolerance)
}
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
  if (!record(a) || !record(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
}
/** Count exact JSON UTF-8 bytes without encoding the whole input or invoking user accessors. */
function quotedBytes(value: string) {
  let bytes = 2
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) bytes += 2
    else if (c < 32) bytes += 6
    else if (c < 128) bytes++
    else if (c < 2048) bytes += 2
    else if (c >= 0xD800 && c <= 0xDBFF && value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF) { bytes += 4; i++ }
    else if (c >= 0xD800 && c <= 0xDFFF) bytes += 6
    else bytes += 3
  }
  return bytes
}
/** Check before cloning, Array.from or JSON.stringify. Typed raster data is serialized as numeric arrays. */
function bounded(input: unknown) {
  let nodes = 0, wireBytes = 0, rawBytes = 0
  const ancestors = new Set<object>()
  const add = (n: number) => { wireBytes += n; if (wireBytes > inspectionEvidenceLimits.recordingBytes) fail('recording exceeds 8 MiB') }
  function walk(value: unknown, depth: number): void {
    if (++nodes > 1200000 || depth > 32) fail('recording structure exceeds resource bound')
    if (value === null) add(4)
    else if (typeof value === 'boolean') add(value ? 4 : 5)
    else if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite number'); add(String(value).length) }
    else if (typeof value === 'string') { if (value.length > 4096) fail('oversized text'); add(quotedBytes(value)) }
    else if (value instanceof Uint8Array || value instanceof Uint16Array) {
      if (typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer) fail('shared image memory is unsupported')
      if (value.length > inspectionEvidenceLimits.pixels * (value instanceof Uint8Array ? 4 : 1)) fail('raster exceeds resource bound')
      rawBytes += value.byteLength
      if (rawBytes > inspectionEvidenceLimits.rawBytes) fail('image storage exceeds resource bound')
      add(2)
      for (let i = 0; i < value.length; i++) add((i ? 1 : 0) + String(value[i]).length)
    }
    else if (Array.isArray(value) || record(value)) {
      if (ancestors.has(value)) fail('cyclic recording')
      const array = Array.isArray(value)
      if (array && value.length > inspectionEvidenceLimits.pixels * 4) fail('array exceeds resource bound')
      ancestors.add(value); add(2)
      let count = 0
      for (const key in value) {
        if (!Object.hasOwn(value, key)) fail('inherited recording fields')
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        if (!('value' in descriptor)) fail('accessors are unsupported')
        if (array && key !== String(count)) fail('sparse or extended numeric array')
        if (++count > 262144) fail('object exceeds resource bound')
        add((count > 1 ? 1 : 0) + (array ? 0 : quotedBytes(key) + 1)); walk(descriptor.value, depth + 1)
      }
      if (array && count !== value.length) fail('sparse numeric array')
      ancestors.delete(value)
    }
    else fail('unsupported recording value')
  }
  walk(input, 0)
}
function timestamp(value: unknown): value is number { return Number.isSafeInteger(value) && finite(value, 0, 120000) }
function image(input: unknown, width: number, height: number): InspectionCapture['image'] {
  fields(input, ['width', 'height', 'rgba', 'thermalCentiKelvin'])
  const v = input as InspectionCapture['image']
  if (v.width !== width || v.height !== height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2 || width * height > inspectionEvidenceLimits.pixels) fail('raster dimensions differ from calibration')
  function pixels(value: unknown, length: number, maximum: number): number[] | Uint8Array | Uint16Array {
    if (!(Array.isArray(value) || (maximum === 255 ? value instanceof Uint8Array : value instanceof Uint16Array)) || (value as { length: number }).length !== length) fail('invalid raster storage')
    const samples = value as number[] | Uint8Array | Uint16Array
    for (const n of samples) if (!Number.isInteger(n) || n < 0 || n > maximum) fail('invalid raster sample')
    return samples
  }
  const rgba = pixels(v.rgba, width * height * 4, 255), thermal = pixels(v.thermalCentiKelvin, width * height, 65535)
  for (let i = 0; i < thermal.length; i++) {
    if (rgba[i * 4 + 3] !== 255) fail('visible raster must be opaque RGBA')
    if (thermal[i] !== 0 && (thermal[i]! < 15000 || thermal[i]! > 50000)) fail('synthetic temperature is outside the declared model range')
  }
  return { width, height, rgba: new Uint8Array(rgba), thermalCentiKelvin: new Uint16Array(thermal) }
}
function qualityFields(value: unknown): asserts value is InspectionCaptureQuality {
  fields(value, ['qualified', 'reasons', 'gsdM', 'blurPx', 'assetFraction', 'stationOffsetM', 'viewIncidenceRad', 'velocityMps', 'angularRateRadS'])
  const q = value as InspectionCaptureQuality
  if (typeof q.qualified !== 'boolean' || !Array.isArray(q.reasons) || q.reasons.length > 16 || q.reasons.some(reason => !text(reason, 160)) || !finite(q.gsdM, 0, 10000) || !finite(q.blurPx, 0, 100000) || !finite(q.assetFraction, 0, 1) || !finite(q.stationOffsetM, 0, 10000) || !finite(q.viewIncidenceRad, 0, Math.PI) || !finite(q.velocityMps, 0, 100) || !finite(q.angularRateRadS, 0, 100)) fail('invalid capture quality')
}
/** Recompute the compact mission prefix and capture joins. This does not authenticate its producer or replay omitted sensors. */
export function validateInspectionRun(input: unknown): InspectionRun {
  bounded(input)
  fields(input, ['version', 'evidence', 'physicalFlightEnabled', 'physicalInspectionVerified', 'visitId', 'scenario', 'plan', 'trace', 'status', 'reason', 'captures', 'boardNeutral', 'minimumObservedSeparationM', 'path'])
  const run = input as InspectionRun
  if (run.version !== 1 || run.evidence !== 'owned-inspection-physics-simulation' || run.physicalFlightEnabled !== false || run.physicalInspectionVerified !== false || !identifier(run.visitId) || !['nominal', 'wind', 'gnss-loss', 'structure-motion', 'camera-loss', 'wrong-ack', 'pause-resume', 'abort', 'rc-override'].includes(run.scenario) || !['completed', 'aborted', 'blocked', 'incomplete'].includes(run.status) || !text(run.reason) || typeof run.boardNeutral !== 'boolean' || (run.minimumObservedSeparationM !== null && !finite(run.minimumObservedSeparationM, -10000, 10000))) fail('unsupported runtime evidence')
  if (!record(run.plan)) fail('missing inspection plan')
  const plan = createInspectionPlan(run.plan.config)
  if (!same(plan, run.plan) || plan.config.calibration.evidence !== 'synthetic' || plan.config.calibration.timing.clockUncertaintyMs > inspectionEvidenceLimits.clockUncertaintyMs) fail('plan or synthetic calibration differs from validated configuration')
  fields(run.trace, ['version', 'evidence', 'plan', 'rows'])
  if (!same(run.trace.plan, plan.mission) || !Array.isArray(run.trace.rows) || !run.trace.rows.length || run.trace.rows.length > missionLimits.rows) fail('mission trace plan or resource bound')
  for (const row of run.trace.rows) { fields(row, ['observation', 'action', 'result']); if (!timestamp(row.observation?.nowMs)) fail('invalid trace time') }
  const final = replayMission(run.trace).snapshot()
  const missingStationCompletion = run.status === 'incomplete' && final.state === 'completed' && run.reason === 'inspection-missing-stations' && Array.isArray(run.captures) && run.captures.length < plan.stations.length
  if ((run.status === 'incomplete' && ['completed', 'aborted', 'blocked'].includes(final.state) && !missingStationCompletion) || (run.status !== 'incomplete' && run.status !== final.state)) fail('status differs from replayed mission')
  if (!Array.isArray(run.captures) || run.captures.length > inspectionEvidenceLimits.captures || !Array.isArray(run.path) || run.path.length > missionLimits.rows) fail('capture or path resource bound')
  const observations = new Map(run.trace.rows.map((row, index) => [row.observation.nowMs, { row, previous: run.trace.rows[index - 1]?.result }]))
  let pathAt = -1
  for (const row of run.path) {
    fields(row, ['atMs', 'positionM', 'targetM', 'taskId', 'state'])
    if (!timestamp(row.atMs) || row.atMs <= pathAt || (row.positionM !== null && !vector(row.positionM, 3)) || (row.targetM !== null && !vector(row.targetM, 3)) || typeof row.taskId !== 'string' || row.taskId.length > 64 || !['ready', 'running', 'paused', 'completed', 'aborted', 'blocked'].includes(row.state)) fail('invalid path sample')
    const trace = observations.get(row.atMs)?.row
    if (!trace || row.taskId !== trace.result.taskId || row.state !== trace.result.state || !same(row.targetM, trace.result.targetM) || (row.positionM !== null && !near(row.positionM, trace.observation.positionM))) fail('path differs from mission trace')
    pathAt = row.atMs
  }
  const ids = new Set<string>(), stations = new Set<string>(), captures: InspectionCapture[] = []
  let session: string | null = null, lastCaptureMs = -1
  for (const original of run.captures) {
    fields(original, ['id', 'visitId', 'stationId', 'assetId', 'revision', 'sessionId', 'sequence', 'issuedAtMs', 'capturedAtMs', 'acknowledgedAtMs', 'calibrationId', 'clockUncertaintyMs', 'exposureTimeUs', 'pose', 'cameraPositionM', 'positionSigmaM', 'attitudeSigmaRad', 'assetObservation', 'image', 'quality'])
    const station = plan.stations.find(s => s.id === original.stationId)
    if (!identifier(original.id) || ids.has(original.id) || !station || stations.has(original.stationId) || original.visitId !== run.visitId || original.assetId !== plan.config.asset.id || original.revision !== plan.config.asset.revision || !identifier(original.sessionId) || (session !== null && session !== original.sessionId) || original.sequence !== captures.length + 1) fail('duplicate or inconsistent capture identity')
    if (!timestamp(original.capturedAtMs) || original.capturedAtMs <= lastCaptureMs || original.issuedAtMs !== original.capturedAtMs || !timestamp(original.acknowledgedAtMs) || original.acknowledgedAtMs <= original.capturedAtMs || original.acknowledgedAtMs - original.issuedAtMs > inspectionEvidenceLimits.acknowledgementMs || !observations.has(original.acknowledgedAtMs) || original.calibrationId !== plan.config.calibration.id || original.clockUncertaintyMs !== plan.config.calibration.timing.clockUncertaintyMs || original.exposureTimeUs !== plan.config.exposureTimeUs) fail('capture timing or calibration mismatch')
    const ack = observations.get(original.acknowledgedAtMs), ackObservation = ack?.row.observation
    if (!ackObservation || !ackObservation.healthy || ackObservation.authority !== 'autonomous' || ackObservation.reference !== original.pose.reference || ack?.previous?.state !== 'running' || ack.previous.taskId !== `capture-${station.id}`) fail('acknowledgement has no active station authority and reference')
    const associated = observations.get(original.capturedAtMs), observation = associated?.row.observation
    if (!observation || associated?.previous?.state !== 'running' || associated.previous.taskId !== `capture-${station.id}` || !observation.healthy || observation.authority !== 'autonomous') fail('capture has no active station and healthy authority observation')
    fields(original.pose, ['capturedAtMs', 'reference', 'positionM', 'quaternionWxyz', 'positionCapturedAtMs', 'positionPredictedToMs', 'attitudeCapturedAtMs', 'attitudePredictedToMs', 'gyroCapturedAtMs', 'attitudePrediction'])
    const pose = original.pose
    if (pose.capturedAtMs !== original.capturedAtMs || pose.reference !== observation.reference || !vector(pose.positionM, 3) || !near(pose.positionM, observation.positionM) || !vector(pose.quaternionWxyz, 4) || Math.abs(Math.hypot(...pose.quaternionWxyz) - 1) > 1e-6 || pose.attitudePrediction !== 'qualified-gyro-hold' || !timestamp(pose.positionCapturedAtMs) || pose.positionCapturedAtMs > pose.capturedAtMs || pose.capturedAtMs - pose.positionCapturedAtMs > 200 || pose.positionPredictedToMs !== pose.capturedAtMs || !timestamp(pose.attitudeCapturedAtMs) || pose.attitudeCapturedAtMs > pose.capturedAtMs || pose.capturedAtMs - pose.attitudeCapturedAtMs > 80 || pose.attitudePredictedToMs !== pose.capturedAtMs || !timestamp(pose.gyroCapturedAtMs) || pose.gyroCapturedAtMs > pose.capturedAtMs || pose.capturedAtMs - pose.gyroCapturedAtMs > 80 || !finite(original.positionSigmaM, Number.MIN_VALUE, 100) || !finite(original.attitudeSigmaRad, Number.MIN_VALUE, 0.5) || !vector(original.cameraPositionM, 3)) fail('stale or unqualified capture pose')
    const offset = rotateBodyToNed(pose.quaternionWxyz, plan.config.calibration.extrinsics.translationM)
    if (!near(original.cameraPositionM, pose.positionM.map((n, i) => n + offset[i]!))) fail('optical center differs from calibrated pose')
    fields(original.assetObservation, ['sequence', 'capturedAtMs', 'receivedAtMs', 'reference', 'centerM', 'normalNed', 'uncertaintyM', 'registrationDisplacementM', 'cameraSeparationM'])
    const asset = original.assetObservation
    if (!Number.isSafeInteger(asset.sequence) || asset.sequence < 1 || !timestamp(asset.capturedAtMs) || !timestamp(asset.receivedAtMs) || asset.capturedAtMs > asset.receivedAtMs || asset.receivedAtMs > original.capturedAtMs || original.capturedAtMs - asset.capturedAtMs > 80 || asset.reference !== pose.reference || !vector(asset.centerM, 3) || !vector(asset.normalNed, 3) || !near(asset.normalNed, [-1, 0, 0], 0.05) || !finite(asset.uncertaintyM, Number.MIN_VALUE, 100) || !finite(asset.registrationDisplacementM, 0, 100) || !finite(asset.cameraSeparationM, 0, 100) || Math.abs(asset.registrationDisplacementM - Math.hypot(...asset.centerM.map((n, i) => n - plan.config.asset.centerM[i]!))) > 1e-6 || Math.abs(asset.cameraSeparationM - (original.cameraPositionM.reduce((sum, n, i) => sum + (n - asset.centerM[i]!) * asset.normalNed[i]!, 0))) > 1e-6) fail('invalid or stale measured asset registration')
    const policyFailure = inspectionCapturePolicy(plan.config, { atMs: original.capturedAtMs, velocityMps: Math.hypot(...observation.velocityMps), positionSigmaM: original.positionSigmaM, attitudeSigmaRad: original.attitudeSigmaRad, assetObservation: asset })
    if (policyFailure) fail(policyFailure)
    qualityFields(original.quality)
    if (Math.abs(original.quality.velocityMps - Math.hypot(...observation.velocityMps)) > 1e-6) fail('capture motion differs from trace')
    const capture = { ...structuredClone(original), image: image(original.image, plan.config.calibration.output.width, plan.config.calibration.output.height) }
    const { quality: declaredQuality, ...withoutQuality } = capture
    const quality = inspectCaptureQuality(plan, withoutQuality, { velocityMps: declaredQuality.velocityMps, angularRateRadS: declaredQuality.angularRateRadS })
    if (!same(quality, declaredQuality)) fail('capture quality differs from recomputed predicate')
    captures.push({ ...capture, quality }); ids.add(capture.id); stations.add(capture.stationId); session = capture.sessionId; lastCaptureMs = capture.capturedAtMs
  }
  if (run.status === 'completed' && captures.length !== plan.stations.length) fail('completed collection has missing stations')
  return { ...structuredClone(run), plan, captures }
}

export function inspectionRecordingJson(input: InspectionRun): string {
  const run = validateInspectionRun(input)
  return JSON.stringify(run, (_key, value) => value instanceof Uint8Array || value instanceof Uint16Array ? Array.from(value) : value)
}
export function parseInspectionRecording(text: string): InspectionRun {
  if (typeof text !== 'string' || text.length > inspectionEvidenceLimits.recordingBytes) fail('recording exceeds 8 MiB')
  // A bounded input string may be scanned without first allocating its UTF-8 encoding.
  let bytes = 0
  for (const c of text) { const point = c.codePointAt(0)!; bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4; if (bytes > inspectionEvidenceLimits.recordingBytes) fail('recording exceeds 8 MiB') }
  let input: unknown
  try { input = JSON.parse(text) }
  catch { throw new TypeError('Invalid inspection recording JSON') }
  return validateInspectionRun(input)
}

function validateReviewInput(input: unknown): InspectionReviewInput {
  bounded(input)
  fields(input, ['id', 'captureId', 'reviewerId', 'reviewedAt', 'decision', 'modality', 'pixel', 'note'])
  const v = input as InspectionReviewInput
  if (!identifier(v.id) || !identifier(v.captureId) || !identifier(v.reviewerId) || !['suspected-defect', 'no-defect-observed', 'needs-follow-up'].includes(v.decision) || !['visible', 'thermal'].includes(v.modality) || !vector(v.pixel, 2) || v.pixel.some(n => !Number.isSafeInteger(n) || n < 0) || !text(v.note) || typeof v.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.reviewedAt) || !Number.isFinite(Date.parse(v.reviewedAt)) || new Date(v.reviewedAt).toISOString() !== v.reviewedAt) fail('invalid operator review fields')
  return structuredClone(v)
}
async function captureDigest(run: InspectionRun, capture: InspectionCapture): Promise<string> {
  const { image: source, ...metadata } = capture
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, encoding: 'inspection-capture-metadata-then-rgba-then-uint16le', context: run.plan.config, metadata, width: source.width, height: source.height }))
  const bytes = new Uint8Array(header.length + 1 + source.rgba.length + source.thermalCentiKelvin.length * 2)
  bytes.set(header); bytes[header.length] = 10; bytes.set(source.rgba, header.length + 1)
  const view = new DataView(bytes.buffer)
  const start = header.length + 1 + source.rgba.length
  for (let i = 0; i < source.thermalCentiKelvin.length; i++) view.setUint16(start + i * 2, source.thermalCentiKelvin[i]!, true)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(hash, n => n.toString(16).padStart(2, '0')).join('')
}
async function review(run: InspectionRun, input: InspectionReviewInput): Promise<InspectionReview> {
  const capture = run.captures.find(c => c.id === input.captureId)
  if (!capture) fail('review capture is absent')
  const [x, y] = input.pixel
  if (x >= capture.image.width || y >= capture.image.height || capture.image.thermalCentiKelvin[y * capture.image.width + x] === 0) fail('review pixel is background or outside image')
  const projected = projectInspectionPixel(run.plan, capture.pose, [x + 0.5, y + 0.5], capture.assetObservation.centerM)
  if (!projected) fail('review pixel does not intersect the finite measured asset')
  return { ...input, version: 1, visitId: run.visitId, assetId: capture.assetId, revision: capture.revision, captureSha256: await captureDigest(run, capture), assetUvM: projected.uvM, identityAuthenticated: false, physicalDefectVerified: false }
}
/** Explicit operator declaration, tied to exact source bytes and a calibrated finite-face pixel join. */
export async function createInspectionReview(input: InspectionRun, declaration: InspectionReviewInput): Promise<InspectionReview> {
  return review(validateInspectionRun(input), validateReviewInput(declaration))
}
function reviewDeclaration(declaration: unknown) {
  bounded(declaration)
  fields(declaration, ['id', 'captureId', 'reviewerId', 'reviewedAt', 'decision', 'modality', 'pixel', 'note', 'version', 'visitId', 'assetId', 'revision', 'captureSha256', 'assetUvM', 'identityAuthenticated', 'physicalDefectVerified'])
  const v = declaration as InspectionReview
  const original = validateReviewInput({ id: v.id, captureId: v.captureId, reviewerId: v.reviewerId, reviewedAt: v.reviewedAt, decision: v.decision, modality: v.modality, pixel: v.pixel, note: v.note })
  return { declared: structuredClone(v), original }
}
async function checkedReview(run: InspectionRun, item: ReturnType<typeof reviewDeclaration>) {
  const expected = await review(run, item.original)
  if (!same(expected, item.declared)) fail('review differs from source digest, asset pixel or explicit declaration')
  return expected
}
export async function validateInspectionReview(input: InspectionRun, declaration: unknown): Promise<InspectionReview> {
  const run = validateInspectionRun(input), item = reviewDeclaration(declaration)
  return checkedReview(run, item)
}
/** One bounded snapshot for batch export, with no mutable declarations retained across digest calls. */
export async function validateInspectionReviews(input: InspectionRun, declarations: unknown): Promise<InspectionReview[]> {
  const run = validateInspectionRun(input)
  if (!Array.isArray(declarations) || declarations.length > inspectionEvidenceLimits.reviews) fail('reviews exceed resource bound')
  bounded(declarations)
  const items = declarations.map(reviewDeclaration), ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.original.id)) fail('duplicate review identity')
    ids.add(item.original.id)
  }
  const result: InspectionReview[] = []
  for (const item of items) result.push(await checkedReview(run, item))
  return result
}

/** Conservative view comparability, with no pixel subtraction or automatic condition assessment. */
export function compareInspectionVisits(first: InspectionRun, second: InspectionRun): InspectionComparison {
  const before = validateInspectionRun(first), after = validateInspectionRun(second)
  const a = before.plan.config, b = after.plan.config
  if (before.visitId === after.visitId || !same(a.asset, b.asset) || !same(before.plan.stations, after.plan.stations) || !same(a.calibration, b.calibration) || !same(a.heldOut, b.heldOut) || a.exposureTimeUs !== b.exposureTimeUs || !same(a.quality, b.quality)) fail('visits have incompatible asset, stations, camera, exposure or quality semantics')
  const pairs: InspectionComparison['pairs'] = [], missingStations: string[] = []
  for (const station of before.plan.stations) {
    const x = before.captures.find(c => c.stationId === station.id), y = after.captures.find(c => c.stationId === station.id)
    if (!x || !y) { missingStations.push(station.id); continue }
    const cameraOffsetM = Math.hypot(...x.cameraPositionM.map((n, i) => n - y.cameraPositionM[i]!))
    const cameraOffsetUpperM = cameraOffsetM + x.positionSigmaM + y.positionSigmaM + x.assetObservation.uncertaintyM + y.assetObservation.uncertaintyM + 2 * a.asset.registrationSigmaM
    const dot = Math.abs(x.pose.quaternionWxyz.reduce((sum, n, i) => sum + n * y.pose.quaternionWxyz[i]!, 0))
    const viewAngleRad = 2 * Math.acos(Math.min(1, Math.max(0, dot))), viewAngleUpperRad = viewAngleRad + x.attitudeSigmaRad + y.attitudeSigmaRad + 2 * a.calibration.uncertainty.rotationSigmaRad
    const gsdRatio = Math.min(x.quality.gsdM, y.quality.gsdM) > 0 ? Math.max(x.quality.gsdM, y.quality.gsdM) / Math.min(x.quality.gsdM, y.quality.gsdM) : 100000
    const reasons: string[] = []
    if (!x.quality.qualified || !y.quality.qualified) reasons.push('One or both captures fail the declared quality predicate')
    if (cameraOffsetUpperM > 0.5) reasons.push('Conservative camera offset exceeds 0.5 m')
    if (viewAngleUpperRad > 0.35) reasons.push('Conservative view angle exceeds 0.35 rad')
    if (gsdRatio > 1.25) reasons.push('GSD ratio exceeds 1.25')
    pairs.push({ stationId: station.id, beforeCaptureId: x.id, afterCaptureId: y.id, comparable: reasons.length === 0, reasons, cameraOffsetM, cameraOffsetUpperM, viewAngleRad, viewAngleUpperRad, gsdRatio })
  }
  return { version: 1, assetId: a.asset.id, revision: a.asset.revision, beforeVisitId: before.visitId, afterVisitId: after.visitId, status: missingStations.length || pairs.some(p => !p.comparable) ? 'partial' : 'comparable', pairs, missingStations, defectChangeDetermined: false, limitations: [
    'Comparability uses declared uncertainty and estimated poses, not measured physical accuracy or authenticated visits.',
    'Camera offset includes both pose and measured-registration uncertainties. View angle includes both attitude and camera-rotation uncertainties.',
    'No pixel subtraction, automatic deterioration diagnosis or physical defect change is determined.',
    'Temperature pixels are an ideal synthetic field, without emissivity, reflected-background, atmosphere or physical radiometer calibration.',
  ] }
}
