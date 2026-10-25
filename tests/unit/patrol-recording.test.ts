import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPatrolRecording, replayPatrolDataset, replayPatrolRecording, writePatrolDataset } from '../../resources/functions/drone/navigation/recording'

// Public creation verifies owned compact evidence; it does not verify omitted raw trajectories.
test('a default recording captures the actual engine and one neutral input-summary bundle without authority', () => {
  const bundle = createPatrolRecording()
  expect(Object.keys(bundle)).toEqual(['recording', 'summaryJson'])
  expect(bundle.recording.engine.name).toBe('bun')
  expect(String(bundle.recording.engine.version)).toBe(Bun.version)
  expect(bundle.recording.replayProfile).toBe('owned-patrol-summary-v1')
  expect(bundle.recording.input).toEqual({ profile: 'nominal', unsignedLocalReview: false, enableCharge: false, decisions: [] })
  const summary = JSON.parse(bundle.summaryJson)
  expect(summary.status).toBe('neutral-preview')
  expect(summary.counts.flightRequests).toBe(0)
  expect(summary.counts.chargeRequests).toBe(0)
  expect(summary.counts.armsAccepted).toBe(0)
  expect(summary.counts.chargeFramesAccepted).toBe(0)
  expect(bundle.summaryJson).toBe(`${JSON.stringify(summary)}\n`)
  expect(bundle.recording.summarySha256).toBe(createHash('sha256').update(bundle.summaryJson, 'utf8').digest('hex'))
  expect(Buffer.byteLength(bundle.summaryJson, 'utf8')).toBeLessThanOrEqual(16384)
})

test('neutral replay recomputes the compact summary without restoring runtime state or inheriting consent', () => {
  const bundle = createPatrolRecording({ unsignedLocalReview: true, enableCharge: true })
  const replay = replayPatrolRecording(bundle)
  expect(replay.verified).toBe(true)
  expect(replay.runtimeStateRestored).toBe(false)
  expect(replay.fullTraceVerified).toBe(false)
  expect(replay.authentication).toBe('unsigned-consistency')
  expect(`${JSON.stringify(replay.summary)}\n`).toBe(bundle.summaryJson)
  expect(replay.summary.counts.flightRequests).toBe(0)
  expect(replay.summary.counts.chargeRequests).toBe(0)
}, 30000)

test('a genuine recorded charge denial still requires separate fresh charge consent and never enables a frame', () => {
  const bundle = createPatrolRecording({ unsignedLocalReview: true, enableCharge: true, decisions: [{ kind: 'charge', id: 'denied-charge', atMs: 0, occurrenceId: 'patrol-slot-zero', decision: 'deny' }] })
  expect(() => replayPatrolRecording(bundle, { unsignedLocalReview: true })).toThrow('patrol-replay-consent-required')
  const replay = replayPatrolRecording(bundle, { unsignedLocalReview: true, enableCharge: true })
  expect(replay.verified).toBe(true)
  expect(replay.summary.status).toBe('reviewed-denials')
  expect(replay.summary.decisions[0]!.reason).toBe('charge-operator-denied')
  expect(replay.summary.counts.chargeFramesAccepted).toBe(0)
  expect(`${JSON.stringify(replay.summary)}\n`).toBe(bundle.summaryJson)
}, 30000)

test('finite summary string object and identity bounds separate preflight from genuine model mismatch', () => {
  const bundle = createPatrolRecording()
  const replace = (mutate: (summary: ReturnType<typeof JSON.parse>) => void) => {
    const summary = JSON.parse(bundle.summaryJson)
    mutate(summary)
    const summaryJson = `${JSON.stringify(summary)}\n`
    return { recording: { ...bundle.recording, summarySha256: createHash('sha256').update(summaryJson).digest('hex') }, summaryJson }
  }
  expect(() => replayPatrolRecording(replace(s => { s.energy.extra = 'x'.repeat(4096) }))).toThrow('patrol-recording-model-mismatch')
  expect(() => replayPatrolRecording(replace(s => { s.energy.extra = 'x'.repeat(4097) }))).toThrow('patrol-recording-value')
  expect(() => replayPatrolRecording(replace(s => { s.energy = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field${i}`, null])) }))).toThrow('patrol-recording-model-mismatch')
  expect(() => replayPatrolRecording(replace(s => { s.energy = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`field${i}`, null])) }))).toThrow('patrol-recording-fields')
  expect(() => replayPatrolRecording(replace(s => { s.host.sessionId = '18446744073709551616' }))).toThrow('patrol-recording-uint64')
  expect(() => replayPatrolRecording(replace(s => { s.charge.output.bootId = null }))).toThrow('patrol-recording-uint64')
  expect(() => replayPatrolRecording(replace(s => { s.host.sessionId = '124' }))).toThrow('patrol-recording-model-mismatch')
}, 30000)

test.each(['profile', 'unsignedLocalReview', 'enableCharge', 'decisions'])('retained recording input requires its explicit %s data field', (field) => {
  const bundle = createPatrolRecording()
  const input: Record<string, unknown> = { ...bundle.recording.input }
  delete input[field]
  expect(() => replayPatrolRecording({ ...bundle, recording: { ...bundle.recording, input } })).toThrow('patrol-recording-fields')
}, 30000)

test('retained recording input rejects extra fields and accessors without invoking them', () => {
  const bundle = createPatrolRecording()
  const replace = (input: unknown) => ({ ...bundle, recording: { ...bundle.recording, input } })
  expect(() => replayPatrolRecording(replace({ ...bundle.recording.input, extra: true }))).toThrow(TypeError)
  let reads = 0
  const input = Object.defineProperty({ ...bundle.recording.input }, 'profile', { enumerable: true, get() {
    reads++
    return 'nominal'
  } })
  expect(() => replayPatrolRecording(replace(input))).toThrow(TypeError)
  expect(reads).toBe(0)
})

test.each([
  ['decisions', 4], ['flights', 2], ['recurrence.slots', 2], ['charge.episodes', 2],
] as const)('retained compact summary preflight enforces the %s domain array cap', (path, limit) => {
  const bundle = createPatrolRecording()
  const summary = JSON.parse(bundle.summaryJson)
  const [parent, field] = path.split('.')
  const owner = field ? summary[parent!] : summary
  owner[field ?? parent!] = Array.from({ length: limit + 1 }, () => null)
  const summaryJson = `${JSON.stringify(summary)}\n`
  const recording = { ...bundle.recording, summarySha256: createHash('sha256').update(summaryJson).digest('hex') }
  expect(() => replayPatrolRecording({ recording, summaryJson })).toThrow('patrol-recording-array')
}, 30000)

test('invalid complete input publishes nothing while exact metadata read caps and source member reordering remain supported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patrol-preflight-'))
  try {
    const invalid = join(root, 'invalid')
    await expect(writePatrolDataset(invalid, { unsignedLocalReview: true, decisions: [flight(), { ...flight('deny', 60000, 'last', 1767225660000), atMs: 60001 }] })).rejects.toThrow('Invalid patrol input')
    await expect(stat(invalid)).rejects.toThrow('ENOENT')
    const written = await writePatrolDataset(join(root, 'dataset'))
    const path = join(written.directory, 'recording.json')
    const recording = JSON.parse(await readFile(path, 'utf8'))
    const reordered = { summarySha256: recording.summarySha256, input: recording.input, engine: recording.engine, replayProfile: recording.replayProfile, evidence: recording.evidence, version: recording.version }
    const padded = `${JSON.stringify(reordered).padEnd(4095, ' ')}\n`
    expect(Buffer.byteLength(padded)).toBe(4096)
    await writeFile(path, padded)
    const manifest = JSON.parse(await readFile(written.manifest, 'utf8'))
    manifest.files[0].bytes = 4096
    manifest.files[0].sha256 = createHash('sha256').update(padded).digest('hex')
    await writeFile(written.manifest, JSON.stringify(manifest))
    expect((await replayPatrolDataset(written.directory)).verified).toBe(true)
    await writeFile(path, `${padded} `)
    await expect(replayPatrolDataset(written.directory)).rejects.toThrow('4096')
    await writeFile(path, padded)
    await writeFile(written.manifest, `${JSON.stringify(manifest).padEnd(4095, ' ')}\n`)
    expect((await replayPatrolDataset(written.directory)).verified).toBe(true)
    await writeFile(written.manifest, new Uint8Array([255]))
    await expect(replayPatrolDataset(written.directory)).rejects.toThrow()
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('recorded denial and genuinely failed review retain their own status after fresh consistency verification', () => {
  for (const [decision, atMs, status] of [['deny', 2000, 'reviewed-denials'], ['approve', 5000, 'failed']] as const) {
    const bundle = createPatrolRecording({ unsignedLocalReview: true, decisions: [flight(decision, atMs)] })
    expect(() => replayPatrolRecording(bundle)).toThrow('patrol-replay-consent-required')
    const replay = replayPatrolRecording(bundle, { unsignedLocalReview: true })
    expect(replay.verified).toBe(true)
    expect(replay.summary.status).toBe(status)
    expect(replay.summary.counts.flightRequests).toBe(0)
    expect(`${JSON.stringify(replay.summary)}\n`).toBe(bundle.summaryJson)
    const invalidStored = { ...bundle, recording: { ...bundle.recording, input: { ...bundle.recording.input, unsignedLocalReview: false } } }
    expect(() => replayPatrolRecording(invalidStored, { unsignedLocalReview: true })).toThrow('Invalid patrol input')
  }
}, 30000)

test('visible consistent completion survives pending cleanup but pending alone corruption and unsafe file types refuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patrol-completion-'))
  try {
    const target = join(root, 'dataset')
    const completed = await writePatrolDataset(target)
    const manifestBytes = await readFile(completed.manifest)
    const summaryPath = join(target, 'summary.json')
    const summaryBytes = await readFile(summaryPath)
    await expect(writePatrolDataset(target)).rejects.toThrow('EEXIST')
    expect(await readFile(completed.manifest)).toEqual(manifestBytes)
    // Actual hard-link fixture represents visible completion before pending cleanup, not a crash experiment.
    await link(completed.manifest, join(target, 'manifest.pending.json'))
    expect((await replayPatrolDataset(target)).verified).toBe(true)
    await rm(completed.manifest)
    await expect(replayPatrolDataset(target)).rejects.toThrow('ENOENT')
    await writeFile(completed.manifest, manifestBytes)
    const alias = join(root, 'alias')
    await symlink(target, alias)
    await expect(replayPatrolDataset(alias)).rejects.toThrow('patrol-dataset-directory')
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    manifest.files[0].path = '../outside.json'
    await writeFile(completed.manifest, JSON.stringify(manifest))
    await expect(replayPatrolDataset(target)).rejects.toThrow('patrol-dataset-file')
    await writeFile(completed.manifest, manifestBytes)
    await writeFile(summaryPath, '{}\n')
    await expect(replayPatrolDataset(target)).rejects.toThrow('patrol-dataset-digest')
    await rm(summaryPath)
    await symlink(join(target, 'recording.json'), summaryPath)
    await expect(replayPatrolDataset(target)).rejects.toThrow()
    await rm(summaryPath)
    expect(Bun.spawnSync(['mkfifo', summaryPath]).exitCode).toBe(0)
    await expect(replayPatrolDataset(target)).rejects.toThrow('regular')
    await rm(summaryPath)
    await mkdir(summaryPath)
    await expect(replayPatrolDataset(target)).rejects.toThrow('regular')
    await rm(summaryPath, { recursive: true })
    await writeFile(summaryPath, summaryBytes)
    await writeFile(completed.manifest, ' '.repeat(4097))
    await expect(replayPatrolDataset(target)).rejects.toThrow('4096')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('completed dataset BOM handling preserves raw hashes and enforces multibyte byte limits before parsing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patrol-bom-'))
  try {
    const completed = await writePatrolDataset(join(root, 'dataset'))
    const original = {
      'recording.json': await readFile(join(completed.directory, 'recording.json'), 'utf8'),
      'summary.json': await readFile(join(completed.directory, 'summary.json'), 'utf8'),
      'manifest.json': await readFile(completed.manifest, 'utf8'),
    }
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    for (const name of ['recording.json', 'summary.json', 'manifest.json'] as const) {
      for (const [file, text] of Object.entries(original)) await writeFile(join(completed.directory, file), text)
      const manifest = JSON.parse(original['manifest.json'])
      const prefixed = `\uFEFF${original[name]}`
      await writeFile(join(completed.directory, name), prefixed)
      if (name !== 'manifest.json') {
        const index = name === 'recording.json' ? 0 : 1
        manifest.files[index].bytes = Buffer.byteLength(prefixed)
        manifest.files[index].sha256 = hash(prefixed)
        if (name === 'summary.json') {
          const recording = JSON.parse(original['recording.json'])
          recording.summarySha256 = hash(prefixed)
          const text = `${JSON.stringify(recording)}\n`
          await writeFile(join(completed.directory, 'recording.json'), text)
          manifest.files[0].bytes = Buffer.byteLength(text)
          manifest.files[0].sha256 = hash(text)
        }
        await writeFile(completed.manifest, `${JSON.stringify(manifest)}\n`)
      }
      await expect(replayPatrolDataset(completed.directory)).rejects.toThrow(name === 'summary.json' ? 'patrol-recording-summary-json' : 'patrol-dataset-json')
    }
    for (const [file, text] of Object.entries(original)) await writeFile(join(completed.directory, file), text)
    // This manifest dishonestly describes stripped bytes; the actual prefixed file must fail its raw digest.
    await writeFile(join(completed.directory, 'recording.json'), `\uFEFF${original['recording.json']}`)
    await expect(replayPatrolDataset(completed.directory)).rejects.toThrow('patrol-dataset-digest')
    const multibyte = `${JSON.stringify({ ...JSON.parse(original['recording.json']), padding: 'é'.repeat(2000) })}\n`
    expect(multibyte.length).toBeLessThan(4096)
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(4096)
    // Keep the declared entry bounded so the actual regular-file byte budget is the refusal seam.
    await writeFile(join(completed.directory, 'recording.json'), multibyte)
    await expect(replayPatrolDataset(completed.directory)).rejects.toThrow('Artifact must be a regular file up to 4096 bytes')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('complete codec preflight refuses malformed bytes identities and schema while semantic tampering fails the actual rerun', () => {
  const bundle = createPatrolRecording()
  const replace = (summaryJson: string) => ({ recording: { ...bundle.recording, summarySha256: createHash('sha256').update(summaryJson).digest('hex') }, summaryJson })
  expect(() => replayPatrolRecording(bundle.recording)).toThrow('patrol-recording-fields')
  expect(() => replayPatrolRecording({ ...bundle, extra: true })).toThrow(TypeError)
  expect(() => replayPatrolRecording({ ...bundle, recording: { ...bundle.recording, replayProfile: 'future' } })).toThrow('patrol-recording-profile-unsupported')
  expect(() => replayPatrolRecording({ ...bundle, recording: { ...bundle.recording, engine: { name: 'bun', version: '0.0.0' } } })).toThrow('patrol-recording-engine-unsupported')
  for (const version of ['1.4.2', '1.4.3', '1.4.4']) {
    if (version !== Bun.version) expect(() => replayPatrolRecording({ ...bundle, recording: { ...bundle.recording, engine: { name: 'bun', version } } })).toThrow('patrol-recording-engine-mismatch')
  }
  expect(() => replayPatrolRecording({ ...bundle, summaryJson: `${bundle.summaryJson} ` })).toThrow('patrol-recording-summary')
  expect(() => replayPatrolRecording(replace(`${bundle.summaryJson}\n`))).toThrow('patrol-recording-summary-shape')
  expect(() => replayPatrolRecording(replace(' '.repeat(16385)))).toThrow('patrol-recording-summary')
  expect(() => replayPatrolRecording(replace(bundle.summaryJson.replace('"usedWh":0', '"usedWh":0.0')))).toThrow('patrol-recording-summary-shape')
  expect(() => replayPatrolRecording(replace(bundle.summaryJson.replace('"usedWh":0', '"usedWh":1e999')))).toThrow('patrol-recording-value')
  const malformedId = JSON.parse(bundle.summaryJson)
  malformedId.host.sessionId = '000123'
  expect(() => replayPatrolRecording(replace(`${JSON.stringify(malformedId)}\n`))).toThrow('patrol-recording-uint64')
  const tooMany = JSON.parse(bundle.summaryJson)
  tooMany.reasons = Array.from({ length: 9 }, () => 'reason')
  expect(() => replayPatrolRecording(replace(`${JSON.stringify(tooMany)}\n`))).toThrow('patrol-recording-array')
  let deep: unknown = 0
  for (let n = 0; n < 17; n++) deep = { child: deep }
  const depth = JSON.parse(bundle.summaryJson)
  depth.energy.extra = deep
  expect(() => replayPatrolRecording(replace(`${JSON.stringify(depth)}\n`))).toThrow('patrol-recording-structure')
  let broad: unknown = 0
  for (let n = 0; n < 4; n++) broad = Array.from({ length: 8 }, () => broad)
  const nodes = JSON.parse(bundle.summaryJson)
  nodes.energy.extra = broad
  expect(() => replayPatrolRecording(replace(`${JSON.stringify(nodes)}\n`))).toThrow('patrol-recording-structure')
  const changed = JSON.parse(bundle.summaryJson)
  changed.counts.armsAccepted = 1
  expect(() => replayPatrolRecording(replace(`${JSON.stringify(changed)}\n`))).toThrow('patrol-recording-model-mismatch')
  let reads = 0
  const consent = Object.defineProperty({}, 'unsignedLocalReview', { enumerable: true, get() {
    reads++
    return true
  } })
  expect(() => replayPatrolRecording(bundle, consent)).toThrow(TypeError)
  expect(reads).toBe(0)
}, 30000)

test('a private completed dataset snapshots one neutral run and verifies raw file bytes before fresh replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'patrol-recording-'))
  try {
    const input = { unsignedLocalReview: true, enableCharge: true, decisions: [] as unknown[] }
    const pending = writePatrolDataset(join(root, 'dataset'), input)
    input.decisions.push(flight())
    const written = await pending
    expect(written.summary.status).toBe('neutral-preview')
    expect(written.summary.counts.flightRequests).toBe(0)
    const manifest = JSON.parse(await readFile(written.manifest, 'utf8'))
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(['recording.json', 'summary.json'])
    for (const entry of manifest.files) {
      const bytes = await readFile(join(written.directory, entry.path))
      expect(entry.bytes).toBe(bytes.length)
      expect(entry.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(bytes.at(-1)).toBe(10)
      expect((await stat(join(written.directory, entry.path))).mode & 0o777).toBe(0o600)
    }
    expect((await stat(written.directory)).mode & 0o777).toBe(0o700)
    const replay = await replayPatrolDataset(written.directory)
    expect(replay.summary).toEqual(written.summary)
    expect(replay.verified).toBe(true)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('unknown recording and consent inspection failures are bounded without invoking accessors', () => {
  let reads = 0
  const trap = new Proxy({}, { ownKeys() { throw new Error('private-inspection-sentinel') } })
  expect(() => replayPatrolRecording(trap)).toThrow(TypeError)
  expect(() => replayPatrolRecording(trap)).not.toThrow('private-inspection-sentinel')
  const getter = Object.defineProperty({}, 'recording', { enumerable: true, get() {
    reads++
    return {}
  } })
  expect(() => replayPatrolRecording(getter)).toThrow(TypeError)
  expect(() => replayPatrolRecording({}, trap)).toThrow(TypeError)
  expect(reads).toBe(0)
})

const flight = (decision = 'approve', atMs = 2000, id = 'first', dueUtcMs = 1767225600000) => ({ kind: 'flight', id, atMs, dueUtcMs, decision })
test('real two-flight contact and partial-charge recording requires independent fresh consent without rewriting stored input', () => {
  const bundle = createPatrolRecording({ unsignedLocalReview: true, enableCharge: true, decisions: [flight(), { kind: 'charge', id: 'partial', atMs: 47000, occurrenceId: 'patrol-slot-zero', decision: 'approve' }, flight('approve', 60000, 'second', 1767225660000)] })
  const original = JSON.stringify(bundle)
  const summary = JSON.parse(bundle.summaryJson)
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ evidence: 'recording-first-nominal', engine: bundle.recording.engine, flights: summary.flights, charge: summary.charge.episodes, energy: summary.energy, counts: summary.counts }))
  expect(summary.status).toBe('completed')
  expect(summary.flights.map((f: { terminalAtMs: number }) => f.terminalAtMs)).toEqual([44120, 102120])
  expect(summary.charge.episodes[0].verifiedAtMs).toBe(48160)
  expect(summary.charge.episodes[0].isolatedAtMs).toBe(55400)
  expect(summary.energy.trueGrossGainWh).toBeCloseTo(.0592, 10)
  expect(() => replayPatrolRecording(bundle)).toThrow('patrol-replay-consent-required')
  expect(() => replayPatrolRecording(bundle, { unsignedLocalReview: true })).toThrow('patrol-replay-consent-required')
  const replay = replayPatrolRecording(bundle, { unsignedLocalReview: true, enableCharge: true })
  expect(`${JSON.stringify(replay.summary)}\n`).toBe(bundle.summaryJson)
  expect(JSON.stringify(bundle)).toBe(original)
  expect(replay.summary.counts.chargeFramesAccepted).toBe(400)
  expect(replay.summary.host.sessionId).toBe('123')
  expect(replay.summary.host.flightBootId).toBe('55')
  expect(replay.summary.host.chargerBootId).toBe('77')
}, 30000)
