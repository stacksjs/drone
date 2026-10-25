import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeCompletedArtifact } from '../../artifacts/completed-directory'
import { readMissionFile } from '../missions/files'
import { normalizePatrolInput, simulatePatrol } from './patrol'

type EngineVersion = '1.4.2' | '1.4.3' | '1.4.4'

function captureEngine(): Readonly<{ name: 'bun', version: EngineVersion }> {
  const version = Bun.version
  if (version !== '1.4.2' && version !== '1.4.3' && version !== '1.4.4') throw new TypeError('patrol-engine-unsupported')
  return Object.freeze({ name: 'bun', version })
}

function sha256(text: string) { return createHash('sha256').update(text, 'utf8').digest('hex') }

/** Capture input once and run the existing finite model once. No runtime state is retained. */
export function createPatrolRecording(input: unknown = {}) {
  const engine = captureEngine()
  return createCaptured(input, engine).bundle
}

function createCaptured(input: unknown, engine: ReturnType<typeof captureEngine>) {
  const ownedInput = normalizePatrolInput(input)
  const summary = simulatePatrol(ownedInput)
  const summaryJson = `${JSON.stringify(summary)}\n`
  const recording = Object.freeze({ version: 1 as const, evidence: 'owned-patrol-input-and-summary' as const, replayProfile: 'owned-patrol-summary-v1' as const, engine, input: ownedInput, summarySha256: sha256(summaryJson) })
  if (Buffer.byteLength(`${JSON.stringify(recording)}\n`, 'utf8') > 4096) throw new RangeError('patrol-recording-size')
  return { bundle: Object.freeze({ recording, summaryJson }), summary }
}

function data(input: unknown, keys?: readonly string[]): Record<string, unknown> {
  let descriptors: PropertyDescriptorMap
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('patrol-recording-object')
    descriptors = Object.getOwnPropertyDescriptors(input)
  }
  catch { throw new TypeError('patrol-recording-fields') }
  const names = Reflect.ownKeys(descriptors)
  if (names.some(k => typeof k !== 'string' || !descriptors[k]?.enumerable || !('value' in descriptors[k]!)) || keys && (names.length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k)))) throw new TypeError('patrol-recording-fields')
  return Object.fromEntries(names.map(k => [k, descriptors[k as string]!.value]))
}

function consentInput(input: unknown) {
  const value = data(input)
  if (Object.keys(value).some(k => k !== 'unsignedLocalReview' && k !== 'enableCharge')) throw new TypeError('patrol-replay-consent')
  const unsignedLocalReview = Object.hasOwn(value, 'unsignedLocalReview') ? value.unsignedLocalReview : false
  const enableCharge = Object.hasOwn(value, 'enableCharge') ? value.enableCharge : false
  if (typeof unsignedLocalReview !== 'boolean' || typeof enableCharge !== 'boolean' || enableCharge && !unsignedLocalReview) throw new TypeError('patrol-replay-consent')
  return { unsignedLocalReview, enableCharge }
}

const summaryKeys = ['version', 'evidence', 'profile', 'physicalFlightEnabled', 'boardOutputsInhibited', 'identityAuthenticated', 'anchorUtcMs', 'horizonMs', 'status', 'reasons', 'decisions', 'recurrence', 'flights', 'charge', 'energy', 'host', 'counts']
function summaryBytes(value: unknown, digest: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 16384 || sha256(value) !== digest) throw new TypeError('patrol-recording-summary')
  let parsed: unknown
  try { parsed = JSON.parse(value) }
  catch { throw new TypeError('patrol-recording-summary-json') }
  let nodes = 0
  function visit(v: unknown, depth: number): void {
    if (++nodes > 2048 || depth > 16) throw new TypeError('patrol-recording-structure')
    if (v === null || typeof v === 'boolean') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (typeof v === 'string' && v.length <= 4096) return
    if (!v || typeof v !== 'object') throw new TypeError('patrol-recording-value')
    if (Array.isArray(v)) {
      if (v.length > 8) throw new TypeError('patrol-recording-array')
      for (const item of v) visit(item, depth + 1)
    }
    else {
      const fields = data(v)
      if (Object.keys(fields).length > 32) throw new TypeError('patrol-recording-fields')
      for (const [key, child] of Object.entries(fields)) {
        if (key.length > 4096) throw new TypeError('patrol-recording-text')
        visit(child, depth + 1)
      }
    }
  }
  visit(parsed, 0)
  const summary = data(parsed, summaryKeys)
  if (summary.version !== 1 || summary.evidence !== 'owned-patrol-simulation' || summary.profile !== 'nominal' || summary.physicalFlightEnabled !== false || summary.boardOutputsInhibited !== true || summary.identityAuthenticated !== false || summary.anchorUtcMs !== 1767225600000 || summary.horizonMs !== 180000 || `${JSON.stringify(parsed)}\n` !== value) throw new TypeError('patrol-recording-summary-shape')
  for (const [items, limit] of [[summary.decisions, 4], [summary.flights, 2], [data(summary.recurrence).slots, 2], [data(summary.charge).episodes, 2]] as const) {
    if (!Array.isArray(items) || items.length > limit) throw new TypeError('patrol-recording-array')
  }
  const host = data(summary.host), output = data(data(summary.charge).output)
  function uint64(v: unknown, nullable: boolean) {
    if (nullable && v === null) return
    if (typeof v !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > 0xffffffffffffffffn) throw new TypeError('patrol-recording-uint64')
  }
  for (const key of ['sessionId', 'flightBootId', 'estimatorBootId', 'chargerBootId']) uint64(host[key], true)
  uint64(output.bootId, false)
  if (host.reference !== null && (typeof host.reference !== 'string' || !/^[\x20-\x7e]{1,128}$/.test(host.reference))) throw new TypeError('patrol-recording-reference')
  return value
}

function capturedBundle(input: unknown, engine: ReturnType<typeof captureEngine>) {
  const bundle = data(input, ['recording', 'summaryJson'])
  const source = data(bundle.recording, ['version', 'evidence', 'replayProfile', 'engine', 'input', 'summarySha256'])
  const recordedEngine = data(source.engine, ['name', 'version'])
  if (source.version !== 1 || source.evidence !== 'owned-patrol-input-and-summary' || source.replayProfile !== 'owned-patrol-summary-v1' || recordedEngine.name !== 'bun') throw new TypeError('patrol-recording-profile-unsupported')
  if (recordedEngine.version !== '1.4.2' && recordedEngine.version !== '1.4.3' && recordedEngine.version !== '1.4.4') throw new TypeError('patrol-recording-engine-unsupported')
  if (recordedEngine.version !== engine.version) throw new TypeError('patrol-recording-engine-mismatch')
  const ownedInput = normalizePatrolInput(data(source.input, ['profile', 'unsignedLocalReview', 'enableCharge', 'decisions']))
  if (typeof source.summarySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.summarySha256)) throw new TypeError('patrol-recording-digest')
  const recording = { version: 1 as const, evidence: 'owned-patrol-input-and-summary' as const, replayProfile: 'owned-patrol-summary-v1' as const, engine: { name: 'bun' as const, version: recordedEngine.version }, input: ownedInput, summarySha256: source.summarySha256 }
  if (Buffer.byteLength(`${JSON.stringify(recording)}\n`, 'utf8') > 4096) throw new RangeError('patrol-recording-size')
  return { recording, summaryJson: summaryBytes(bundle.summaryJson, recording.summarySha256) }
}

function replayCaptured(input: unknown, consent: unknown, engine: ReturnType<typeof captureEngine>) {
  const fresh = consentInput(consent)
  const bundle = capturedBundle(input, engine)
  if (bundle.recording.input.decisions.length && !fresh.unsignedLocalReview || bundle.recording.input.decisions.some(d => d.kind === 'charge') && !fresh.enableCharge) throw new TypeError('patrol-replay-consent-required')
  const summary = simulatePatrol(bundle.recording.input)
  if (`${JSON.stringify(summary)}\n` !== bundle.summaryJson) throw new TypeError('patrol-recording-model-mismatch')
  const replay = { version: 1 as const, evidence: 'owned-patrol-model-rerun' as const, replayProfile: 'owned-patrol-summary-v1' as const, comparison: 'exact-compact-summary-json' as const, verified: true as const, authentication: 'unsigned-consistency' as const, runtimeStateRestored: false as const, fullTraceVerified: false as const, physicalFlightEnabled: false as const, summary }
  if (Buffer.byteLength(`${JSON.stringify(replay)}\n`, 'utf8') > 17408) throw new RangeError('patrol-replay-size')
  return replay
}

/** Recompute the fixed model; retained compact bytes are comparison data, never restored policy. */
export function replayPatrolRecording(input: unknown, consent: unknown = {}) {
  const engine = captureEngine()
  return replayCaptured(input, consent, engine)
}

function directoryPath(directory: string) {
  if (typeof directory !== 'string' || !directory.length || directory.length > 4096 || directory.includes('\0')) throw new TypeError('patrol-dataset-directory')
  const target = resolve(directory)
  if (target.length > 4096) throw new TypeError('patrol-dataset-directory')
  return target
}

/** Exclusive completion publication; rejection never promises that no visible manifest exists. */
export async function writePatrolDataset(directory: string, input: unknown = {}) {
  const engine = captureEngine()
  const target = directoryPath(directory)
  const { bundle, summary } = createCaptured(input, engine)
  const entries = [{ path: 'recording.json', contents: `${JSON.stringify(bundle.recording)}\n` }, { path: 'summary.json', contents: bundle.summaryJson }]
  const manifest = { version: 1, kind: 'patrol-input-summary-dataset', authentication: 'unsigned-content-hashes', files: entries.map(f => ({ path: f.path, bytes: Buffer.byteLength(f.contents, 'utf8'), sha256: sha256(f.contents) })), persistence: { protocol: 'exclusive-files-and-directory-fsync-before-manifest-link', hardwarePowerLossTested: false } }
  const manifestJson = `${JSON.stringify(manifest)}\n`
  if (Buffer.byteLength(manifestJson, 'utf8') > 4096 || entries.reduce((n, f) => n + Buffer.byteLength(f.contents, 'utf8'), Buffer.byteLength(manifestJson, 'utf8')) > 24576) throw new RangeError('patrol-dataset-size')
  const completed = await writeCompletedArtifact(target, entries, manifestJson)
  return { ...completed, summary }
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) }
  catch { throw new TypeError('patrol-dataset-json') }
}

/** Observed consistency only: visible completion need not mean its producer returned successfully. */
export async function replayPatrolDataset(directory: string, consent: unknown = {}) {
  const engine = captureEngine()
  const fresh = consentInput(consent)
  const target = directoryPath(directory)
  const information = await lstat(target)
  if (information.isSymbolicLink() || !information.isDirectory()) throw new TypeError('patrol-dataset-directory')
  const manifest = data(parseJson(await readMissionFile(join(target, 'manifest.json'), { maxBytes: 4096, preserveBom: true })), ['version', 'kind', 'authentication', 'files', 'persistence'])
  const persistence = data(manifest.persistence, ['protocol', 'hardwarePowerLossTested'])
  if (manifest.version !== 1 || manifest.kind !== 'patrol-input-summary-dataset' || manifest.authentication !== 'unsigned-content-hashes' || persistence.protocol !== 'exclusive-files-and-directory-fsync-before-manifest-link' || persistence.hardwarePowerLossTested !== false || !Array.isArray(manifest.files) || manifest.files.length !== 2) throw new TypeError('patrol-dataset-manifest')
  const files = manifest.files.map((entry, index) => {
    const file = data(entry, ['path', 'bytes', 'sha256'])
    const path = index === 0 ? 'recording.json' : 'summary.json'
    if (file.path !== path || !Number.isSafeInteger(file.bytes) || typeof file.bytes !== 'number' || file.bytes < 1 || file.bytes > [4096, 16384][index]! || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new TypeError('patrol-dataset-file')
    return { path, bytes: file.bytes, sha256: file.sha256 }
  })
  const texts: string[] = []
  for (const [index, file] of files.entries()) {
    const text = await readMissionFile(join(target, file.path), { maxBytes: [4096, 16384][index]!, preserveBom: true })
    if (Buffer.byteLength(text, 'utf8') !== file.bytes || sha256(text) !== file.sha256) throw new TypeError('patrol-dataset-digest')
    texts.push(text)
  }
  return replayCaptured({ recording: parseJson(texts[0]!), summaryJson: texts[1]! }, fresh, engine)
}
