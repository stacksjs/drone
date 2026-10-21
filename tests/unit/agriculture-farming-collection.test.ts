import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectFarmingObservation } from '../../resources/functions/drone/agriculture/farming-collection'

function declaration() {
  const plan = JSON.parse(readFileSync('examples/farming-plan.json', 'utf8'))
  return { ...plan, operation: 'agriculture-synthetic-collection', simulation: { visitId: 'farming-square-visit-v1', scenario: 'nominal', seconds: 100 } }
}

function hostFailure(mode: 'encoder' | 'cwd' | 'clone') {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-host-'))
  try {
    const cwd = join(parent, 'cwd'), input = join(parent, 'input.json')
    mkdirSync(cwd)
    writeFileSync(input, JSON.stringify(declaration()))
    const script = `
      import { readFileSync, rmdirSync } from 'node:fs'
      import { collectFarmingObservation } from ${JSON.stringify(resolve('resources/functions/drone/agriculture/farming-collection.ts'))}
      const input = readFileSync(${JSON.stringify(input)}, 'utf8')
      ${mode === 'encoder' ? "globalThis.TextEncoder = class extends TextEncoder { constructor() { super(); throw new Error('private-encoder-sentinel') } }" : mode === 'clone' ? 'globalThis.structuredClone = undefined' : `rmdirSync(${JSON.stringify(cwd)})`}
      try { await collectFarmingObservation(input, 'attempt'); throw new Error('unexpected-return') }
      catch (error) { console.log(JSON.stringify({ name: error.name, message: error.message })) }
    `
    return spawnSync(process.execPath, ['--no-install', '-e', script], { cwd, encoding: 'utf8', timeout: 20000, maxBuffer: 65536 })
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
}

test('collection keeps encoder capability errors inside the fixed unavailable boundary', () => {
  const child = hostFailure('encoder')
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(child.signal).toBeNull()
  expect(child.stderr).toBe('')
  expect(child.stdout).toBe('{"name":"Error","message":"farming-collection-unavailable"}\n')
})

test('collection keeps unavailable relative directory resolution inside the fixed boundary', () => {
  const child = hostFailure('cwd')
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(child.signal).toBeNull()
  expect(child.stderr).toBe('')
  expect(child.stdout).toBe('{"name":"Error","message":"farming-collection-unavailable"}\n')
})

test('collection keeps missing clone capability inside the fixed unavailable boundary', () => {
  const child = hostFailure('clone')
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(child.signal).toBeNull()
  expect(child.stderr).toBe('')
  expect(child.stdout).toBe('{"name":"Error","message":"farming-collection-unavailable"}\n')
})

test.each([
  ['latitudeDeg', 1],
  ['longitudeDeg', 1],
  ['ellipsoidHeightM', 101],
] as const)('collection rejects an unexecutable world-origin %s before reserving output', async (field, value) => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-origin-'))
  try {
    const input = declaration(), directory = join(parent, 'attempt')
    input.config.survey.origin[field] = value
    await expect(collectFarmingObservation(JSON.stringify(input), directory)).rejects.toThrow(new Error('farming-collection-rejected'))
    expect(existsSync(directory)).toBe(false)
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
})

// Public admission catches malformed declarations before I/O; it does not qualify collection or hardware.
test('collection refuses malformed declarations before creating an attempt', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-admission-'))
  try {
    for (const input of [undefined, null, 17, '', '{private-sentinel', '{}']) {
      const directory = join(parent, 'attempt')
      let failure: unknown
      try { await collectFarmingObservation(input as string, directory) }
      catch (error) { failure = error }
      expect(failure).toBeInstanceOf(TypeError)
      expect((failure as Error).message).toBe('farming-collection-input')
      expect(existsSync(directory)).toBe(false)
    }
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
})

test('collection retains a complete source-bound synthetic dataset and separate attempt marker', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-collection-'))
  try {
    const directory = join(parent, 'attempt')
    const input = JSON.stringify(declaration())
    const result = await collectFarmingObservation(input, directory)
    expect(result.kind).toBe('farming-synthetic-collection-delivery')
    const record = result.record
    expect(record.source).toEqual({ encoding: 'utf-8', byteLength: Buffer.byteLength(input), sha256: createHash('sha256').update(input).digest('hex') })
    expect(record.context).toEqual({ farmId: 17, fieldId: 29, declarationId: 'square-declaration-v1' })
    expect(record.outcome.status).toBe('completed')
    expect(record.outcome.boardNeutral).toBe(true)
    expect(record.outcome.lastMissionResult.state).toBe('completed')
    expect(record.outcome.lastMissionResult.targetM).toBeNull()
    expect(record.outcome.captures).toBeGreaterThan(0)
    expect(record.layer.cells).toHaveLength(256)
    expect(record.layer.fieldAreaM2).toBeCloseTo(2.56, 10)
    expect(record.layer.observedAreaM2).toBeGreaterThan(0)
    expect(record.synthetic).toBe(true)
    for (const flag of ['ownershipVerified', 'geometryVerified', 'physicalFlightEnabled', 'physicalCalibrationVerified', 'physicalAgronomyVerified', 'dispatchPerformed', 'operationalMissionCompleted', 'fullSensorReplayPerformed'] as const) expect(record[flag]).toBe(false)
    const recording = readFileSync(join(directory, record.dataset.recordingPath))
    expect(createHash('sha256').update(recording).digest('hex')).toBe(record.dataset.recordingSha256)
    expect(recording.length).toBe(record.dataset.recordingByteLength)
    expect(JSON.parse(recording.toString()).plan.config).toEqual(declaration().config)
    expect(readFileSync(join(directory, 'attempt/request.json'), 'utf8')).toBe(input)
    expect(readFileSync(join(directory, 'attempt/result.json'), 'utf8')).toBe(JSON.stringify(record) + '\n')
    const datasetMarker = readFileSync(join(directory, 'dataset/manifest.json'))
    expect(readFileSync(join(directory, 'attempt/dataset-manifest.json')).equals(datasetMarker)).toBe(true)
    const markerBytes = readFileSync(join(directory, result.attempt.manifestPath))
    expect(markerBytes.length).toBe(result.attempt.manifestByteLength)
    expect(createHash('sha256').update(markerBytes).digest('hex')).toBe(result.attempt.manifestSha256)
    const marker = JSON.parse(markerBytes.toString())
    expect(marker.kind).toBe('farming-synthetic-collection-attempt')
    expect(marker.files.map((file: { path: string }) => file.path)).toEqual(['request.json', 'producer.json', 'result.json', 'dataset-manifest.json'])
    for (const file of marker.files) {
      const bytes = readFileSync(join(directory, 'attempt', file.path))
      expect(bytes.length).toBe(file.byteLength)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256)
    }
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
}, 120000)

test('collection requires its closed versioned declaration and explicit simulation policy', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-envelope-'))
  try {
    const base = declaration()
    const invalid = [
      { ...base, version: 2 },
      { ...base, operation: 'agriculture-observation-plan' },
      { ...base, requestId: '../private' },
      { ...base, privateExtra: true },
      { ...base, context: { ...base.context, farmId: 0 } },
      { ...base, context: { ...base.context, fieldId: 1.5 } },
      { ...base, context: { ...base.context, principal: 'untrusted' } },
      { ...base, geometry: { ...base.geometry, frame: 'NORMALIZED' } },
      { ...base, geometry: { ...base.geometry, verified: true } },
      { ...base, simulation: undefined },
      ...['nominal-extra', null].map(scenario => ({ ...base, simulation: { ...base.simulation, scenario } })),
      ...[7, 121, 8.5].map(seconds => ({ ...base, simulation: { ...base.simulation, seconds } })),
      { ...base, simulation: { ...base.simulation, visitId: '' } },
      { ...base, simulation: { ...base.simulation, path: 'private' } },
    ]
    for (const input of invalid) {
      const directory = join(parent, 'attempt')
      await expect(collectFarmingObservation(JSON.stringify(input), directory)).rejects.toThrow(new TypeError('farming-collection-input'))
      expect(existsSync(directory)).toBe(false)
    }
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
})

test('collection rejects unexecutable config and encoding limits without reserving output', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'drone-farming-preflight-'))
  try {
    const base = declaration()
    const bench = declaration()
    bench.config.radiometry.evidence = 'declared-bench'
    const clock = declaration()
    clock.config.survey.calibration.timing.clockUncertaintyMs = 6
    const remote = declaration()
    remote.config.survey.boundary = [[19, 19], [20, 19], [20, 20], [19, 20]]
    for (const input of [{ ...base, config: {} }, { ...base, config: null }, bench, clock, remote]) {
      const directory = join(parent, 'attempt')
      await expect(collectFarmingObservation(JSON.stringify(input), directory)).rejects.toThrow('farming-collection-rejected')
      expect(existsSync(directory)).toBe(false)
    }
    for (const input of [' '.repeat(262145), 'é'.repeat(131073)]) {
      await expect(collectFarmingObservation(input, join(parent, 'attempt'))).rejects.toThrow(new RangeError('farming-collection-limit'))
    }
    for (const input of [`\uFEFF${JSON.stringify(base)}`, '\uD800', '\uDC00']) {
      await expect(collectFarmingObservation(input, join(parent, 'attempt'))).rejects.toThrow(new TypeError('farming-collection-input'))
    }
    expect(existsSync(join(parent, 'attempt'))).toBe(false)
  }
  finally { rmSync(parent, { recursive: true, force: true }) }
})
