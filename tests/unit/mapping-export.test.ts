import { afterEach, expect, test } from 'bun:test'
import type { SurveyRun } from '../../resources/functions/drone/mapping/types'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from 'ts-images'
import { createSurveyPlan } from '../../resources/functions/drone/mapping/planner'
import { exampleSurveyConfig } from '../../resources/functions/drone/mapping/fixtures'
import { projectSurveyFootprint } from '../../resources/functions/drone/mapping/geometry'
import { createMissionEngine } from '../../resources/functions/drone/missions/engine'
import { exampleMission } from '../../resources/functions/drone/missions/plan'
import { nedToGeodetic } from '../../resources/functions/drone/estimation/frames'
import { writeSurveyDataset } from '../../resources/functions/drone/mapping/export'
import { surveyQuality } from '../../resources/functions/drone/mapping/quality'

const cleanup: string[] = []
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }) })
async function destination() { const root = await mkdtemp(join(tmpdir(), 'mapping-export-')); cleanup.push(root); return join(root, 'dataset') }

// Public export seam: independent RGBA channels and parsed ODM rows catch
// codec, raster, datum, axis ordering and completion-marker defects. This
// metadata fixture does not prove the physics renderer or survey accuracy.
function collection(): SurveyRun {
  const config = exampleSurveyConfig()
  config.origin = { latitudeDeg: 37.25, longitudeDeg: -122.5, ellipsoidHeightM: 123.4 }
  const plan = createSurveyPlan(config), mission = exampleMission()
  const lane = plan.lanes[0]!
  mission.origin = structuredClone(config.origin)
  mission.tasks = [
    { id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.5], timeoutMs: 2000, next: `${lane.id}-end` },
    { id: `${lane.id}-end`, kind: 'waypoint', positionM: [...lane.toM], timeoutMs: 2000, next: 'land' },
    { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 2000 },
  ]
  const engine = createMissionEngine(mission)
  for (let atMs = 0; atMs <= 540; atMs += 20) engine.step({ kind: 'simulation', nowMs: atMs, reference: '55:0,0,0,0,0', origin: mission.origin, healthy: true, positionM: atMs === 0 ? [0, 0, 0] : [0, 0, -1.5], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: atMs === 0 }, atMs === 0 ? 'start' : undefined)
  const positionM: [number, number, number] = [0, 0, -1.5], cameraPositionM: [number, number, number] = [0, 0, -1.46]
  const width = config.calibration.output.width, height = config.calibration.output.height
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = (i / 4) % 251; rgba[i + 1] = 47; rgba[i + 2] = 193; rgba[i + 3] = 255 }
  return {
    version: 1, evidence: 'owned-mapping-physics-simulation', physicalFlightEnabled: false, collectionOnly: true, reconstructionPerformed: false,
    plan, mission, trace: engine.trace(), status: 'incomplete', reason: 'export-fixture', boardNeutral: true, path: [],
    captures: [{ id: 'photo-0001', filename: 'photo-0001.png', laneId: lane.id, sessionId: 'mapping-session-1', sequence: 1,
      issuedAtMs: 520, capturedAtMs: 520, acknowledgedAtMs: 540, exposureTimeUs: config.exposureTimeUs, timestampReference: 'synthetic-exposure-midpoint', clockDomain: 'fixture-monotonic-ms', clockUncertaintyMs: 1, calibrationId: config.calibration.id,
      pose: { capturedAtMs: 520, reference: '55:0,0,0,0,0', positionM, quaternionWxyz: [1, 0, 0, 0], cameraPositionM, geodetic: nedToGeodetic(cameraPositionM, config.origin), positionSigmaM: 0.1, attitudeSigmaRad: 0.004, headingAlignment: 'initial-simulation-north', positionCapturedAtMs: 500, attitudeCapturedAtMs: 520, attitudePrediction: 'qualified-gyro-hold' },
      width, height, rgba, footprintM: projectSurveyFootprint(plan, positionM, [1, 0, 0, 0]),
      rtk: { status: 'unavailable', reason: 'No measured RTK input' }, ppk: { status: 'unavailable', reason: 'No PPK processing' }, gcps: { status: 'unavailable', reason: 'No measured control points' },
    }],
  }
}

test('exports independently decodable RGBA imagery, optical-center ellipsoid positions and auditable collection metadata', async () => {
  const run = collection(), target = await destination()
  const result = await writeSurveyDataset(target, run)
  expect(result.directory).toBe(target)
  const bytes = await readFile(join(target, 'images', 'photo-0001.png')), image = await decode(bytes)
  expect([image.width, image.height]).toEqual([run.captures[0]!.width, run.captures[0]!.height])
  expect(Array.from(image.data)).toEqual(Array.from(run.captures[0]!.rgba))
  const lines = (await readFile(join(target, 'geo.txt'), 'utf8')).trim().split('\n')
  expect(lines[0]).toBe('EPSG:4326')
  const fields = lines[1]!.split(/\s+/)
  expect(fields).toHaveLength(4)
  expect(fields[0]).toBe('photo-0001.png')
  const position = run.captures[0]!.pose.geodetic
  expect(fields.slice(1).map(Number)).toEqual([position.longitudeDeg, position.latitudeDeg, position.ellipsoidHeightM])
  expect(Number(fields[3])).toBeGreaterThan(run.plan.config.origin.ellipsoidHeightM)
  const manifest = JSON.parse(await readFile(result.manifest, 'utf8'))
  expect(manifest.heightDatum).toBe('WGS84_ELLIPSOID')
  expect(manifest.axisOrder).toBe('longitude-latitude')
  expect(manifest.reconstructionPerformed).toBe(false)
  expect(manifest.images[0].sha256).toBe(new Bun.CryptoHasher('sha256').update(bytes).digest('hex'))
  expect(manifest.images[0].pose).toEqual(run.captures[0]!.pose)
  expect(manifest.images[0].rtk.status).toBe('unavailable')
  expect(manifest.images[0].rgba).toBeUndefined()
  expect(await readdir(target)).not.toContain('gcp_list.txt')
  expect((await stat(target)).mode & 0o777).toBe(0o700)
  expect((await stat(result.manifest)).mode & 0o777).toBe(0o600)
})


test('quality exposes incomplete lanes and sampled coverage without inventing accuracy or corrections', () => {
  const run = collection(), report = surveyQuality(run)
  expect(report.status).toBe('partial-collection')
  expect(report.planned.images).toBeGreaterThan(report.observed.images)
  expect(report.observed.images).toBe(1)
  expect(report.observed.lanes.some(l => l.captures === 0)).toBe(true)
  expect(report.observed.coverage.areaSamples).toBeGreaterThan(0)
  expect(report.observed.coverage.coveredFraction).toBeGreaterThan(0)
  expect(report.observed.positionSigmaRangeM).toEqual([0.1, 0.1])
  expect(report.observed.gsdMeasuredM).toBeNull()
  expect(report.observed.reconstructionErrorM).toBeNull()
  expect(report.observed.surveyAccuracyM).toBeNull()
  expect(report.reconstructionPerformed).toBe(false)
  expect(report.physicalAccuracyVerified).toBe(false)
  run.captures = []
  const empty = surveyQuality(run)
  expect(empty.status).toBe('no-collection')
  expect(empty.observed.coverage.coveredFraction).toBe(0)
})

test('rejects tampered metadata, unsafe filenames, mixed evidence and malformed raster before creating files', async () => {
  const mutations: ((run: SurveyRun) => void)[] = [
    run => { run.captures[0]!.filename = '../outside.png' },
    run => { run.captures[0]!.filename = 'photo 0001.png' },
    run => { run.captures[0]!.filename = 'photo-0001.jpg' },
    run => { run.captures.push(structuredClone(run.captures[0]!)) },
    run => { run.captures[0]!.sequence = 2 },
    run => { run.captures[0]!.clockUncertaintyMs = Infinity },
    run => { run.captures[0]!.acknowledgedAtMs = 620 },
    run => { run.captures[0]!.pose.positionCapturedAtMs = 100 },
    run => { run.captures[0]!.pose.reference = '56:0,0,0,0,0' },
    run => { run.captures[0]!.pose.geodetic.latitudeDeg = 91 },
    run => { run.captures[0]!.pose.geodetic.ellipsoidHeightM = run.plan.config.altitudeAglM },
    run => { run.captures[0]!.pose.cameraPositionM[2] = 1.46 },
    run => { run.captures[0]!.pose.positionSigmaM = 0 },
    run => { run.captures[0]!.pose.quaternionWxyz = [0, 0, 0, 0] },
    run => { run.captures[0]!.footprintM[0]![0] += 1 },
    run => { run.captures[0]!.width += 1 },
    run => { run.captures[0]!.rgba = new Uint8Array(16) },
    run => { run.captures[0]!.rgba = new Uint8Array(4 * 1024 * 1024 + 1) },
    run => { run.captures[0]!.rgba = new Uint8Array(new SharedArrayBuffer(run.captures[0]!.rgba.length)) },
    run => { run.captures[0]!.rgba[3] = 0 },
    run => { run.captures[0]!.calibrationId = 'another-calibration' },
    run => { (run.captures[0]!.rtk as { status: string }).status = 'fixed' },
    run => { (run.captures[0]!.pose as unknown as { headingAlignment: string }).headingAlignment = 'observed-true-north' },
    run => { (run as unknown as { evidence: string }).evidence = 'hardware' },
    run => { (run as unknown as { reconstructionPerformed: boolean }).reconstructionPerformed = true },
    run => { run.plan.gsdM /= 2 },
    run => { run.trace.rows[0]!.result.reason = 'edited-history' },
    run => { run.status = 'completed' },
    run => { Object.assign(run.captures[0]!, { heightDatum: 'MSL' }) },
  ]
  for (const mutate of mutations) {
    const run = collection(), target = await destination()
    mutate(run)
    await expect(writeSurveyDataset(target, run)).rejects.toThrow()
    await expect(stat(target)).rejects.toThrow('ENOENT')
  }
})

test('existing destinations are never overwritten, and an asynchronous export snapshots its input bytes', async () => {
  const target = await destination(), run = collection()
  const original = run.captures[0]!.rgba.slice()
  const pending = writeSurveyDataset(target, run)
  run.captures[0]!.rgba.fill(0)
  await pending
  const manifest = await readFile(join(target, 'manifest.json'), 'utf8')
  expect(Array.from((await decode(await readFile(join(target, 'images', 'photo-0001.png')))).data)).toEqual(Array.from(original))
  await expect(writeSurveyDataset(target, collection())).rejects.toThrow('EEXIST')
  expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(manifest)
})
