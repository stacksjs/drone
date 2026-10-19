import { expect, test } from 'bun:test'
import type { AgricultureRun, LivestockObservationInput } from '../../resources/functions/drone/agriculture/types'
import { agricultureRecordingJson, createLivestockObservation, parseAgricultureRecording, validateAgricultureRun, validateLivestockObservation, validateLivestockObservations } from '../../resources/functions/drone/agriculture/evidence'
import { simulateAgriculture } from '../../resources/functions/drone/agriculture/runtime'

function interiorCapture(run: AgricultureRun) {
  const visible = run.survey.captures.find(capture => Math.abs(capture.pose.cameraPositionM[0]) < .5 && Math.abs(capture.pose.cameraPositionM[1]) < .5)!
  return run.captures.find(capture => capture.captureId === visible.id)!
}
function selection(captureId: string): LivestockObservationInput { return { id: 'observation-1', animalId: 'operator-animal-a', captureId, pixel: [48, 36], observerId: 'operator-chris', observedAt: '2026-10-18T23:00:00.000Z', note: 'Explicit operator label on this synthetic image.' } }
// Public recording and operator selection seams detect inconsistent source
// scope and mutable bytes. They do not verify real animals, identity, field
// radiometry, physical flight or omitted raw-sensor replay.
test('actual owned raw-band collection roundtrips detached numeric recording with exact visible capture joins', () => {
  const run = simulateAgriculture(), recording = agricultureRecordingJson(run), restored = parseAgricultureRecording(recording)
  expect(Buffer.byteLength(recording)).toBeGreaterThan(8 * 1024 * 1024)
  expect(Buffer.byteLength(recording)).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(run.status).toBe('completed')
  expect(restored).toEqual(run)
  expect(restored.captures.length).toBeGreaterThan(0)
  expect(restored.captures[0]!.image.bands[0].counts).toBeInstanceOf(Uint16Array)
  expect(restored.survey.captures[0]!.rgba).toBeInstanceOf(Uint8Array)
  expect(restored.captures[0]!.image.bands[0].counts).not.toBe(run.captures[0]!.image.bands[0].counts)
  expect(restored.physicalCalibrationVerified).toBe(false)
})

test('an explicit operator label binds original raw/visible pixels and capture metadata to one field/parcel point', async () => {
  const run = simulateAgriculture(), input = selection(interiorCapture(run).captureId)
  await expect(createLivestockObservation(run, selection(run.captures[0]!.captureId))).rejects.toThrow('outside field')
  const observed = await createLivestockObservation(run, input)
  expect(observed.animalId).toBe('operator-animal-a')
  expect(observed.selection).toBe('explicit-operator-selected-animal')
  expect(observed.captureSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(observed.identityAuthenticated).toBe(false)
  expect(observed.physicalAnimalVerified).toBe(false)
  expect(observed.parcelIds.length).toBeGreaterThan(0)
  expect(await validateLivestockObservation(run, observed)).toEqual(observed)
  expect(await validateLivestockObservations(run, [observed])).toEqual([observed])
  const changed = validateAgricultureRun(run)
  const changedFrame = changed.captures.find(capture => capture.captureId === input.captureId)!
  changedFrame.image.bands[0].counts[0] = changedFrame.image.bands[0].counts[0]! + 1
  await expect(validateLivestockObservation(changed, observed)).rejects.toThrow('source digest')
  const visibleChanged = validateAgricultureRun(run)
  const changedRaw = visibleChanged.captures.find(capture => capture.captureId === input.captureId)!, changedVisible = visibleChanged.survey.captures.find(capture => capture.id === input.captureId)!
  changedRaw.image.rgba[0] = changedRaw.image.rgba[0]! ^ 1
  changedVisible.rgba[0] = changedRaw.image.rgba[0]!
  await expect(validateLivestockObservation(visibleChanged, observed)).rejects.toThrow('source digest')
  await expect(validateLivestockObservations(run, [observed, observed])).rejects.toThrow('duplicate')
  await expect(createLivestockObservation(run, { ...input, observedAt: '2026-02-30T00:00:00.000Z' })).rejects.toThrow()
  await expect(createLivestockObservation(run, { ...input, pixel: [-1, 36] })).rejects.toThrow()
  await expect(createLivestockObservation(run, { ...input, pixel: [96, 36] })).rejects.toThrow()
  await expect(createLivestockObservation(run, { ...input, captureId: 'missing' })).rejects.toThrow()
})

test('rejects duplicate, unacknowledged, stale, radiometrically inadmissible and altered raw-band evidence', () => {
  const original = simulateAgriculture()
  const failures: ((run: AgricultureRun) => void)[] = [
    run => { run.captures.push(run.captures[0]!) },
    run => { run.captures[0]!.captureId = 'changed-capture' },
    run => { run.captures[0]!.sequence += 1 },
    run => { run.captures[0]!.reference = '66:0,0,0,0,0' },
    run => { run.captures[0]!.acknowledgedAtMs += 20 },
    run => { run.captures[0]!.image.rgba[0] = run.captures[0]!.image.rgba[0]! ^ 1 },
    run => { run.captures[0]!.image.bands[0].counts.fill(65535) },
    run => { run.captures[0]!.image.bands[0].capturedAtMs += 100 },
    run => { run.captures[0]!.image.bands[0].irradiance.capturedAtMs = 0 },
    run => { run.captures[0]!.image.registrationErrorPx = 99 },
    run => { run.captures[0]!.image.bands[0].counts = new Uint16Array(1) },
    run => { run.captures[0]!.image.bands[0].counts = new Uint16Array(new SharedArrayBuffer(16)) },
    run => { run.survey.trace.rows[0]!.result.reason = 'altered-decision' },
    run => { run.status = 'incomplete' },
    run => { Object.assign(run.captures[0]!.image, { fabricatedCalibration: true }) },
  ]
  for (const mutate of failures) { const run = structuredClone(original); mutate(run); expect(() => { validateAgricultureRun(run) }).toThrow() }
})

test('bounded parse and source validation reject oversized, cyclic and accessor input before materialization', () => {
  expect(() => parseAgricultureRecording('x'.repeat(16 * 1024 * 1024 + 1))).toThrow('16 MiB')
  expect(() => parseAgricultureRecording('private source text')).toThrow('Invalid agriculture recording JSON')
  expect(() => validateAgricultureRun({ get private() { throw new Error('private accessor invoked') } })).toThrow('accessor')
  expect(() => { validateAgricultureRun({ metadata: Array(2200).fill('x'.repeat(4096)) }) }).toThrow('metadata resource bound')
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  expect(() => validateAgricultureRun(cyclic)).toThrow('cyclic')
})

test('actual interrupted and failed collections retain prior valid frames and can be serialized without pretending completion', () => {
  for (const scenario of ['irradiance-loss', 'band-skew', 'saturation', 'camera-loss', 'wrong-ack', 'position-loss', 'rc-override', 'abort'] as const) {
    const run = simulateAgriculture({ scenario }), restored = parseAgricultureRecording(agricultureRecordingJson(run))
    expect(restored.status).toBe(run.status)
    expect(restored.status).not.toBe('completed')
    expect(restored.captures.length).toBe(run.survey.captures.length)
  }
})

test('rejects shadowed typed-raster accessors without invoking caller code', () => {
  const counts = new Uint16Array(1)
  let invoked = false
  Object.defineProperty(counts, 'length', { get() { invoked = true; return 1 } })
  expect(() => { validateAgricultureRun({ counts }) }).toThrow('shadowed raster')
  expect(invoked).toBe(false)
})
