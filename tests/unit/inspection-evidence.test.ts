import { expect, test } from 'bun:test'
import type { InspectionReviewInput, InspectionRun } from '../../resources/functions/drone/inspection/types'
import { simulateInspection } from '../../resources/functions/drone/inspection/runtime'
import { compareInspectionVisits, createInspectionReview, inspectionRecordingJson, parseInspectionRecording, validateInspectionReview, validateInspectionReviews, validateInspectionRun } from '../../resources/functions/drone/inspection/evidence'

const declaration = (captureId: string): InspectionReviewInput => ({ id: 'review-1', captureId, reviewerId: 'operator-1', reviewedAt: '2026-10-18T12:30:00.000Z', decision: 'needs-follow-up', modality: 'visible', pixel: [48, 36], note: 'Explicit operator observation of the synthetic bridge texture.' })
// Public recording/review seams catch source mutation, invalid epoch joins and
// silently promoted evidence. They do not establish real inspector identity,
// physical defects, field radiometry or whole-sensor replay.
test('roundtrips actual owned runtime recordings with detached pixels and mission prefix consistency', () => {
  const run = simulateInspection(), validated = validateInspectionRun(run)
  expect(validated.status).toBe('completed')
  expect(validated.captures).toHaveLength(3)
  expect(validated.captures[0]!.image.rgba).not.toBe(run.captures[0]!.image.rgba)
  expect(validated.captures[0]!.image.thermalCentiKelvin).not.toBe(run.captures[0]!.image.thermalCentiKelvin)
  const restored = parseInspectionRecording(inspectionRecordingJson(run))
  expect(restored).toEqual(run)
  expect(restored.captures[0]!.image.rgba).toBeInstanceOf(Uint8Array)
  expect(restored.captures[0]!.image.thermalCentiKelvin).toBeInstanceOf(Uint16Array)
  expect(restored.physicalInspectionVerified).toBe(false)
})

test('explicit operator review joins a finite asset pixel and binds source image and metadata bytes', async () => {
  const run = simulateInspection(), input = declaration(run.captures[0]!.id)
  const result = await createInspectionReview(run, input)
  expect(result.captureSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.assetId).toBe(run.plan.config.asset.id)
  expect(result.identityAuthenticated).toBe(false)
  expect(result.physicalDefectVerified).toBe(false)
  expect(result.assetUvM[0]).toBeGreaterThan(-0.8)
  expect(result.assetUvM[0]).toBeLessThan(0.8)
  expect(await validateInspectionReview(run, result)).toEqual(result)
  expect(await validateInspectionReviews(run, [result])).toEqual([result])
  const changed = validateInspectionRun(run)
  changed.captures[0]!.image.rgba[0] = changed.captures[0]!.image.rgba[0]! ^ 1
  await expect(validateInspectionReview(changed, result)).rejects.toThrow('review differs')
  const alteredPose = validateInspectionRun(run)
  alteredPose.captures[0]!.pose.gyroCapturedAtMs -= 4
  await expect(validateInspectionReview(alteredPose, result)).rejects.toThrow('review differs')
  const changedReview = { ...result, assetUvM: [0, 0] }
  await expect(validateInspectionReview(run, changedReview)).rejects.toThrow('review differs')
  await expect(validateInspectionReviews(run, [result, result])).rejects.toThrow('duplicate review')
})

test('rejects background annotations, invalid reviewer records and impossible UTC dates', async () => {
  const run = simulateInspection(), base = declaration(run.captures[0]!.id)
  const failures: Partial<InspectionReviewInput>[] = [{ captureId: 'absent' }, { reviewerId: '' }, { reviewedAt: '2026-02-30T00:00:00.000Z' }, { note: 'x'.repeat(1001) }, { pixel: [0, 0] }, { pixel: [96, 36] }, { pixel: [48.5, 36] }, { pixel: [-1, 36] }]
  for (const update of failures) await expect(createInspectionReview(run, { ...base, ...update })).rejects.toThrow()
})

test('records retain partial visits and compare only compatible pose, registration and quality bounds', () => {
  const before = simulateInspection({ visitId: 'visit-before' }), after = simulateInspection({ visitId: 'visit-after' })
  const comparison = compareInspectionVisits(before, after)
  expect(comparison.status).toBe('comparable')
  expect(comparison.pairs).toHaveLength(3)
  expect(comparison.pairs.every(pair => pair.cameraOffsetM === 0 && pair.cameraOffsetUpperM > 0 && pair.viewAngleUpperRad > 0 && pair.gsdRatio === 1)).toBe(true)
  expect(comparison.defectChangeDetermined).toBe(false)
  const incomplete = simulateInspection({ visitId: 'visit-short', seconds: 12 })
  expect(validateInspectionRun(incomplete).status).toBe('incomplete')
  const partial = compareInspectionVisits(before, incomplete)
  expect(partial.status).toBe('partial')
  expect(partial.missingStations).toHaveLength(2)
  expect(() => compareInspectionVisits(before, before)).toThrow('incompatible')
  const incompatible = validateInspectionRun(after)
  incompatible.plan.config.asset.revision = 'next-revision'
  expect(() => compareInspectionVisits(before, incompatible)).toThrow()
})

test('rejects inconsistent captures, unauthorized schema additions and invalid replay decisions', () => {
  const original = simulateInspection()
  const failures: ((run: InspectionRun) => void)[] = [
    run => { run.captures[0]!.sequence = 2 },
    run => { run.captures.push(run.captures[0]!) },
    run => { run.captures[0]!.stationId = 'absent' },
    run => { run.captures[0]!.acknowledgedAtMs += 100 },
    run => { run.captures[0]!.pose.positionM[0] += 0.01 },
    run => { run.captures[0]!.pose.reference = '66:0,0,0,0,0' },
    run => { run.captures[0]!.pose.positionCapturedAtMs = 0 },
    run => { run.captures[0]!.pose.quaternionWxyz = [0, 0, 0, 0] },
    run => { run.captures[0]!.cameraPositionM[0] += 0.1 },
    run => { run.captures[0]!.assetObservation.centerM[0] += 0.1 },
    run => { run.captures[0]!.assetObservation.capturedAtMs = 0 },
    run => { run.captures[0]!.positionSigmaM = 0.2 },
    run => { run.captures[0]!.attitudeSigmaRad = 0.11 },
    run => { run.captures[0]!.assetObservation.uncertaintyM = 0.001 },
    run => { run.captures[0]!.quality.qualified = !run.captures[0]!.quality.qualified },
    run => { run.captures[0]!.quality.gsdM /= 2 },
    run => { run.captures[0]!.image.rgba = new Uint8Array(8) },
    run => { run.captures[0]!.image.thermalCentiKelvin = new Uint16Array(8) },
    run => { run.captures[0]!.image.rgba[3] = 0 },
    run => { run.captures[0]!.image.thermalCentiKelvin[0] = 1 },
    run => { run.trace.rows[0]!.result.reason = 'changed-history' },
    run => { run.status = 'incomplete' },
    run => { run.path[0]!.positionM = [1, 2, 3] },
    run => { Object.assign(run.captures[0]!, { realRadiometryVerified: true }) },
    run => { (run as unknown as { physicalFlightEnabled: boolean }).physicalFlightEnabled = true },
  ]
  for (const update of failures) { const run = structuredClone(original); update(run); expect(() => validateInspectionRun(run)).toThrow() }
})

test('rejects oversized input and getters before cloning or materializing typed image arrays', () => {
  expect(() => parseInspectionRecording('x'.repeat(8 * 1024 * 1024 + 1))).toThrow('8 MiB')
  expect(() => parseInspectionRecording('{private-operator-input')).toThrow('Invalid inspection recording JSON')
  const run = simulateInspection(), pixelCount = 65536 * 4 + 1
  run.captures[0]!.image.rgba = new Uint8Array(pixelCount)
  expect(() => validateInspectionRun(run)).toThrow('resource bound')
  const access = { get secret() { throw new Error('private accessor invoked') } }
  expect(() => validateInspectionRun(access)).toThrow('accessors are unsupported')
  const shared = simulateInspection()
  shared.captures[0]!.image.rgba = new Uint8Array(new SharedArrayBuffer(shared.captures[0]!.image.rgba.length))
  expect(() => validateInspectionRun(shared)).toThrow('shared image memory')
})

test('validates actual fault recordings while preserving abort, authority loss and interruption outcomes', () => {
  for (const scenario of ['wind', 'gnss-loss', 'structure-motion', 'camera-loss', 'wrong-ack', 'pause-resume', 'abort', 'rc-override'] as const) {
    const run = simulateInspection({ scenario })
    expect(validateInspectionRun(run)).toEqual(run)
    expect(parseInspectionRecording(inspectionRecordingJson(run)).status).toBe(run.status)
  }
})

test('camera uncertainty affects comparability and missing stations cannot masquerade as completed collection', () => {
  const before = simulateInspection({ visitId: 'before-uncertainty' }), after = simulateInspection({ visitId: 'after-uncertainty' })
  for (const capture of after.captures) capture.assetObservation.uncertaintyM = 0.32
  const comparison = compareInspectionVisits(before, after)
  expect(comparison.status).toBe('partial')
  expect(comparison.pairs.every(pair => pair.cameraOffsetM === 0 && pair.cameraOffsetUpperM > 0.5 && !pair.comparable)).toBe(true)
  const incomplete = structuredClone(before)
  incomplete.captures.pop()
  expect(() => validateInspectionRun(incomplete)).toThrow('missing stations')
  incomplete.status = 'incomplete'; incomplete.reason = 'inspection-missing-stations'
  expect(validateInspectionRun(incomplete).status).toBe('incomplete')
})

test('recording validation and operator reviews reject capture uncertainty that exceeds actual stopping clearance', async () => {
  const run = simulateInspection(), capture = run.captures[0]!
  const input = declaration(capture.id), review = await createInspectionReview(run, input)
  expect(capture.assetObservation.cameraSeparationM).toBeLessThan(2)
  capture.assetObservation.uncertaintyM = 99
  expect(capture.quality.qualified).toBe(true)
  expect(() => { validateInspectionRun(run) }).toThrow('inspection-clearance-unqualified')
  await expect(createInspectionReview(run, input)).rejects.toThrow('inspection-clearance-unqualified')
  await expect(validateInspectionReview(run, review)).rejects.toThrow('inspection-clearance-unqualified')
})
