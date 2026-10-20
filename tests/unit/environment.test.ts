import { expect, test } from 'bun:test'
import { createMissionEngine, parseMissionTrace } from '../../resources/functions/drone/missions/engine'
import { createEnvironmentCustody, qualifyEnvironmentPacket, simulateEnvironment, validateEnvironmentRun } from '../../resources/functions/drone/environment/runtime'
import type { Observation } from '../../resources/functions/drone/environment/runtime'
import { createEnvironmentDetector, fitEnvironmentCalibration, reduceEnvironmentCount, stepEnvironmentCell, validateRawEnvironmentPacket } from '../../resources/functions/drone/environment/sensor'
import { compact, denseArray, environmentMission, finite, normalizeEnvironmentInput } from '../../resources/functions/drone/environment/plan'
import { createHash } from 'node:crypto'
import { encodeEnvironmentDataset, environmentOutputDirectory, writeEnvironmentDataset } from '../../resources/functions/drone/environment/export'
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { nedToGeodetic } from '../../resources/functions/drone/estimation/frames'
import { simulateMission } from '../../resources/functions/drone/missions/simulation'
import { writeCompletedArtifact } from '../../resources/functions/artifacts/completed-directory'
import { qualifyEnvironmentNavigation } from '../../resources/functions/drone/environment/runtime'
import type { MissionSimulationContext } from '../../resources/functions/drone/missions/simulation'
import { createPayloadPoseTimeline } from '../../resources/functions/drone/payloads/pose'

// Public owned-run seam: catches a ground-only or truth-geotag surrogate; misses physical calibration and flight.
test('a nominal environmental run acquires delayed observations at two actual airborne heights', () => {
  const run = simulateEnvironment()
  expect(run.summary).toMatchObject({
    profile: 'nominal', status: 'completed', reason: null, qualified: true,
    physicalFlightEnabled: false, nativeMissionState: 'completed', nativeMissionReason: 'landed',
    boardCommandNeutral: true, acquisitionRetired: true, plantPropagationAfterRetirement: false,
    reviewStatus: 'required', dataset: null,
  })
  expect(run.mission.boardCommandMotorsN).toEqual([0, 0, 0, 0])
  expect(run.mission.budget).toEqual({ worstCaseMs: 92000, requiredWh: 200 * 92000 / 3600000 })
  expect(parseMissionTrace(JSON.stringify(run.trace))).toEqual(run.trace)
  expect(run.trace.rows.every(row => row.result.payload === null)).toBe(true)
  expect(run.observations.filter(row => row.band === 'low').length).toBeGreaterThanOrEqual(5)
  expect(run.observations.filter(row => row.band === 'high').length).toBeGreaterThanOrEqual(5)
  expect(run.diagnostics[0]!.atMs).toBe(600)
  expect(run.diagnostics[0]!.positionM).toEqual([0, 0, -0.1])
  const truth = new Map(run.diagnostics.map(row => [row.atMs, row]))
  const native = new Map(run.trace.rows.map(row => [row.observation.nowMs, row.observation]))
  for (const observation of run.observations) {
    const capture = truth.get(observation.capturedAtMs)!
    const estimate = native.get(observation.capturedAtMs)!
    expect(observation.receivedAtMs - observation.capturedAtMs).toBe(60)
    expect(observation.positionM).toEqual(estimate.positionM)
    expect(observation.reference).toBe(estimate.reference)
    expect(observation.priorMissionObservedAtMs).toBe(observation.capturedAtMs - 20)
    expect(capture.positionM[2]).toBeLessThanOrEqual(-0.5)
    expect(Math.hypot(...observation.positionM.map((value, index) => value - capture.positionM[index]!))).toBeLessThanOrEqual(0.2)
    if (observation.band === 'low') expect(Math.abs(capture.positionM[2] + 1)).toBeLessThanOrEqual(0.3)
    if (observation.band === 'high') expect(Math.abs(capture.positionM[2] + 2)).toBeLessThanOrEqual(0.3)
  }
  const downs = run.observations.map(row => truth.get(row.capturedAtMs)!.positionM[2])
  expect(Math.max(...downs) - Math.min(...downs)).toBeGreaterThanOrEqual(0.5)
  expect(Math.max(...run.diagnostics.map(row => Math.hypot(row.positionM[0], row.positionM[1])))).toBeGreaterThanOrEqual(0.7)
  expect(run.counts.scheduledCaptures).toBe(run.packets.length)
  expect(run.counts.admittedObservations).toBe(run.observations.length)
  expect(run.counts.contextsCreated).toBe(run.counts.contextsRemoved)
  expect(run.counts.retirements).toBe(1)
  expect(run.retirement.closeCount).toBe(1)
})

test('fixed detector loss and site closure abort the real native mission at their first observed epoch', () => {
  for (const [profile, atMs, reason] of [['sensor-loss', 5060, 'detector-packet-deadline'], ['site-closure', 8000, 'declared-site-closed']] as const) {
    const run = simulateEnvironment({ profile })
    expect(run.summary).toMatchObject({ status: 'aborted', qualified: true, reason, faultDemonstrated: true, boardCommandNeutral: true })
    expect(run.fault).toMatchObject({ observedAtMs: atMs, priorMissionState: 'running', priorMissionObservedAtMs: atMs - 20, nativeDecisionAtMs: atMs, nativeState: 'aborted', demonstrated: true })
    expect(run.trace.rows.at(-1)).toMatchObject({ observation: { nowMs: atMs }, action: 'abort', result: { state: 'aborted', reason: 'operator-abort' } })
    expect(run.observations.length).toBeGreaterThan(0)
    expect(run.observations.every(row => row.receivedAtMs < atMs)).toBe(true)
    const earlier = run.observations[0]!
    expect(run.diagnostics.find(row => row.atMs === earlier.capturedAtMs)!.positionM[2]).toBeLessThanOrEqual(-0.5)
    expect(run.retirement).toMatchObject({ atMs, reason, failedAtMs: atMs, closeCount: 1, acquisitionRetired: true, plantPropagationAfterRetirement: false, boardCommandMotorsN: [0, 0, 0, 0] })
    expect(run.retirement.lastPlantMotorsN!.some(value => value > 0)).toBe(true)
    expect(run.counts.scheduledCaptures).toBe(run.counts.deliveredPackets + run.counts.suppressedPackets + run.counts.unreceivedPackets)
    expect(run.counts.deliveredPackets).toBe(run.counts.admittedObservations + run.counts.deliveredNotAdmitted)
    expect(run.counts.discardedPackets).toBe(run.counts.deliveredNotAdmitted + run.counts.suppressedPackets + run.counts.unreceivedPackets)
    expect(run.counts.contextsCreated).toBe(run.counts.contextsRemoved)
    if (profile === 'sensor-loss') expect(run.packets.find(row => row.capturedAtMs === 5000)).toMatchObject({ dueAtMs: 5060, packet: null, disposition: 'suppressed', admission: null })
    else expect(run.policy.appliedRevisions.map(zone => zone.revision)).toEqual([1, 2])
  }
})

test('the centered calibration matches independent canonical bytes and excluded standards', () => {
  const expected = '{"version":1,"id":"environment-adc-synthetic-v1","evidence":"synthetic","unit":"U","rangeU":[0,100],"standards":[[0,911],[50,6061],[100,11211]],"slope":103,"offset":911,"referenceAbsBoundU":0.01}'
  const calibration = fitEnvironmentCalibration()
  const { sha256, ...data } = calibration
  expect(JSON.stringify(data)).toBe(expected)
  expect(sha256).toBe('c3bb36b81c26bb6ad7624a795156dcdebe9529d43134542f65500f1046d0b1a6')
  expect(createHash('sha256').update(expected).digest('hex')).toBe(sha256)
  for (const [value, counts] of [[0.7, 983], [13.37, 2288], [41.23, 5158], [73.19, 8450], [98.51, 11058]]) expect(Math.abs(reduceEnvironmentCount(counts, calibration) - value!)).toBeLessThanOrEqual(0.5 / 103 + 1e-9)
  for (const invalid of [[[0, 911], [0, 6061], [100, 11211]], [[0, 100], [50, 50], [100, 0]], [[0, 911], [50, 6061]], [[0, 911], [50, NaN], [100, 11211]]]) expect(() => fitEnvironmentCalibration(invalid)).toThrow()
  for (const counts of [-1, 0, 65535, 1.5, NaN, Infinity]) expect(() => reduceEnvironmentCount(counts, calibration)).toThrow()
  let cell = 10
  for (let i = 0; i < 100; i++) cell = stepEnvironmentCell(cell, 50)
  expect(cell).toBeCloseTo(50 + (10 - 50) * Math.exp(-5), 11)
})

test('the actual delayed detector follows independent weighted field history and digital hashes', () => {
  const run = simulateEnvironment()
  const a = Math.exp(-0.05), first = run.diagnostics[0]!
  const field = (row: typeof first) => 40 + 2 * row.positionM[0] + row.positionM[1] - 3 * row.positionM[2] + 4 * Math.sin(2 * Math.PI * row.atMs / 10000)
  for (const index of [1, 23, 203, run.diagnostics.length - 1]) {
    const row = run.diagnostics[index]!
    let expected = a ** index * field(first)
    for (let j = 1; j <= index; j++) expected += (1 - a) * a ** (index - j) * field(run.diagnostics[j]!)
    expect(row.cellU).toBeCloseTo(expected, 10)
    expect(row.fieldU).toBe(field(row))
  }
  let previous = '0'.repeat(64)
  for (let i = 0; i < run.observations.length; i++) {
    const observation = run.observations[i]!, link = run.custody[i]!
    const packet = run.packets.find(row => row.sequence === observation.sequence)!.packet!
    const diagnostic = run.diagnostics.find(row => row.atMs === observation.capturedAtMs)!
    expect(packet.counts).toBe(Math.round(911 + 103 * diagnostic.cellU))
    expect(Math.abs(observation.valueU - diagnostic.cellU)).toBeLessThanOrEqual(0.5 / 103 + 1e-9)
    expect(observation.valueAbsBoundU).toBe(0.26485436893203884)
    expect(observation.rawSha256).toBe(createHash('sha256').update(JSON.stringify(packet)).digest('hex'))
    expect(link.observationSha256).toBe(createHash('sha256').update(JSON.stringify(observation)).digest('hex'))
    expect(link.previousSha256).toBe(previous)
    expect(link.sha256).toBe(createHash('sha256').update(JSON.stringify({ version: 1, sequence: link.sequence, observationSha256: link.observationSha256, previousSha256: previous })).digest('hex'))
    previous = link.sha256
  }
})

test('fresh owned exports publish five private deterministic files with independently checked content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'environment-dataset-'))
  try {
    const first = await writeEnvironmentDataset(join(root, 'first'))
    const second = await writeEnvironmentDataset(join(root, 'second'))
    expect(first.summary.qualified).toBe(true)
    expect(first.summary.dataset!.directory).toBe(join(root, 'first'))
    const names = ['diagnostics.ndjson', 'manifest.json', 'mission.json', 'observations.ndjson', 'packets.ndjson']
    expect((await readdir(join(root, 'first'))).sort()).toEqual(names)
    const manifestBytes = await readFile(join(root, 'first', 'manifest.json'))
    const manifest = JSON.parse(manifestBytes.toString())
    expect(Object.keys(manifest)).toEqual(['version', 'evidence', 'profile', 'contentAuthentication', 'persistence', 'engine', 'model', 'calibration', 'heldOut', 'policy', 'mission', 'counts', 'fault', 'retirement', 'custody', 'summary', 'files'])
    expect(Object.keys(manifest.summary)).toEqual(['version', 'profile', 'evidence', 'physicalFlightEnabled', 'status', 'reason', 'qualified', 'nativeMissionState', 'nativeMissionReason', 'observations', 'lowObservations', 'highObservations', 'deliveredPackets', 'discardedPackets', 'lastObservationAtMs', 'faultDemonstrated', 'boardCommandNeutral', 'acquisitionRetired', 'plantPropagationAfterRetirement', 'reviewStatus', 'dataset'])
    expect(manifest.summary.dataset).toBeNull()
    expect(first.summary.dataset!.manifestSha256).toBe(createHash('sha256').update(manifestBytes).digest('hex'))
    let bytes = manifestBytes.length
    for (const file of manifest.files) {
      const actual = await readFile(join(root, 'first', file.path))
      expect(actual.length).toBe(file.byteLength)
      expect(createHash('sha256').update(actual).digest('hex')).toBe(file.sha256)
      expect(actual.toString().trimEnd().split('\n').filter(Boolean).length).toBe(file.path === 'mission.json' ? 1 : file.records)
      bytes += actual.length
    }
    expect(first.summary.dataset!.bytes).toBe(bytes)
    expect((await stat(join(root, 'first'))).mode & 0o777).toBe(0o700)
    for (const name of names) {
      expect(await readFile(join(root, 'first', name))).toEqual(await readFile(join(root, 'second', name)))
      expect((await stat(join(root, 'first', name))).mode & 0o777).toBe(0o600)
    }
    const trace = JSON.parse((await readFile(join(root, 'first', 'mission.json'))).toString())
    expect(parseMissionTrace(JSON.stringify(trace))).toEqual(trace)
    expect(manifest.files[0].records).toBe(trace.rows.length)
    const packets = (await readFile(join(root, 'first', 'packets.ndjson'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
    const observed = (await readFile(join(root, 'first', 'observations.ndjson'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
    expect(manifest.counts.scheduledCaptures).toBe(packets.length)
    expect(manifest.custody.count).toBe(observed.length)
    let previous = '0'.repeat(64)
    for (const { observation, link } of observed) {
      const packet = packets.find(row => row.sequence === observation.sequence).packet
      expect(observation.rawSha256).toBe(createHash('sha256').update(JSON.stringify(packet)).digest('hex'))
      expect(link.observationSha256).toBe(createHash('sha256').update(JSON.stringify(observation)).digest('hex'))
      expect(link.previousSha256).toBe(previous)
      expect(link.sha256).toBe(createHash('sha256').update(JSON.stringify({ version: 1, sequence: link.sequence, observationSha256: link.observationSha256, previousSha256: previous })).digest('hex'))
      previous = link.sha256
    }
    expect(manifest.custody.lastSha256).toBe(previous)
    await expect(writeEnvironmentDataset(join(root, 'first'))).rejects.toThrow()
    await expect(writeEnvironmentDataset(join(root, 'invalid'), { profile: 'unknown' })).rejects.toThrow()
    expect(await stat(join(root, 'invalid')).catch(() => null)).toBeNull()
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('native source command emits the one neutral summary and rejects malformed final options outside cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'environment-cli-'))
  try {
    const script = join(import.meta.dir, '../../bin/drone.ts')
    const invoke = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, '--no-env-file', script, 'environment:simulate', ...args], { cwd: root, env: { ...process.env, APP_ENV: 'testing' }, stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => child.kill(), 60000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        return { exitCode, stdout, stderr }
      }
      finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await child.exited } }
    }
    for (const profile of ['nominal', 'sensor-loss', 'site-closure']) {
      const result = await invoke(['--profile', profile])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim().split('\n')).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ profile, qualified: true, physicalFlightEnabled: false, boardCommandNeutral: true, dataset: null })
    }
    const saved = await invoke(['--output', join(root, 'saved')])
    expect(saved.exitCode).toBe(0)
    expect(JSON.parse(saved.stdout).dataset.files).toBe(5)
    expect(JSON.parse(saved.stdout).profile).toBe('nominal')
    const ordinaryPath = await invoke(['--output', 'false'])
    expect(ordinaryPath.exitCode).toBe(0)
    expect(JSON.parse(ordinaryPath.stdout).dataset.directory).toBe(join(await realpath(root), 'false'))
    for (const args of [['--profile', 'unknown'], ['--profile', 'false'], ['--profile', 'nominal', '--profile', 'sensor-loss'], ['--output'], ['--profile'], ['--no-output'], ['--output', root], ['--output', join(root, 'missing-parent', 'child')]]) expect((await invoke(args)).exitCode).not.toBe(0)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('captured epochs and native covariance survive delay without borrowing receipt metadata', () => {
  const run = simulateEnvironment()
  const captured = new Map<number, { covariance: number[], positionAt: number | null, attitudeAt: number | null }>()
  const independent = simulateMission({ plan: environmentMission(), seconds: 100, instrument: {
    render() {},
    observe(context) {
      if (context.nowMs % 100 === 0) captured.set(context.nowMs, { covariance: context.estimate.localPosition!.covarianceBlocks.map(block => block.positionM2), positionAt: context.estimate.localPosition!.capturedAtMs, attitudeAt: context.estimate.attitude!.capturedAtMs })
      return undefined
    },
  } })
  expect(independent.trace).toEqual(run.trace)
  expect(run.packets[0]).toMatchObject({ capturedAtMs: 600, dueAtMs: 660, disposition: 'delivered', admission: 'not-airborne', reason: 'initial-ready' })
  expect(run.observations.every(row => row.capturedAtMs !== 600)).toBe(true)
  for (const observation of run.observations) {
    const source = captured.get(observation.capturedAtMs)!
    expect([...observation.positionVarianceNedM2]).toEqual(source.covariance)
    expect(observation.positionMeasurementAtMs).toBe(source.positionAt!)
    expect(observation.attitudeMeasurementAtMs).toBe(source.attitudeAt!)
  }
})

test('real captured native context is rejected by the pure navigation and association gates when detached facts change', () => {
  let captured: MissionSimulationContext | null = null
  simulateMission({ plan: environmentMission(), seconds: 100, instrument: { render() {}, observe(context) { if (context.nowMs === 700) captured = context; return context.nowMs === 720 ? 'abort' : undefined } } })
  const original = captured as MissionSimulationContext | null
  expect(original).not.toBeNull()
  const reference = qualifyEnvironmentNavigation(original!).reference
  for (const [mutate, reason] of [
    [(copy: MissionSimulationContext) => { copy.estimate.health.tilt = false }, 'navigation-unqualified'],
    [(copy: MissionSimulationContext) => { copy.estimate.localPosition!.covarianceBlocks[0]!.positionM2 = 0 }, 'position-covariance-invalid'],
    [(copy: MissionSimulationContext) => { copy.estimate.resets.manual++ }, 'reference-changed'],
    [(copy: MissionSimulationContext) => { copy.authority = 'manual' }, 'collection-authority-lost'],
    [(copy: MissionSimulationContext) => { copy.estimate.localPosition!.positionM[0] = 13 }, 'collection-fence'],
  ] as const) {
    const copy = structuredClone(original!); mutate(copy)
    expect(() => qualifyEnvironmentNavigation(copy, reference)).toThrow(reason)
  }
  const timeline = createPayloadPoseTimeline()
  expect(timeline.record(original!.estimate, 700)).toBe(true)
  const revision = timeline.snapshot().revision
  expect(timeline.associate({ capturedAtMs: 700, clockUncertaintyMs: 1, evidence: 'fixture' }, revision)).toMatchObject({ status: 'associated', offsetMs: 0, georeferenced: false })
  expect(timeline.associate({ capturedAtMs: 700, clockUncertaintyMs: 1, evidence: 'fixture' }, revision + 1).status).toBe('unavailable')
  expect(timeline.associate({ capturedAtMs: 10000, clockUncertaintyMs: 1, evidence: 'fixture' }, revision).status).toBe('unavailable')
  timeline.clear()
  expect(timeline.associate({ capturedAtMs: 700, clockUncertaintyMs: 1, evidence: 'fixture' }, revision).status).toBe('unavailable')
})

test('declared coordinates have an independent WGS84 forward-transform oracle', () => {
  const forward = (point: { latitudeDeg: number, longitudeDeg: number, ellipsoidHeightM: number }) => {
    const p = point.latitudeDeg * Math.PI / 180, l = point.longitudeDeg * Math.PI / 180
    const eccentricitySquared = 0.0066943799901413165
    const n = 6378137 / Math.sqrt(1 - eccentricitySquared * Math.sin(p) ** 2)
    return [(n + point.ellipsoidHeightM) * Math.cos(p) * Math.cos(l), (n + point.ellipsoidHeightM) * Math.cos(p) * Math.sin(l), (n * (1 - eccentricitySquared) + point.ellipsoidHeightM) * Math.sin(p)]
  }
  const origin = { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }
  expect(nedToGeodetic([0, 0, 0], origin)).toEqual(origin)
  const worked = forward(nedToGeodetic([1, 2, -3], origin))
  expect(Math.hypot(worked[0]! - 6378240, worked[1]! - 2, worked[2]! - 1)).toBeLessThanOrEqual(1e-5)
  const run = simulateEnvironment()
  for (const observation of run.observations) {
    const ecef = forward(observation.geodetic), [north, east, down] = observation.positionM
    expect(Math.hypot(ecef[0]! - (6378237 - down), ecef[1]! - east, ecef[2]! - north)).toBeLessThanOrEqual(1e-5)
  }
})

test('detector horizon retires the last future-due packet and never fabricates its receipt', () => {
  const detector = createEnvironmentDetector('nominal')
  const state = { positionM: [0, 0, -1], velocityMps: [0, 0, 0], motorsN: [0, 0, 0, 0] }
  for (let atMs = 600; atMs <= 100000; atMs += 20) { detector.render(state, atMs); detector.receive(atMs) }
  expect(detector.diagnostics).toHaveLength(4971)
  expect(detector.packets).toHaveLength(995)
  expect(detector.packets.at(-1)).toMatchObject({ capturedAtMs: 100000, dueAtMs: 100060, packet: null, disposition: 'unreceived-on-retirement' })
  expect(detector.close()).toBe(1)
  expect(detector.snapshot().pending).toBe(false)
  expect(() => detector.render(state, 100020)).toThrow('instrument-clock')
  expect(() => detector.close()).toThrow()
  const failed = createEnvironmentDetector('nominal')
  expect(() => failed.render({ ...state, positionM: [13, 0, -1] }, 600)).toThrow('model-envelope')
  expect(failed.snapshot()).toMatchObject({ renderAttempts: 1, lastRenderAttemptAtMs: 600, lastRenderedAtMs: null })
  expect(failed.diagnostics).toHaveLength(0)
  expect(failed.packets).toHaveLength(1)
  expect(failed.close()).toBe(1)
  let observed = 0
  const aborted = simulateMission({ plan: environmentMission(), seconds: 100, instrument: { render() { throw new Error('pure ordering control') }, observe() { observed++; return undefined } } })
  expect(observed).toBe(0)
  expect(aborted.trace.rows).toHaveLength(1)
  expect(aborted.trace.rows[0]).toMatchObject({ observation: { nowMs: 600 }, action: 'abort', result: { state: 'aborted' } })
})

test('a pure failed-evidence wire fixture has an empty chain and uses the unchanged completed publisher', async () => {
  // This mathematical wire fixture is not measured environment flight and is never fed to its owned writer.
  const base = simulateEnvironment(), engine = createMissionEngine(environmentMission())
  engine.step(base.trace.rows[0]!.observation, 'start'); engine.step(base.trace.rows[1]!.observation, 'abort')
  const failed = structuredClone(base)
  failed.trace = engine.trace(); failed.mission.result = engine.snapshot(); failed.mission.authorityState = 'disarmed'; failed.mission.boardCommandMotorsN = [0, 0, 0, 0]
  failed.diagnostics = failed.diagnostics.slice(0, 1)
  failed.packets = [{ sequence: 1, capturedAtMs: 600, dueAtMs: 660, packet: null, disposition: 'unreceived-on-retirement', admission: null, reason: 'retired-without-receipt' }]
  failed.observations = []; failed.custody = []
  failed.counts = { renderAttempts: 2, renderedRows: 1, observeAttempts: 1, scheduledCaptures: 1, deliveredPackets: 0, suppressedPackets: 0, unreceivedPackets: 1, admittedObservations: 0, deliveredNotAdmitted: 0, discardedPackets: 1, lowObservations: 0, highObservations: 0, transitObservations: 0, contextsCreated: 1, contextsRemoved: 1, retirements: 1 }
  failed.retirement = { atMs: 620, reason: 'model-envelope', failedAtMs: 620, lastRenderAttemptAtMs: 620, lastRenderedAtMs: 600, lastObserveAttemptAtMs: 600, closeCount: 1, pendingCapturesRetired: 1, captureContextsCleared: 1, acquisitionRetired: true, plantPropagationAfterRetirement: false, lastPlantMotorsN: failed.diagnostics[0]!.plantMotorsN, boardCommandMotorsN: [0, 0, 0, 0] }
  failed.summary = { ...failed.summary, status: 'aborted', reason: 'model-envelope', qualified: false, nativeMissionState: 'aborted', nativeMissionReason: 'operator-abort', observations: 0, lowObservations: 0, highObservations: 0, deliveredPackets: 0, discardedPackets: 1, lastObservationAtMs: null }
  const encoded = encodeEnvironmentDataset(failed)
  expect(encoded.manifest.custody).toEqual({ count: 0, firstSha256: null, lastSha256: null })
  expect(encoded.manifest.summary.qualified).toBe(false)
  expect(encoded.entries.find(file => file.path === 'observations.ndjson')!.contents).toBe('')
  const root = await mkdtemp(join(tmpdir(), 'environment-failed-wire-'))
  try {
    await writeCompletedArtifact(join(root, 'failed'), encoded.entries, encoded.manifestJson)
    expect(JSON.parse(await readFile(join(root, 'failed', 'manifest.json'), 'utf8')).summary.qualified).toBe(false)
    await expect(writeEnvironmentDataset(join(root, 'forbidden'), failed)).rejects.toThrow()
    expect(await stat(join(root, 'forbidden')).catch(() => null)).toBeNull()
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('closed data admission rejects getters, inherited substitutes and unbounded values before output', async () => {
  let calls = 0
  const getter = Object.defineProperty({}, 'profile', { enumerable: true, get() { calls++; return 'nominal' } })
  const symbol = { profile: 'nominal', [Symbol('private')]: true }
  for (const input of [null, [], getter, symbol, { profile: undefined }, { profile: true }, { profile: ['nominal'] }, { profile: 'nominal', seconds: 100 }, Object.create({ profile: 'nominal' })]) expect(() => normalizeEnvironmentInput(input)).toThrow()
  expect(calls).toBe(0)
  const array = [1, 2, 3]
  Object.defineProperty(array, 1, { enumerable: true, get() { calls++; return 2 } })
  expect(() => denseArray(array, 3, 3)).toThrow()
  const hooked = Object.assign([1, 2, 3], { [Symbol.iterator]() { calls++; throw new Error('iterator') } })
  expect(() => denseArray(hooked, 3, 3)).toThrow()
  expect(() => denseArray(new Array(3), 3, 3)).toThrow()
  expect(calls).toBe(0)
  for (const maximum of [1001, 5001, 6001]) {
    expect(denseArray(Array.from({ length: maximum }, () => 0), maximum)).toHaveLength(maximum)
    expect(() => denseArray(Array.from({ length: maximum + 1 }, () => 0), maximum)).toThrow()
  }
  expect(finite(1e6)).toBe(1e6)
  expect(() => finite(1e6 + 1)).toThrow()
  for (const path of ['', true, [], '\0', 'x'.repeat(4097), '\n'.repeat(4090)]) expect(() => environmentOutputDirectory(path)).toThrow()
  const lastEncodedPath = '/x' + '\n'.repeat(4094)
  expect(Buffer.byteLength(JSON.stringify(lastEncodedPath))).toBe(8192)
  expect(environmentOutputDirectory(lastEncodedPath)).toBe(lastEncodedPath)
  expect(() => environmentOutputDirectory('/' + '\n'.repeat(4095))).toThrow()
  const root = await mkdtemp(join(tmpdir(), 'environment-preflight-'))
  try {
    const target = join(root, 'no-output')
    await expect(writeEnvironmentDataset(target, getter)).rejects.toThrow()
    expect(await stat(target).catch(() => null)).toBeNull()
    expect(calls).toBe(0)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('independent packet, observation and first custody literal goldens retain fractional source epochs', () => {
  const raw = '{"version":1,"sourceId":"environment-detector-1","sessionId":"environment-fixture-v1","sequence":2,"capturedAtMs":700,"receivedAtMs":760,"counts":3795,"clockDomain":"fixture-monotonic-ms","clockUncertaintyMs":1}'
  const packet = validateRawEnvironmentPacket(JSON.parse(raw))
  expect(JSON.stringify(packet)).toBe(raw)
  expect(createHash('sha256').update(raw).digest('hex')).toBe('25f13beb204f135b98b7560f566d11371a0893224fe1f9ae6980af07680153cd')
  const observationText = '{"id":"observation-0002","sequence":2,"capturedAtMs":700,"receivedAtMs":760,"sourceId":"environment-detector-1","calibrationId":"environment-adc-synthetic-v1","rawSha256":"25f13beb204f135b98b7560f566d11371a0893224fe1f9ae6980af07680153cd","reference":"55:0,0,0,0,0","positionM":[0,0,-1],"geodetic":{"latitudeDeg":0,"longitudeDeg":0,"ellipsoidHeightM":101},"positionSnapshotAtMs":700,"positionMeasurementAtMs":600.5,"positionPredictedToMs":700,"attitudeMeasurementAtMs":680.5,"priorMissionObservedAtMs":680,"priorMissionTaskId":"low-dwell","valueU":28,"valueAbsBoundU":0.26485436893203884,"positionVarianceNedM2":[0.0004,0.0004,0.0009],"positionClockTravelBoundM":0.003,"clockUncertaintyMs":1,"band":"low","reviewStatus":"required"}'
  const observation = JSON.parse(observationText) as Observation
  const link = createEnvironmentCustody(observation)
  expect(link.observationSha256).toBe('1b091bbe242e9b12d5f91f115b4b6b0b8821d667fcabbd09251ee400b2fd04ae')
  expect(link.sha256).toBe('9bc16f15bdb417a6b0666a560470780b804384f5b98ebc37f286d10f6a80b417')
  const line = compact({ observation, link })
  expect(Buffer.byteLength(line)).toBe(1027)
  expect(createHash('sha256').update(line).digest('hex')).toBe('fa74abca4936c3e14fcaaa86e158e52e94b8bec0539ec1bebf6892d78b803175')
  expect(Buffer.byteLength(compact(environmentMission()))).toBe(998)
  expect(createHash('sha256').update(compact(environmentMission())).digest('hex')).toBe('899769706eef68dbc770de81efdf21e579a025f595a3412cfe14674f998109df')
  const scheduled = { sequence: 2, capturedAtMs: 700, dueAtMs: 760 }
  expect(qualifyEnvironmentPacket(packet, scheduled, 760)).toMatchObject({ valueU: 28, reason: null })
  for (const [change, reason] of [[{ sequence: 3 }, 'detector-packet-identity'], [{ sourceId: 'other' }, 'detector-packet-identity'], [{ receivedAtMs: 761 }, 'detector-packet-timing'], [{ clockUncertaintyMs: 2 }, 'detector-packet-timing'], [{ counts: 0 }, 'detector-calibration-domain']] as const) expect(qualifyEnvironmentPacket({ ...packet, ...change }, scheduled, 760).reason).toBe(reason)
  for (const change of [{ counts: 65536 }, { sequence: 1002 }, { counts: NaN }, { private: 'extra' }]) expect(() => qualifyEnvironmentPacket({ ...packet, ...change }, scheduled, 760)).toThrow()
})

test('pure wire validation detects changed unsigned facts, invalid counts and oversized arrays', () => {
  const run = simulateEnvironment()
  for (const mutate of [
    (changed: typeof run) => { changed.observations[0]!.positionM[0] += 0.01 },
    (changed: typeof run) => { changed.packets.find(row => row.admission === 'admitted')!.packet!.counts++ },
    (changed: typeof run) => { changed.counts.discardedPackets++ },
    (changed: typeof run) => { changed.summary.qualified = false },
    (changed: typeof run) => { changed.summary.dataset = { directory: 'private', files: 5, bytes: 1, manifestSha256: '0'.repeat(64) } },
    (changed: typeof run) => { changed.diagnostics = Array.from({ length: 5002 }, () => changed.diagnostics[0]!) },
    (changed: typeof run) => { changed.observations[0]!.reference = '55:' + '1'.repeat(121) },
  ]) {
    const changed = structuredClone(run); mutate(changed)
    expect(() => validateEnvironmentRun(changed)).toThrow()
    expect(() => encodeEnvironmentDataset(changed)).toThrow()
  }
  const serialized = encodeEnvironmentDataset(run)
  expect(Buffer.byteLength(serialized.manifestJson)).toBeLessThanOrEqual(16384)
  expect(Buffer.byteLength(compact(run) + '\n')).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(serialized.bytes).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(serialized.manifest.engine).toEqual({ name: 'Bun', version: Bun.version, revision: Bun.revision })
})

test('closed stdout fails after an already completed dataset without private error disclosure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'environment-closed-stdout-'))
  try {
    const target = join(root, 'saved')
    const child = spawn(process.execPath, [join(import.meta.dir, '../../bin/drone.ts'), 'environment:simulate', '--output', target], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.destroy()
    let stderr = '', timedOut = false
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 8192) child.kill('SIGKILL') })
    const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
    let code: number | null
    try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
    finally { clearTimeout(guard) }
    expect(timedOut).toBe(false)
    expect(code).toBe(1)
    expect(stderr.trim()).toBe('Environment simulation failed: invalid input, unavailable result or output failure')
    expect(stderr).not.toContain(target)
    const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))
    expect(manifest.summary.qualified).toBe(true)
    expect(manifest.summary.dataset).toBeNull()
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('invalid model property text rejects before JSON serialization', () => {
  const valid = simulateEnvironment()
  const invalidModel = Object.fromEntries([['x'.repeat(4097), 0]])
  const invalid = { ...valid, model: invalidModel }
  const stringify = JSON.stringify
  let modelSerialized = false
  let runSerialized = false
  const observer = ((value: unknown, ...rest: unknown[]) => {
    if (value === invalidModel) modelSerialized = true
    if (value === invalid) runSerialized = true
    return Reflect.apply(stringify, JSON, [value, ...rest])
  }) as typeof JSON.stringify
  try {
    JSON.stringify = observer
    expect(() => validateEnvironmentRun(invalid)).toThrow('environment-unavailable')
  }
  finally {
    JSON.stringify = stringify
  }
  expect(JSON.stringify).toBe(stringify)
  expect(modelSerialized).toBe(false)
  expect(runSerialized).toBe(false)
})


// Public normalizer and owned-run entry: catches terminating reflection disclosure, not arbitrary Proxy termination.
for (const trap of ['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor']) {
  test(`environment boundary contains terminating ${trap} reflection errors`, () => {
    const sentinel = new Error('private-environment-reflection-sentinel')
    let calls = 0
    const input = new Proxy({ profile: 'nominal' }, { [trap]() { calls++; throw sentinel } })
    for (const consume of [normalizeEnvironmentInput, simulateEnvironment]) {
      let caught: unknown
      try { consume(input) }
      catch (error) { caught = error }
      expect(caught).not.toBe(sentinel)
      expect(caught).toBeInstanceOf(RangeError)
      expect((caught as Error).message).toBe('environment-unavailable')
    }
    expect(calls).toBe(2)
  })
}

test('environment wire refuses a false packet rejection despite qualified flight', () => {
  const run = simulateEnvironment(), row = run.packets[0]!
  expect(run.summary.qualified).toBe(true)
  expect(row).toMatchObject({ capturedAtMs: 600, dueAtMs: 660, admission: 'not-airborne', reason: 'initial-ready' })
  expect(qualifyEnvironmentPacket(row.packet, row, row.dueAtMs, run.calibration).reason).toBeNull()
  row.admission = 'rejected'; row.reason = 'detector-packet-identity'
  expect(() => validateEnvironmentRun(run)).toThrow('environment-unavailable')
  expect(() => encodeEnvironmentDataset(run)).toThrow('environment-unavailable')
})

test('environment wire requires every policy revision actually observed', () => {
  const run = simulateEnvironment()
  expect(run.summary.qualified).toBe(true)
  expect(run.counts.observeAttempts).toBeGreaterThan(0)
  expect(run.policy.appliedRevisions).toEqual([{ revision: 1, effectiveAtMs: 600, centerM: [6, 6], radiusM: 1 }])
  run.policy.appliedRevisions = []
  expect(() => validateEnvironmentRun(run)).toThrow('environment-unavailable')
  expect(() => encodeEnvironmentDataset(run)).toThrow('environment-unavailable')
})

// Mathematical wire fixture from native replay, never an injected owned Environment flight or writer input.
function rejectedEnvironmentWire(abortAtMs = 660, captureAtMs = 600) {
  const run = simulateEnvironment(), engine = createMissionEngine(environmentMission())
  for (const row of run.trace.rows.filter(row => row.observation.nowMs <= abortAtMs)) engine.step(row.observation, row.observation.nowMs === abortAtMs ? 'abort' : row.action ?? undefined)
  run.trace = engine.trace(); run.mission.result = engine.snapshot(); run.mission.authorityState = 'disarmed'; run.mission.boardCommandMotorsN = [0, 0, 0, 0]
  run.diagnostics = run.diagnostics.filter(row => row.atMs <= abortAtMs)
  run.packets = run.packets.filter(row => row.capturedAtMs <= captureAtMs)
  const packet = run.packets.find(row => row.capturedAtMs === captureAtMs)!
  packet.packet!.counts = 0
  packet.admission = 'rejected'; packet.reason = 'detector-calibration-domain'
  run.observations = []; run.custody = []
  const scheduled = run.packets.length
  const steps = (abortAtMs - 600) / 20 + 1
  run.counts = { renderAttempts: steps, renderedRows: steps, observeAttempts: steps, scheduledCaptures: scheduled, deliveredPackets: scheduled, suppressedPackets: 0, unreceivedPackets: 0, admittedObservations: 0, deliveredNotAdmitted: scheduled, discardedPackets: scheduled, lowObservations: 0, highObservations: 0, transitObservations: 0, contextsCreated: scheduled, contextsRemoved: scheduled, retirements: 1 }
  run.retirement = { atMs: abortAtMs, reason: packet.reason, failedAtMs: abortAtMs, lastRenderAttemptAtMs: abortAtMs, lastRenderedAtMs: abortAtMs, lastObserveAttemptAtMs: abortAtMs, closeCount: 1, pendingCapturesRetired: 0, captureContextsCleared: 0, acquisitionRetired: true, plantPropagationAfterRetirement: false, lastPlantMotorsN: run.diagnostics.at(-1)!.plantMotorsN, boardCommandMotorsN: [0, 0, 0, 0] }
  run.summary = { ...run.summary, status: 'aborted', reason: packet.reason, qualified: false, nativeMissionState: 'aborted', nativeMissionReason: 'operator-abort', observations: 0, lowObservations: 0, highObservations: 0, deliveredPackets: scheduled, discardedPackets: scheduled, lastObservationAtMs: null }
  return run
}

test('environment wire retains a genuine rejected packet joined to its own due callback and native abort', () => {
  const run = rejectedEnvironmentWire(), row = run.packets[0]!
  expect(qualifyEnvironmentPacket(row.packet, row, 660, run.calibration).reason).toBe('detector-calibration-domain')
  expect(run.trace.rows.at(-1)).toMatchObject({ observation: { nowMs: 660 }, action: 'abort', result: { state: 'aborted', reason: 'operator-abort' } })
  expect(() => validateEnvironmentRun(run)).not.toThrow()
  expect(encodeEnvironmentDataset(run).manifest.summary).toMatchObject({ qualified: false, reason: 'detector-calibration-domain' })
  for (const mutate of [
    (changed: typeof run) => { changed.retirement.reason = 'observe-failure'; changed.summary.reason = 'observe-failure' },
    (changed: typeof run) => { changed.retirement.failedAtMs = null; changed.retirement.reason = 'native-aborted'; changed.summary.reason = 'native-outcome' },
  ]) {
    const changed = structuredClone(run); mutate(changed)
    expect(() => validateEnvironmentRun(changed)).toThrow('environment-unavailable')
    expect(() => encodeEnvironmentDataset(changed)).toThrow('environment-unavailable')
  }
  // A later running capture requires association; preserve the first initial-ready packet as delivered/not-airborne.
  const association = rejectedEnvironmentWire(760, 700), associatedPacket = association.packets[1]!
  expect(association.packets[0]).toMatchObject({ capturedAtMs: 600, dueAtMs: 660, admission: 'not-airborne', reason: 'initial-ready' })
  expect(association.trace.rows.find(row => row.observation.nowMs === 680)!.result.state).toBe('running')
  associatedPacket.packet!.counts = 911
  associatedPacket.reason = association.retirement.reason = association.summary.reason = 'capture-pose-unqualified'
  expect(qualifyEnvironmentPacket(associatedPacket.packet, associatedPacket, 760).reason).toBeNull()
  expect(association.trace.rows.at(-1)).toMatchObject({ observation: { nowMs: 760 }, action: 'abort', result: { state: 'aborted', reason: 'operator-abort' } })
  expect(association.counts).toMatchObject({ renderAttempts: 9, observeAttempts: 9, scheduledCaptures: 2, deliveredPackets: 2, deliveredNotAdmitted: 2, discardedPackets: 2, contextsCreated: 2, contextsRemoved: 2 })
  expect(() => validateEnvironmentRun(association)).not.toThrow()
  expect(encodeEnvironmentDataset(association).manifest.summary).toMatchObject({ qualified: false, reason: 'capture-pose-unqualified' })
  const timing = structuredClone(run)
  timing.packets[0]!.packet!.receivedAtMs = 640
  timing.packets[0]!.reason = timing.retirement.reason = timing.summary.reason = 'detector-packet-timing'
  expect(qualifyEnvironmentPacket(timing.packets[0]!.packet, timing.packets[0]!, 660).reason).toBe('detector-packet-timing')
  expect(() => validateEnvironmentRun(timing)).not.toThrow()
  const futureTiming = structuredClone(timing)
  futureTiming.packets[0]!.packet!.receivedAtMs = 680
  expect(qualifyEnvironmentPacket(futureTiming.packets[0]!.packet, futureTiming.packets[0]!, 660).reason).toBe('detector-packet-timing')
  expect(() => validateEnvironmentRun(futureTiming)).not.toThrow()
  expect(encodeEnvironmentDataset(futureTiming).manifest.summary.reason).toBe('detector-packet-timing')
  const wrongQualifier = structuredClone(run)
  wrongQualifier.packets[0]!.reason = wrongQualifier.retirement.reason = wrongQualifier.summary.reason = 'detector-packet-identity'
  expect(() => validateEnvironmentRun(wrongQualifier)).toThrow('environment-unavailable')
  // A self-consistent forged receipt epoch cannot move the owned callback/primary latch earlier.
  const early = rejectedEnvironmentWire(640)
  early.packets[0]!.packet!.receivedAtMs = 640
  early.packets[0]!.reason = early.retirement.reason = early.summary.reason = 'detector-packet-timing'
  expect(() => validateEnvironmentRun(early)).toThrow('environment-unavailable')
  expect(() => encodeEnvironmentDataset(early)).toThrow('environment-unavailable')
})

test('environment wire permits empty observed policy only when rendering aborts before first observe', () => {
  const run = simulateEnvironment()
  let observes = 0
  const native = simulateMission({ plan: environmentMission(), seconds: 100, instrument: { render() { throw new Error('mathematical wire render failure') }, observe() { observes++; return undefined } } })
  expect(observes).toBe(0)
  run.trace = native.trace; run.mission.result = native.mission; run.mission.authorityState = native.authority.state; run.mission.boardCommandMotorsN = [...native.board.motorsN]
  run.diagnostics = []; run.packets = [{ sequence: 1, capturedAtMs: 600, dueAtMs: 660, packet: null, disposition: 'unreceived-on-retirement', admission: null, reason: 'retired-without-receipt' }]; run.observations = []; run.custody = []; run.policy.appliedRevisions = []
  run.counts = { renderAttempts: 1, renderedRows: 0, observeAttempts: 0, scheduledCaptures: 1, deliveredPackets: 0, suppressedPackets: 0, unreceivedPackets: 1, admittedObservations: 0, deliveredNotAdmitted: 0, discardedPackets: 1, lowObservations: 0, highObservations: 0, transitObservations: 0, contextsCreated: 0, contextsRemoved: 0, retirements: 1 }
  run.retirement = { atMs: 600, reason: 'model-render-failure', failedAtMs: 600, lastRenderAttemptAtMs: 600, lastRenderedAtMs: null, lastObserveAttemptAtMs: null, closeCount: 1, pendingCapturesRetired: 1, captureContextsCleared: 0, acquisitionRetired: true, plantPropagationAfterRetirement: false, lastPlantMotorsN: null, boardCommandMotorsN: [0, 0, 0, 0] }
  run.summary = { ...run.summary, status: 'aborted', reason: 'model-render-failure', qualified: false, nativeMissionState: 'aborted', nativeMissionReason: 'operator-abort', observations: 0, lowObservations: 0, highObservations: 0, deliveredPackets: 0, discardedPackets: 1, lastObservationAtMs: null }
  expect(() => validateEnvironmentRun(run)).not.toThrow()
  expect(encodeEnvironmentDataset(run).manifest.summary.qualified).toBe(false)
  const falseApplication = structuredClone(run)
  falseApplication.policy.appliedRevisions = [{ revision: 1, effectiveAtMs: 600, centerM: [6, 6], radiusM: 1 }]
  expect(() => validateEnvironmentRun(falseApplication)).toThrow('environment-unavailable')
})


test('environment wire policy uses last observe rather than a later failed render epoch', () => {
  // Mathematical wire control based on a native trace, not a new owned-flight fault hook.
  const run = simulateEnvironment({ profile: 'site-closure' })
  expect(run.retirement.atMs).toBe(8000)
  expect(run.policy.appliedRevisions.map(zone => zone.revision)).toEqual([1, 2])
  run.diagnostics.pop(); run.counts.renderedRows--; run.counts.observeAttempts--
  run.policy.appliedRevisions = run.policy.appliedRevisions.slice(0, 1)
  run.retirement = { ...run.retirement, reason: 'model-render-failure', lastRenderedAtMs: 7980, lastObserveAttemptAtMs: 7980, lastPlantMotorsN: run.diagnostics.at(-1)!.plantMotorsN }
  run.fault = { ...run.fault, observedAtMs: null, priorMissionState: null, priorMissionObservedAtMs: null, priorMissionTaskId: null, nativeDecisionAtMs: null, nativeState: null, earlierAirborneObservations: 0, demonstrated: false }
  run.summary = { ...run.summary, reason: 'model-render-failure', qualified: false, faultDemonstrated: false }
  expect(() => validateEnvironmentRun(run)).not.toThrow()
  expect(encodeEnvironmentDataset(run).manifest.summary.qualified).toBe(false)
  const falseApplication = structuredClone(run)
  falseApplication.policy.appliedRevisions.push({ revision: 2, effectiveAtMs: 8000, centerM: [0, 0], radiusM: 12 })
  expect(() => validateEnvironmentRun(falseApplication)).toThrow('environment-unavailable')
  expect(() => encodeEnvironmentDataset(falseApplication)).toThrow('environment-unavailable')
})


test('environment wire contains null retirement before joining a coherent rejected packet', () => {
  const run = rejectedEnvironmentWire()
  expect(() => validateEnvironmentRun(run)).not.toThrow()
  const malformed = { ...run, retirement: null }
  const errors = [validateEnvironmentRun, encodeEnvironmentDataset].map(consume => {
    try { consume(malformed as unknown as typeof run); return null }
    catch (error) { return error }
  })
  for (const error of errors) {
    expect(error).toBeInstanceOf(RangeError)
    expect((error as Error).message).toBe('environment-unavailable')
  }
})


test('environment wire refuses a qualifier-valid initial-ready association rejection', () => {
  // Mathematical negative wire control: initial-ready600 is explicitly exempt from pose association.
  const run = rejectedEnvironmentWire(), row = run.packets[0]!
  row.packet!.counts = 911
  row.reason = run.retirement.reason = run.summary.reason = 'capture-pose-unqualified'
  expect(row).toMatchObject({ capturedAtMs: 600, dueAtMs: 660, admission: 'rejected' })
  expect(qualifyEnvironmentPacket(row.packet, row, 660, run.calibration).reason).toBeNull()
  expect(() => validateEnvironmentRun(run)).toThrow('environment-unavailable')
  expect(() => encodeEnvironmentDataset(run)).toThrow('environment-unavailable')
})


test('environment wire refuses a false not-airborne tag for the initial-ready capture', () => {
  const run = simulateEnvironment(), row = run.packets[0]!
  expect(run.summary.qualified).toBe(true)
  expect(row).toMatchObject({ capturedAtMs: 600, dueAtMs: 660, disposition: 'delivered', admission: 'not-airborne', reason: 'initial-ready' })
  expect(qualifyEnvironmentPacket(row.packet, row, row.dueAtMs, run.calibration).reason).toBeNull()
  row.reason = 'not-airborne'
  expect(() => validateEnvironmentRun(run)).toThrow('environment-unavailable')
  expect(() => encodeEnvironmentDataset(run)).toThrow('environment-unavailable')
})

test('environment wire refuses a false initial-ready tag for a later not-airborne capture', () => {
  const run = simulateEnvironment()
  expect(run.summary.qualified).toBe(true)
  const row = run.packets.find(packet => packet.capturedAtMs > 600 && packet.admission === 'not-airborne')!
  expect(row).toBeDefined()
  expect(row.capturedAtMs).toBeGreaterThan(600)
  expect(row).toMatchObject({ disposition: 'delivered', admission: 'not-airborne', reason: 'not-airborne' })
  expect(qualifyEnvironmentPacket(row.packet, row, row.dueAtMs, run.calibration).reason).toBeNull()
  row.reason = 'initial-ready'
  expect(() => validateEnvironmentRun(run)).toThrow('environment-unavailable')
  expect(() => encodeEnvironmentDataset(run)).toThrow('environment-unavailable')
})
