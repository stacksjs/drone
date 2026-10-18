import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from 'ts-images'
import { simulateInspection } from '../../resources/functions/drone/inspection/runtime'
import { createInspectionReview, parseInspectionRecording, validateInspectionReview } from '../../resources/functions/drone/inspection/evidence'
import { writeInspectionDataset } from '../../resources/functions/drone/inspection/export'

const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })
async function destination() { const parent = await mkdtemp(join(tmpdir(), 'inspection-export-')); cleanup.push(parent); return join(parent, 'dataset') }
function sha256(bytes: string | Uint8Array) { return new Bun.CryptoHasher('sha256').update(bytes).digest('hex') }
// Public export/files seam independently decodes PNG and uint16 thermal bytes.
// This proves source preservation and unsigned consistency, not measured
// radiometry, real inspection accuracy or authenticated operator identity.
test('exports actual visible PNG and independent numeric thermal fields with explicit source hashes and private completion', async () => {
  const run = simulateInspection(), target = await destination(), capture = run.captures[0]!
  const review = await createInspectionReview(run, { id: 'operator-review-1', captureId: capture.id, reviewerId: 'inspector-chris', reviewedAt: '2026-10-18T12:30:00.000Z', decision: 'suspected-defect', modality: 'thermal', pixel: [48, 36], note: 'Review this synthetic surface location on the next simulated visit.' })
  const output = await writeInspectionDataset(target, run, [review])
  expect(output.images).toBe(3)
  expect(output.recording).toBe(join(target, 'recording.json'))
  const restored = parseInspectionRecording(await readFile(output.recording, 'utf8'))
  expect(restored).toEqual(run)
  const png = await readFile(join(target, 'images', `${capture.id}.png`)), decoded = await decode(png)
  expect([decoded.width, decoded.height]).toEqual([96, 72])
  expect(Array.from(decoded.data)).toEqual(Array.from(capture.image.rgba))
  const thermal = await readFile(join(target, 'thermal', `${capture.id}.uint16le`)), counts = new DataView(thermal.buffer, thermal.byteOffset, thermal.byteLength)
  expect(thermal.length).toBe(96 * 72 * 2)
  for (let i = 0; i < capture.image.thermalCentiKelvin.length; i++) expect(counts.getUint16(i * 2, true)).toBe(capture.image.thermalCentiKelvin[i]!)
  const sidecar = JSON.parse(await readFile(join(target, 'thermal', `${capture.id}.json`), 'utf8'))
  expect(sidecar.unit).toBe('centikelvin')
  expect(sidecar.kelvinPerCount).toBe(0.01)
  expect(sidecar.nodata).toBe(0)
  expect(sidecar.physicalRadiometryVerified).toBe(false)
  expect(sidecar.sourceSha256).toBe(sha256(thermal))
  const reviews = JSON.parse(await readFile(join(target, 'reviews.json'), 'utf8'))
  expect(reviews).toEqual([review])
  expect(await validateInspectionReview(restored, reviews[0])).toEqual(review)
  const manifestText = await readFile(output.manifest, 'utf8'), manifest = JSON.parse(manifestText)
  expect(output.manifestSha256).toBe(sha256(manifestText))
  expect(manifest.physicalInspectionVerified).toBe(false)
  expect(manifest.fullSensorReplayPerformed).toBe(false)
  expect(manifest.contentAuthentication).toBe('unsigned-content-hashes')
  expect(manifest.reviewCount).toBe(1)
  for (const entry of manifest.files) {
    const bytes = await readFile(join(target, entry.path))
    expect(bytes.length).toBe(entry.bytes)
    expect(sha256(bytes)).toBe(entry.sha256)
  }
  expect(await readdir(target)).not.toContain('manifest.pending.json')
  expect((await stat(target)).mode & 0o777).toBe(0o700)
  expect((await stat(output.manifest)).mode & 0o777).toBe(0o600)
})

test('default export invents no human reviews and preserves empty fault collections', async () => {
  const run = simulateInspection({ scenario: 'camera-loss' }), target = await destination()
  const output = await writeInspectionDataset(target, run)
  expect(output.images).toBe(0)
  expect(JSON.parse(await readFile(join(target, 'reviews.json'), 'utf8'))).toEqual([])
  const quality = JSON.parse(await readFile(join(target, 'quality.json'), 'utf8'))
  expect(quality.status).toBe('aborted')
  expect(quality.stations.every((station: { quality: unknown }) => station.quality === null)).toBe(true)
  expect(await readdir(join(target, 'images'))).toEqual([])
  expect(await readdir(join(target, 'thermal'))).toEqual([])
})

test('invalid sources and stale review bindings fail before touching the output directory', async () => {
  const run = simulateInspection(), review = await createInspectionReview(run, { id: 'review-1', captureId: run.captures[0]!.id, reviewerId: 'operator-1', reviewedAt: '2026-10-18T12:30:00.000Z', decision: 'no-defect-observed', modality: 'visible', pixel: [48, 36], note: 'Synthetic operator review.' })
  const changed = structuredClone(run)
  changed.captures[0]!.image.rgba[0] = changed.captures[0]!.image.rgba[0]! ^ 1
  const target = await destination()
  await expect(writeInspectionDataset(target, changed, [review])).rejects.toThrow('review differs')
  await expect(stat(target)).rejects.toThrow('ENOENT')
  await expect(writeInspectionDataset(target, run, [review, review])).rejects.toThrow('duplicate review')
  await expect(stat(target)).rejects.toThrow('ENOENT')
  run.captures[0]!.image.thermalCentiKelvin = new Uint16Array(1)
  await expect(writeInspectionDataset(target, run)).rejects.toThrow()
  await expect(stat(target)).rejects.toThrow('ENOENT')
})

test('export detaches images and operator declarations before asynchronous work and never overwrites a completed destination', async () => {
  const run = simulateInspection(), target = await destination(), original = run.captures[0]!.image.rgba.slice()
  const review = await createInspectionReview(run, { id: 'review-1', captureId: run.captures[0]!.id, reviewerId: 'operator-1', reviewedAt: '2026-10-18T12:30:00.000Z', decision: 'needs-follow-up', modality: 'visible', pixel: [48, 36], note: 'Original operator note.' })
  const writing = writeInspectionDataset(target, run, [review])
  run.captures[0]!.image.rgba.fill(0); review.note = 'Mutated after export started.'
  await writing
  expect(Array.from((await decode(await readFile(join(target, 'images', `${run.captures[0]!.id}.png`)))).data)).toEqual(Array.from(original))
  expect(JSON.parse(await readFile(join(target, 'reviews.json'), 'utf8'))[0].note).toBe('Original operator note.')
  const manifest = await readFile(join(target, 'manifest.json'), 'utf8')
  await expect(writeInspectionDataset(target, simulateInspection())).rejects.toThrow('EEXIST')
  expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(manifest)
})
