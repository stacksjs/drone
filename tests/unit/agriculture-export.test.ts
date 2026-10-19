import { afterEach, expect, test } from 'bun:test'
import type { AgricultureRun } from '../../resources/functions/drone/agriculture/types'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from 'ts-images'
import { createLivestockObservation, parseAgricultureRecording } from '../../resources/functions/drone/agriculture/evidence'
import { writeAgricultureDataset } from '../../resources/functions/drone/agriculture/export'
import { simulateAgriculture } from '../../resources/functions/drone/agriculture/runtime'

function interiorCapture(run: AgricultureRun) {
  const visible = run.survey.captures.find(capture => Math.abs(capture.pose.cameraPositionM[0]) < .5 && Math.abs(capture.pose.cameraPositionM[1]) < .5)!
  return run.captures.find(capture => capture.captureId === visible.id)!
}
const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })
async function destination() { const parent = await mkdtemp(join(tmpdir(), 'agriculture-export-')); cleanup.push(parent); return join(parent, 'dataset') }
function hash(bytes: string | Uint8Array) { return new Bun.CryptoHasher('sha256').update(bytes).digest('hex') }
// Public export/files seam verifies actual PNG, raw numeric bands, geographic
// point samples and operator source bindings. No field or physical evidence.
test('exports original visible PNG and raw uint16 red/NIR with numeric layer, point geometry and complete content hashes', async () => {
  const run = simulateAgriculture(), target = await destination(), first = run.captures[0]!
  const output = await writeAgricultureDataset(target, run)
  expect(output.images).toBe(run.captures.length)
  expect(parseAgricultureRecording(await readFile(output.recording, 'utf8'))).toEqual(run)
  const png = await readFile(join(target, 'images', `${first.captureId}.png`)), image = await decode(png)
  expect(Array.from(image.data)).toEqual(Array.from(first.image.rgba))
  for (const band of first.image.bands) {
    const bytes = await readFile(join(target, 'bands', `${first.captureId}-${band.band}.uint16le`)), values = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(bytes.length).toBe(first.image.width * first.image.height * 2)
    for (let i = 0; i < band.counts.length; i++) expect(values.getUint16(i * 2, true)).toBe(band.counts[i]!)
  }
  const points = JSON.parse(await readFile(join(target, 'layer.geojson'), 'utf8'))
  expect(points.type).toBe('FeatureCollection')
  expect(points.features.every((feature: { geometry: { type: string } }) => feature.geometry.type === 'Point')).toBe(true)
  const layer = JSON.parse(await readFile(join(target, 'layer.json'), 'utf8'))
  expect(points.features[0].geometry.coordinates).toEqual([layer.cells[0].geodetic.longitudeDeg, layer.cells[0].geodetic.latitudeDeg, layer.cells[0].geodetic.ellipsoidHeightM])
  expect(JSON.parse(await readFile(join(target, 'livestock-observations.json'), 'utf8'))).toEqual([])
  const manifestText = await readFile(output.manifest, 'utf8'), manifest = JSON.parse(manifestText)
  expect(output.manifestSha256).toBe(hash(manifestText))
  expect(manifest.physicalAgronomyVerified).toBe(false)
  expect(manifest.physicalCalibrationVerified).toBe(false)
  expect(manifest.fullSensorReplayPerformed).toBe(false)
  expect(manifest.radiometry.bands.map((band: { name: string }) => band.name)).toEqual(['red', 'nir'])
  for (const entry of manifest.files) {
    const bytes = await readFile(join(target, entry.path))
    expect(bytes.length).toBe(entry.bytes)
    expect(hash(bytes)).toBe(entry.sha256)
  }
  expect((await stat(target)).mode & 0o777).toBe(0o700)
  expect((await stat(output.manifest)).mode & 0o777).toBe(0o600)
  expect(await readdir(target)).not.toContain('manifest.pending.json')
})

test('snapshots explicitly supplied animal labels and source images before asynchronous export and rejects overwrite', async () => {
  const run = simulateAgriculture(), target = await destination(), capture = interiorCapture(run), original = capture.image.rgba.slice()
  const observation = await createLivestockObservation(run, { id: 'animal-observation-1', animalId: 'operator-label-a', captureId: capture.captureId, pixel: [48, 36], observerId: 'chris', observedAt: '2026-10-18T23:00:00.000Z', note: 'Original explicit operator note.' })
  const writing = writeAgricultureDataset(target, run, [observation])
  capture.image.rgba.fill(0); observation.note = 'Changed after export started.'
  await writing
  expect(Array.from((await decode(await readFile(join(target, 'images', `${capture.captureId}.png`)))).data)).toEqual(Array.from(original))
  expect(JSON.parse(await readFile(join(target, 'livestock-observations.json'), 'utf8'))[0].note).toBe('Original explicit operator note.')
  const manifest = await readFile(join(target, 'manifest.json'), 'utf8')
  await expect(writeAgricultureDataset(target, simulateAgriculture())).rejects.toThrow('EEXIST')
  expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(manifest)
})

test('invalid old labels or raw capture evidence fail before any destination is created', async () => {
  const run = simulateAgriculture(), target = await destination()
  const observation = await createLivestockObservation(run, { id: 'animal-observation-1', animalId: 'operator-label-a', captureId: interiorCapture(run).captureId, pixel: [48, 36], observerId: 'chris', observedAt: '2026-10-18T23:00:00.000Z', note: 'Explicit operator note.' })
  const selected = interiorCapture(run)
  selected.image.bands[1].counts[0] = selected.image.bands[1].counts[0]! + 1
  await expect(writeAgricultureDataset(target, run, [observation])).rejects.toThrow('source digest')
  await expect(stat(target)).rejects.toThrow('ENOENT')
  run.captures[0]!.acknowledgedAtMs += 20
  await expect(writeAgricultureDataset(target, run)).rejects.toThrow()
  await expect(stat(target)).rejects.toThrow('ENOENT')
})

test('an interrupted empty collection exports missing supports and no fabricated animal observations', async () => {
  const run = simulateAgriculture({ scenario: 'abort' }), target = await destination(), output = await writeAgricultureDataset(target, run)
  expect(output.images).toBe(0)
  expect(JSON.parse(await readFile(join(target, 'livestock-observations.json'), 'utf8'))).toEqual([])
  const layer = JSON.parse(await readFile(join(target, 'layer.json'), 'utf8'))
  expect(layer.observedAreaM2).toBe(0)
  expect(layer.meanNdvi).toBeNull()
  expect(await readdir(join(target, 'bands'))).toEqual([])
})
