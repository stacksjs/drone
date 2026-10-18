import type { SurveyCapture, SurveyPoint, SurveyRun } from './types'
import type { SensorVector } from '../sensors/types'
import { geodeticToNed } from '../estimation/frames'
import { rotateBodyToNed } from '../controls/physics'
import { missionLimits, replayMission } from '../missions/engine'
import { createSurveyPlan } from './planner'
import { projectSurveyFootprint } from './geometry'

/** Export and browser work share the same bounded, simulation-only contract. */
export const surveyDatasetLimits = Object.freeze({ images: 512, imageBytes: 4 * 1024 * 1024, rawBytes: 64 * 1024 * 1024, metadataBytes: 16 * 1024 * 1024, traceRows: missionLimits.rows, acknowledgementMs: 80, coverageGrid: 64 })
function fail(message: string): never { throw new TypeError(`Invalid survey dataset: ${message}`) }
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function fields(value: unknown, allowed: string[]) { if (!record(value) || Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) fail('unsupported or missing fields') }
function finite(value: unknown, min = -100000, max = 100000): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}
function vector(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(n => finite(n))
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)
}
function same(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : record(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
function near(a: number[], b: number[], tolerance = 1e-6) {
  return a.length === b.length && a.every((n, i) => Math.abs(n - b[i]!) <= tolerance)
}
/** Walk before cloning or serialization. Reject cycles, unsupported values and oversized input. */
function bounded(value: unknown) {
  let nodes = 0, metadata = 0, raw = 0
  const ancestors = new Set<object>()
  function visit(v: unknown, depth: number): void {
    if (++nodes > 800000 || depth > 24) fail('metadata resource bound')
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('non-finite metadata'); metadata += 24 }
    else if (typeof v === 'string') { if (v.length > 2000) fail('oversized text'); metadata += v.length * 3 + 2 }
    else if (v === null || typeof v === 'boolean') metadata += 5
    else if (v instanceof Uint8Array) { if (typeof SharedArrayBuffer !== 'undefined' && v.buffer instanceof SharedArrayBuffer) fail('shared mutable image memory'); if (v.length > surveyDatasetLimits.imageBytes) fail('image resource bound'); raw += v.length }
    else if (Array.isArray(v) || record(v)) {
      if (ancestors.has(v)) fail('cyclic metadata')
      if (Array.isArray(v) && v.length > surveyDatasetLimits.traceRows) fail('array resource bound')
      ancestors.add(v)
      for (const key of Object.keys(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!
        if (!('value' in descriptor)) fail('accessor metadata is unsupported')
        metadata += key.length + 4; visit(descriptor.value, depth + 1)
      }
      ancestors.delete(v)
    }
    else fail('unsupported metadata value')
    if (metadata > surveyDatasetLimits.metadataBytes || raw > surveyDatasetLimits.rawBytes) fail('dataset resource bound')
  }
  visit(value, 0)
}
function unavailable(value: unknown) {
  fields(value, ['status', 'reason'])
  const v = value as SurveyCapture['rtk']
  if (v.status !== 'unavailable' || !text(v.reason)) fail('measured correction metadata is unsupported')
}
/** Fully revalidate the collection record. Hashes identify content; this is not authentication. */
export function validateSurveyDataset(input: unknown): asserts input is SurveyRun {
  bounded(input)
  fields(input, ['version', 'evidence', 'physicalFlightEnabled', 'collectionOnly', 'reconstructionPerformed', 'plan', 'mission', 'trace', 'status', 'reason', 'captures', 'boardNeutral', 'path'])
  const run = input as SurveyRun
  if (run.version !== 1 || run.evidence !== 'owned-mapping-physics-simulation' || run.physicalFlightEnabled !== false || run.collectionOnly !== true || run.reconstructionPerformed !== false || !['completed', 'aborted', 'blocked', 'incomplete'].includes(run.status) || !text(run.reason) || typeof run.boardNeutral !== 'boolean') fail('unsupported collection evidence')
  if (!record(run.plan) || !same(createSurveyPlan(run.plan.config), run.plan)) fail('plan differs from its validated configuration')
  if (!record(run.trace) || !Array.isArray(run.trace.rows) || run.trace.rows.length === 0 || run.trace.rows.length > surveyDatasetLimits.traceRows || !same(run.trace.plan, run.mission) || !same(run.mission.origin, run.plan.config.origin)) fail('mission or trace reference mismatch')
  fields(run.trace, ['version', 'evidence', 'plan', 'rows'])
  for (const row of run.trace.rows) {
    fields(row, ['observation', 'action', 'result'])
    if (!finite(row.observation?.nowMs, 0, 120000)) fail('trace exceeds owned runtime duration')
  }
  const final = replayMission(run.trace).snapshot()
  if ((run.status === 'completed' && final.state !== 'completed') || (run.status === 'aborted' && final.state !== 'aborted') || (run.status === 'blocked' && final.state !== 'blocked') || (run.status === 'incomplete' && ['completed', 'aborted', 'blocked'].includes(final.state))) fail('status differs from replayed mission')
  if (!Array.isArray(run.captures) || run.captures.length > surveyDatasetLimits.images || !Array.isArray(run.path) || run.path.length > surveyDatasetLimits.traceRows) fail('collection resource bound')
  let lastPathMs = -1
  for (const row of run.path) {
    fields(row, ['atMs', 'positionM', 'targetM', 'taskId', 'state'])
    if (!Number.isSafeInteger(row.atMs) || row.atMs <= lastPathMs || row.atMs < 0 || row.atMs > 120000 || (row.positionM !== null && !vector(row.positionM, 3)) || (row.targetM !== null && !vector(row.targetM, 3)) || typeof row.taskId !== 'string' || row.taskId.length > 64 || !text(row.state)) fail('invalid path record')
    lastPathMs = row.atMs
  }
  const ids = new Set<string>(), names = new Set<string>(), observations = new Map(run.trace.rows.map((row, index) => [row.observation.nowMs, { row, previous: run.trace.rows[index - 1] }]))
  let session: string | null = null, previousMs = -1
  const calibration = run.plan.config.calibration
  for (const capture of run.captures) {
    fields(capture, ['id', 'filename', 'laneId', 'sessionId', 'sequence', 'issuedAtMs', 'capturedAtMs', 'acknowledgedAtMs', 'exposureTimeUs', 'timestampReference', 'clockDomain', 'clockUncertaintyMs', 'calibrationId', 'pose', 'width', 'height', 'rgba', 'footprintM', 'rtk', 'ppk', 'gcps'])
    if (!identifier(capture.id) || ids.has(capture.id) || typeof capture.filename !== 'string' || !/^[a-z][a-z0-9-]{0,63}\.png$/.test(capture.filename) || names.has(capture.filename) || capture.filename !== `${capture.id}.png` || !identifier(capture.sessionId) || (session !== null && capture.sessionId !== session) || capture.sequence !== ids.size + 1) fail('duplicate or invalid capture identity')
    ids.add(capture.id); names.add(capture.filename); session = capture.sessionId
    const lane = run.plan.lanes.find(l => l.id === capture.laneId)
    if (!lane || !Number.isSafeInteger(capture.capturedAtMs) || capture.capturedAtMs <= previousMs || capture.capturedAtMs < 0 || capture.capturedAtMs > 120000 || capture.issuedAtMs !== capture.capturedAtMs || !Number.isSafeInteger(capture.acknowledgedAtMs) || capture.acknowledgedAtMs <= capture.capturedAtMs || capture.acknowledgedAtMs - capture.issuedAtMs > surveyDatasetLimits.acknowledgementMs || !finite(capture.clockUncertaintyMs, 0, 5) || capture.clockUncertaintyMs !== calibration.timing.clockUncertaintyMs || capture.exposureTimeUs !== run.plan.config.exposureTimeUs || capture.timestampReference !== 'synthetic-exposure-midpoint' || capture.clockDomain !== 'fixture-monotonic-ms' || capture.calibrationId !== calibration.id) fail('capture timing or calibration mismatch')
    previousMs = capture.capturedAtMs
    const associated = observations.get(capture.capturedAtMs)
    const previous = associated?.previous?.result, observation = associated?.row.observation
    if (!observations.has(capture.acknowledgedAtMs)) fail('acknowledgement lies outside the recorded runtime')
    if (!observation || !previous || previous.state !== 'running' || previous.taskId !== `${lane.id}-end` || !observation.healthy || observation.authority !== 'autonomous') fail('capture has no active lane and qualified mission observation')
    fields(capture.pose, ['capturedAtMs', 'reference', 'positionM', 'quaternionWxyz', 'cameraPositionM', 'geodetic', 'positionSigmaM', 'attitudeSigmaRad', 'headingAlignment', 'positionCapturedAtMs', 'attitudeCapturedAtMs', 'attitudePrediction'])
    const pose = capture.pose
    if (pose.capturedAtMs !== capture.capturedAtMs || pose.reference !== observation.reference || !vector(pose.positionM, 3) || !vector(pose.cameraPositionM, 3) || !vector(pose.quaternionWxyz, 4) || Math.abs(Math.hypot(...pose.quaternionWxyz) - 1) > 1e-6 || !finite(pose.positionSigmaM, Number.MIN_VALUE, 100) || !finite(pose.attitudeSigmaRad, Number.MIN_VALUE, 0.5) || pose.headingAlignment !== 'initial-simulation-north' || pose.attitudePrediction !== 'qualified-gyro-hold' || !Number.isSafeInteger(pose.positionCapturedAtMs) || !Number.isSafeInteger(pose.attitudeCapturedAtMs) || pose.positionCapturedAtMs < 0 || pose.attitudeCapturedAtMs < 0 || pose.positionCapturedAtMs > pose.capturedAtMs || pose.attitudeCapturedAtMs > pose.capturedAtMs || pose.capturedAtMs - pose.positionCapturedAtMs > 200 || pose.capturedAtMs - pose.attitudeCapturedAtMs > 80 || !near(pose.positionM, observation.positionM)) fail('capture pose is stale, unqualified or in another reference')
    if (pose.positionSigmaM < calibration.uncertainty.translationSigmaM + 0.001 || pose.attitudeSigmaRad < 0.003 + pose.capturedAtMs / 1000000) fail('uncertainty undercuts declared fixture bounds')
    fields(pose.geodetic, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM'])
    const offset = rotateBodyToNed(pose.quaternionWxyz, calibration.extrinsics.translationM)
    const expectedCamera = pose.positionM.map((n, i) => n + offset[i]!)
    if (!near(pose.cameraPositionM, expectedCamera) || !near(geodeticToNed(pose.geodetic, run.plan.config.origin), pose.cameraPositionM, 1e-5)) fail('optical center or ellipsoid position disagrees with pose')
    if (capture.width !== calibration.output.width || capture.height !== calibration.output.height || !Number.isSafeInteger(capture.width) || !Number.isSafeInteger(capture.height) || capture.width < 2 || capture.height < 2 || !(capture.rgba instanceof Uint8Array) || capture.rgba.length !== capture.width * capture.height * 4) fail('raster and calibration dimensions disagree')
    for (let i = 3; i < capture.rgba.length; i += 4) if (capture.rgba[i] !== 255) fail('survey raster must be opaque RGBA')
    const projected = projectSurveyFootprint(run.plan, pose.positionM, pose.quaternionWxyz)
    if (!Array.isArray(capture.footprintM) || capture.footprintM.length !== projected.length || capture.footprintM.some((point, i) => !vector(point, 2) || !near(point, projected[i]!))) fail('footprint differs from calibrated pose and terrain')
    unavailable(capture.rtk); unavailable(capture.ppk); unavailable(capture.gcps)
  }
}
function inside(point: SurveyPoint, polygon: SurveyPoint[]) {
  let result = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result
  }
  return result
}
/** Estimated footprint sampling on the declared plane, never reconstructed or measured coverage. */
export function surveyQuality(input: SurveyRun) {
  validateSurveyDataset(input)
  const { plan, captures } = input, { boundary, holes } = plan.config
  const minN = Math.min(...boundary.map(p => p[0])), maxN = Math.max(...boundary.map(p => p[0])), minE = Math.min(...boundary.map(p => p[1])), maxE = Math.max(...boundary.map(p => p[1]))
  const grid = surveyDatasetLimits.coverageGrid, stepN = (maxN - minN) / grid, stepE = (maxE - minE) / grid
  let areaSamples = 0, coveredSamples = 0, overlappingSamples = 0
  for (let n = 0; n < grid; n++) for (let e = 0; e < grid; e++) {
    const point: SurveyPoint = [minN + (n + 0.5) * stepN, minE + (e + 0.5) * stepE]
    if (!inside(point, boundary) || holes.some(h => inside(point, h))) continue
    areaSamples++
    let count = 0
    for (const capture of captures) { if (inside(point, capture.footprintM)) count++; if (count >= 2) break }
    if (count > 0) coveredSamples++
    if (count > 1) overlappingSamples++
  }
  const lanes = plan.lanes.map(lane => {
    const selected = captures.filter(c => c.laneId === lane.id), delta = lane.toM.map((n, i) => n - lane.fromM[i]!) as SensorVector
    const distances = selected.map(c => c.pose.cameraPositionM.reduce((sum, n, i) => sum + (n - lane.fromM[i]!) * delta[i]!, 0) / lane.lengthM).map(n => Math.max(0, Math.min(lane.lengthM, n))).sort((a, b) => a - b)
    const gaps = distances.slice(1).map((n, i) => n - distances[i]!)
    const maxGapM = gaps.length ? Math.max(...gaps) : null
    return { laneId: lane.id, captures: selected.length, maximumGapM: maxGapM, startGapM: distances[0] ?? lane.lengthM, endGapM: distances.length ? lane.lengthM - distances.at(-1)! : lane.lengthM, plannedSpacingExceeded: maxGapM !== null && maxGapM > plan.captureSpacingM + 0.05 }
  })
  const rows = new Map(input.trace.rows.map(row => [row.observation.nowMs, row.observation]))
  const blurPx = captures.map(c => Math.hypot(...rows.get(c.capturedAtMs)!.velocityMps) * c.exposureTimeUs / 1000000 / plan.gsdM)
  const coveredFraction = areaSamples ? coveredSamples / areaSamples : null
  const issues: string[] = []
  if (input.status !== 'completed') issues.push(`Mission collection ended ${input.status}: ${input.reason}`)
  if (!input.boardNeutral) issues.push('Final modeled output board is not neutral')
  if (captures.length < plan.estimatedPhotos) issues.push('Fewer captures than the planning estimate')
  if (lanes.some(l => l.captures === 0)) issues.push('One or more survey lanes have no exposures')
  if (lanes.some(l => l.plannedSpacingExceeded)) issues.push('Observed along-lane image spacing exceeds the requested bound')
  if (coveredFraction === null) issues.push('Coverage grid resolves no area samples')
  else if (coveredFraction < 0.99) issues.push('Estimated image footprints leave sampled boundary gaps')
  if (blurPx.some(n => n > 1)) issues.push('Estimated exposure motion exceeds one planned ground pixel')
  return {
    version: 1 as const, evidence: input.evidence, status: captures.length === 0 ? 'no-collection' : issues.length ? 'partial-collection' : 'complete-collection',
    collectionOnly: true as const, reconstructionPerformed: false as const, physicalAccuracyVerified: false as const,
    planned: { areaM2: plan.areaM2, images: plan.estimatedPhotos, gsdM: plan.gsdM, overlap: structuredClone(plan.config.overlap), spacingM: plan.captureSpacingM, triggerIntervalMs: plan.triggerIntervalMs, seconds: plan.estimatedSeconds, requiredWh: plan.requiredWh },
    observed: {
      images: captures.length, missingFromEstimate: Math.max(0, plan.estimatedPhotos - captures.length), lanes,
      coverage: { method: 'estimated-footprint-cell-centers-on-declared-plane' as const, grid: [grid, grid], cellSizeM: [stepN, stepE], areaSamples, coveredSamples, overlappingSamples, coveredFraction, multiplyCoveredFraction: areaSamples ? overlappingSamples / areaSamples : null, sampledAreaM2: areaSamples * stepN * stepE, sampledCoveredAreaM2: coveredSamples * stepN * stepE },
      maximumPlannedPixelMotionDuringExposure: blurPx.length ? Math.max(...blurPx) : null,
      positionSigmaRangeM: captures.length ? [Math.min(...captures.map(c => c.pose.positionSigmaM)), Math.max(...captures.map(c => c.pose.positionSigmaM))] : null,
      attitudeSigmaRangeRad: captures.length ? [Math.min(...captures.map(c => c.pose.attitudeSigmaRad)), Math.max(...captures.map(c => c.pose.attitudeSigmaRad))] : null,
      gsdMeasuredM: null, reconstructionErrorM: null, surveyAccuracyM: null,
    },
    issues,
    limitations: [
      'Synthetic image collection only. No photogrammetric reconstruction, orthomosaic, stockpile volume or measured survey accuracy.',
      'Coverage samples four-corner footprint polygons at cell centers on a declared planar terrain model. Lens-curved image edges, sub-cell gaps and unmodeled terrain are unresolved.',
      'Multiple footprint coverage does not certify front or side overlap, tie points, texture quality or reconstruction success.',
      'GSD and exposure motion use the planning model. Image scale and blur have not been measured from reconstructed imagery.',
      'Rasters represent an instantaneous exposure midpoint. Exposure duration is a declared synthetic setting; integrated motion blur and rolling shutter are not modeled.',
      'Position and attitude uncertainty are declared fixture bounds, not empirically calibrated measurement accuracy.',
      'Capture clocks are fixture monotonic milliseconds, with no UTC conversion or calibrated physical shutter timing.',
      'Heading uses the unobserved initial simulation north assumption. Physical camera calibration and absolute heading are unverified.',
      'RTK, PPK and measured GCP observations are unavailable. Heights are WGS84 ellipsoid heights, without an MSL or geoid conversion.',
      'PNG and geo.txt are ODM-style inputs. No external photogrammetry processor has been executed and no native camera override is supplied.',
    ],
  }
}
