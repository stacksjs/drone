import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DownloadHTTPError, Updater } from 'tuf-js'
import type { TargetFile } from 'tuf-js'
import { Readable } from 'node:stream'
import { finishRuntimeCandidate, runtimeCandidateOutput } from './candidate-files'
import type { RuntimeFirmwareStage } from './staging'
import { inspectRuntimeTrust } from './enrollment'
import type { RuntimeTrustSummary } from './enrollment'
import { directory, imageLimit, metadataLimit, regularFile, repositoryFile, safePath, sha256, syncDirectory, writeExclusive } from './files'
import { object, validateMetadata } from './metadata'
import { admitSignedRuntime, RuntimeManifestRejected } from './manifest'
import { observeRuntimeHostImage, runtimeHostBuildProject } from './host-runtime'
import { verifyRuntimeHostTranscript } from './host-evidence'
import { encodeRuntimeFrame } from '../runtime/protocol'

const applicationId = 0x44525453
const maximumGeneration = 10000
const maximumDatabaseBytes = 128 * 1024 * 1024
const activeStores = new Set<string>()
const writerSchema = 'CREATE TABLE writer (id INTEGER PRIMARY KEY CHECK(id = 1), store_id TEXT NOT NULL CHECK(length(store_id) = 32)) STRICT'
const schema = [
  `CREATE TABLE store_state (id INTEGER PRIMARY KEY CHECK(id = 1), store_id TEXT NOT NULL CHECK(length(store_id) = 32), enrollment_sha256 TEXT NOT NULL CHECK(length(enrollment_sha256) = 64), generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND ${maximumGeneration}), release_floor INTEGER NOT NULL CHECK(release_floor BETWEEN 1 AND 9007199254740991), clock_floor_ms INTEGER NOT NULL CHECK(clock_floor_ms BETWEEN 0 AND 253402300799000), FOREIGN KEY(generation) REFERENCES metadata(generation)) STRICT`,
  `CREATE TABLE attempts (id TEXT PRIMARY KEY CHECK(length(id) = 32), base_generation INTEGER NOT NULL, started_ms INTEGER NOT NULL CHECK(started_ms BETWEEN 1 AND 253402300799000), clock_source TEXT NOT NULL CHECK(length(clock_source) BETWEEN 1 AND 128), phase TEXT NOT NULL CHECK(phase IN ('pending', 'verified', 'recovered', 'maintenance')), accepted_release INTEGER CHECK(accepted_release BETWEEN 1 AND 9007199254740991), CHECK(phase != 'verified' OR accepted_release IS NOT NULL), FOREIGN KEY(base_generation) REFERENCES metadata(generation)) STRICT`,
  `CREATE TABLE inputs (attempt_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 63), path TEXT NOT NULL CHECK(length(path) BETWEEN 1 AND 256), status INTEGER NOT NULL CHECK(status IN (200, 404)), bytes BLOB, sha256 TEXT, PRIMARY KEY(attempt_id, ordinal), FOREIGN KEY(attempt_id) REFERENCES attempts(id), CHECK((status = 404 AND bytes IS NULL AND sha256 IS NULL) OR (status = 200 AND bytes IS NOT NULL AND sha256 IS NOT NULL AND length(bytes) BETWEEN 1 AND ${metadataLimit} AND length(sha256) = 64))) STRICT`,
  `CREATE TABLE metadata (generation INTEGER PRIMARY KEY CHECK(generation BETWEEN 0 AND ${maximumGeneration}), attempt_id TEXT, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 63), role TEXT NOT NULL CHECK(length(role) BETWEEN 1 AND 180), version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991), epoch INTEGER NOT NULL CHECK(epoch BETWEEN 0 AND generation), bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND ${metadataLimit}), sha256 TEXT NOT NULL CHECK(length(sha256) = 64), UNIQUE(attempt_id, ordinal), FOREIGN KEY(attempt_id) REFERENCES attempts(id)) STRICT`,
]
const candidateSchema = [
  'CREATE TABLE candidates (id TEXT PRIMARY KEY CHECK(length(id) = 32), attempt_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN (\'reserved\', \'prepared\', \'retired\')), description BLOB NOT NULL CHECK(length(description) BETWEEN 1 AND 16384), sha256 TEXT NOT NULL CHECK(length(sha256) = 64), FOREIGN KEY(attempt_id) REFERENCES attempts(id), FOREIGN KEY(generation) REFERENCES metadata(generation)) STRICT',
  "CREATE UNIQUE INDEX candidate_active ON candidates ((1)) WHERE phase IN ('reserved', 'prepared')",
]
const slotSchema = [
  "CREATE TABLE host_slots (id TEXT PRIMARY KEY CHECK(length(id) = 32), candidate_id TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('selected', 'running', 'confirmed', 'failed', 'abandoned')), description BLOB NOT NULL CHECK(length(description) BETWEEN 1 AND 16384), sha256 TEXT NOT NULL CHECK(length(sha256) = 64), checked_ms INTEGER CHECK(checked_ms BETWEEN 1 AND 253402300799000), completed_ms INTEGER CHECK(completed_ms BETWEEN 1 AND 253402300799000), health BLOB CHECK(length(health) BETWEEN 1 AND 16384), FOREIGN KEY(candidate_id) REFERENCES candidates(id), FOREIGN KEY(attempt_id) REFERENCES attempts(id), FOREIGN KEY(generation) REFERENCES metadata(generation), CHECK((phase = 'confirmed') = (completed_ms IS NOT NULL AND health IS NOT NULL)), CHECK(phase != 'confirmed' OR (checked_ms IS NOT NULL AND completed_ms = checked_ms))) STRICT",
  "CREATE UNIQUE INDEX host_trial_active ON host_slots ((1)) WHERE phase IN ('selected', 'running')",
  'CREATE TABLE host_roles (id INTEGER PRIMARY KEY CHECK(id = 1), installed_id TEXT, good_id TEXT, FOREIGN KEY(installed_id) REFERENCES host_slots(id), FOREIGN KEY(good_id) REFERENCES host_slots(id)) STRICT',
  "CREATE TABLE host_inputs (slot_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 255), kind TEXT NOT NULL CHECK(kind IN ('tx', 'rx')), bytes BLOB NOT NULL CHECK(length(bytes) BETWEEN 1 AND 160), PRIMARY KEY(slot_id, ordinal), FOREIGN KEY(slot_id) REFERENCES host_slots(id)) STRICT",
]

interface TrustReference { enrollmentDirectory: string, enrollmentSha256: string }
interface StoreReference extends TrustReference { directory: string, storeSha256: string }
interface Binding { schema: 'drone-runtime-store-v1', storeId: string, enrollmentId: string, enrollmentSha256: string }
interface State { store_id: string, enrollment_sha256: string, generation: number, release_floor: number, clock_floor_ms: number }
interface MetadataRow { generation: number, attempt_id: string | null, ordinal: number, role: string, version: number, epoch: number, bytes: Uint8Array, sha256: string }
interface Attempt { id: string, base_generation: number, started_ms: number, clock_source: string, phase: 'pending' | 'verified' | 'recovered' | 'maintenance', accepted_release: number | null }
export interface RuntimeTrustStoreSummary {
  schema: 'drone-runtime-store-status-v1'
  storeId: string
  storeSha256: string
  enrollmentSha256: string
  generation: number
  epoch: number
  releaseFloor: number
  clockFloorMs: number
  retainedMetadataRecords: number
  metadata: ReadonlyArray<Readonly<{ role: string, version: number, sha256: string }>>
  attempt: Readonly<{ id: string, phase: Attempt['phase'], clockSource: string, startedMs: number }> | null
  physicalDeploymentAllowed: false
}

function protectedFile(path: string, limit: number, allowEmpty = false) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > limit || (!allowEmpty && stat.size === 0)) throw new Error('Invalid protected update-store file')
  return stat
}
function protectedDirectory(path: string) {
  directory(dirname(path)); directory(path)
  if ((lstatSync(path).mode & 0o777) !== 0o700) throw new Error('Update-store directory must be private')
}
function configure(db: Database) {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA page_size=4096; PRAGMA max_page_count=32768;')
  for (const [name, expected] of [['trusted_schema', 0], ['foreign_keys', 1], ['busy_timeout', 0], ['journal_mode', 'delete'], ['synchronous', 2], ['fullfsync', 1], ['page_size', 4096], ['max_page_count', 32768]] as const) {
    const result = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null
    if (!result || Object.values(result)[0] !== expected) throw new Error('Required SQLite update-store configuration unavailable')
  }
}
function openDatabase(path: string, expectedSchema: string[], allowCandidates = false) {
  const before = protectedFile(path, path.endsWith('writer.sqlite') ? 1024 * 1024 : maximumDatabaseBytes)
  const db = new Database(path, { create: false, strict: true })
  try {
    const after = lstatSync(path)
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Update-store file replaced while opening')
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;')
    // Authenticate the protocol format before any configuration that could
    // rewrite a foreign database's journal/header format.
    const version = databaseVersion(db)
    const additions = allowCandidates && version === 3 ? [...candidateSchema, ...slotSchema] : allowCandidates && version === 2 ? candidateSchema : []
    checkSchema(db, [...expectedSchema, ...additions], allowCandidates && (version === 2 || version === 3) ? version : 1)
    if (Object.values(db.query('PRAGMA journal_mode').get() as Record<string, unknown>)[0] !== 'delete') throw new Error('Unexpected update-store journal format')
    configure(db)
    return db
  }
  catch (error) { db.close(); throw error }
}
function databaseVersion(db: Database) { return db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version }
function checkSchema(db: Database, expected: string[], version = 1) {
  const definitions = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all().map(row => row.sql).sort()
  if (JSON.stringify(definitions) !== JSON.stringify([...expected].sort())) throw new Error('Unexpected update-store schema')
  const values = db.query<{ application_id: number }, []>('PRAGMA application_id').get()
  if (values?.application_id !== applicationId || databaseVersion(db) !== version || Object.values(db.query('PRAGMA quick_check').get() as Record<string, unknown>)[0] !== 'ok' || db.query('PRAGMA foreign_key_check').all().length) throw new Error('Invalid update-store database integrity or version')
}
function createDatabase(path: string, statements: string[]) {
  writeExclusive(path, Buffer.alloc(0))
  const db = new Database(path, { create: false, strict: true })
  try {
    configure(db)
    db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;`)
    db.transaction(() => { for (const sql of statements) db.exec(sql) })()
    return db
  }
  catch (error) { db.close(); throw error }
}
function admitBinding(bytes: Buffer, trusted: Readonly<RuntimeTrustSummary>): Binding {
  const item = object(JSON.parse(bytes.toString('utf8')))
  const keys = ['schema', 'storeId', 'enrollmentId', 'enrollmentSha256']
  if (Object.keys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key)) || item.schema !== 'drone-runtime-store-v1' || typeof item.storeId !== 'string' || !/^[a-f0-9]{32}$/.test(item.storeId) || item.enrollmentId !== trusted.enrollmentId || item.enrollmentSha256 !== trusted.enrollmentSha256) throw new Error('Update-store binding does not match enrollment')
  return item as unknown as Binding
}
function state(db: Database, binding: Binding) {
  const rows = db.query<State, []>('SELECT store_id, enrollment_sha256, generation, release_floor, clock_floor_ms FROM store_state').all()
  if (rows.length !== 1 || rows[0]!.store_id !== binding.storeId || rows[0]!.enrollment_sha256 !== binding.enrollmentSha256) throw new Error('Invalid update-store identity')
  return rows[0]!
}
function activeMetadata(db: Database, generation: number) {
  const root = db.query<MetadataRow, [number]>("SELECT * FROM metadata WHERE role = 'root' AND generation <= ? ORDER BY generation DESC LIMIT 1").get(generation)
  if (!root) throw new Error('Missing protected root')
  return db.query<MetadataRow, [number, number]>("SELECT * FROM metadata WHERE generation IN (SELECT max(generation) FROM metadata WHERE generation <= ? AND (role = 'root' OR epoch = ?) GROUP BY role) ORDER BY role").all(generation, root.epoch)
}
function checkedMetadataBytes(row: MetadataRow) {
  const bytes = Buffer.from(row.bytes)
  validateMetadata(bytes)
  const signed = object(object(JSON.parse(bytes.toString('utf8'))).signed)
  const kind = ['root', 'timestamp', 'snapshot'].includes(row.role) ? row.role : 'targets'
  if (!/^[a-z0-9][a-z0-9._-]{0,179}$/i.test(row.role) || sha256(bytes) !== row.sha256 || signed.version !== row.version || signed._type !== kind) throw new Error('Protected metadata integrity mismatch')
  return bytes
}
function summary(db: Database, binding: Binding, storeSha256: string): Readonly<RuntimeTrustStoreSummary> {
  const current = state(db, binding), metadata = activeMetadata(db, current.generation)
  const anchor = db.query<MetadataRow, []>('SELECT * FROM metadata WHERE generation = 0').get()
  if (!anchor || anchor.role !== 'root' || anchor.attempt_id !== null) throw new Error('Missing initial update-store anchor')
  for (const row of [anchor, ...metadata]) checkedMetadataBytes(row)
  const counts = db.query<{ attempts: number, metadata: number, inputs: number }, []>('SELECT (SELECT count(*) FROM attempts) AS attempts, (SELECT count(*) FROM metadata) AS metadata, (SELECT count(*) FROM inputs) AS inputs').get()!
  if (counts.attempts > 256 || counts.metadata !== current.generation + 1 || counts.metadata > maximumGeneration + 1 || counts.inputs > 16384) throw new Error('Update-store history budget exceeded or metadata history is incomplete')
  const clockQuery = databaseVersion(db) === 3 ? 'max(coalesce((SELECT max(started_ms) FROM attempts), 0), coalesce((SELECT max(checked_ms) FROM host_slots), 0))' : 'coalesce((SELECT max(started_ms) FROM attempts), 0)'
  const floors = db.query<{ clock: number, release: number, generation: number }, []>(`SELECT ${clockQuery} AS clock, coalesce((SELECT max(accepted_release) FROM attempts), 0) AS release, (SELECT max(generation) FROM metadata) AS generation`).get()!
  if (current.clock_floor_ms !== floors.clock || current.release_floor < floors.release || current.generation !== floors.generation || db.query<{ count: number }, []>("SELECT count(*) AS count FROM attempts WHERE phase IN ('pending', 'maintenance')").get()!.count > 1) throw new Error('Inconsistent update-store floors or attempts')
  const attempt = db.query<Attempt, []>('SELECT * FROM attempts ORDER BY rowid DESC LIMIT 1').get()
  return Object.freeze({ schema: 'drone-runtime-store-status-v1', storeId: binding.storeId, storeSha256, enrollmentSha256: binding.enrollmentSha256, generation: current.generation, epoch: metadata.find(row => row.role === 'root')!.epoch, releaseFloor: current.release_floor, clockFloorMs: current.clock_floor_ms, retainedMetadataRecords: counts.metadata, metadata: Object.freeze(metadata.map(row => Object.freeze({ role: row.role, version: row.version, sha256: row.sha256 }))), attempt: attempt ? Object.freeze({ id: attempt.id, phase: attempt.phase, clockSource: attempt.clock_source, startedMs: attempt.started_ms }) : null, physicalDeploymentAllowed: false })
}

async function withStore<T>(options: StoreReference, operation: (db: Database, binding: Binding, trusted: Readonly<RuntimeTrustSummary>, path: string) => T | Promise<T>): Promise<T> {
  const trusted = inspectRuntimeTrust({ directory: options.enrollmentDirectory, enrollmentSha256: options.enrollmentSha256 })
  const path = resolve(options.directory)
  protectedDirectory(path)
  if (typeof options.storeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.storeSha256)) throw new Error('Independent update-store pin required')
  protectedFile(join(path, 'store.json'), 16384)
  const bytes = regularFile(join(path, 'store.json'), 16384)
  if (sha256(bytes) !== options.storeSha256) throw new Error('Update-store pin mismatch')
  const binding = admitBinding(bytes, trusted), key = realpathSync(path)
  if (activeStores.has(key)) throw new Error('Update-store writer already active')
  activeStores.add(key)
  let writer: Database | undefined, db: Database | undefined
  try {
    for (const name of readdirSync(path)) {
      if (!['store.json', 'writer.sqlite', 'state.sqlite', 'writer.sqlite-journal', 'state.sqlite-journal', 'candidates', 'host-slots'].includes(name)) throw new Error('Unexpected update-store entry')
      if (name.endsWith('-journal')) protectedFile(join(path, name), maximumDatabaseBytes, true)
    }
    writer = openDatabase(join(path, 'writer.sqlite'), [writerSchema])
    writer.exec('BEGIN IMMEDIATE')
    const owner = writer.query<{ store_id: string }, []>('SELECT store_id FROM writer').all()
    if (owner.length !== 1 || owner[0]!.store_id !== binding.storeId) throw new Error('Invalid update-store writer identity')
    db = openDatabase(join(path, 'state.sqlite'), schema, true)
    if (readdirSync(path).includes('candidates')) {
      if (databaseVersion(db) < 2) throw new Error('Candidate files require an owned format2 or later store')
      protectedDirectory(join(path, 'candidates'))
    }
    const initial = db.query<MetadataRow, []>('SELECT * FROM metadata WHERE generation = 0').get()
    if (initial?.sha256 !== trusted.policy.trustedRootSha256 || initial.version !== trusted.rootVersion || state(db, binding).release_floor < trusted.policy.minimumReleaseSequence) throw new Error('Update-store anchor or floor mismatch')
    summary(db, binding, options.storeSha256)
    for (const row of candidateRows(db)) ownedDescription(db, row, trusted)
    if (readdirSync(path).includes('host-slots')) {
      if (databaseVersion(db) !== 3) throw new Error('Host slot files require an owned format3 store')
      protectedDirectory(join(path, 'host-slots'))
    }
    if (databaseVersion(db) === 3) slotsSummary(db, binding, trusted, path, options.storeSha256)
    return await operation(db, binding, trusted, path)
  }
  finally {
    try { db?.close() }
    finally {
      try { if (writer?.inTransaction) writer.exec('ROLLBACK') }
      finally { try { writer?.close() } finally { activeStores.delete(key) } }
    }
  }
}

/** Create a new host protocol store. Keep its returned pin independently; existing state is never reset. */
export async function createRuntimeTrustStore(options: TrustReference & { output: string }): Promise<Readonly<RuntimeTrustStoreSummary>> {
  const trusted = inspectRuntimeTrust({ directory: options.enrollmentDirectory, enrollmentSha256: options.enrollmentSha256 })
  const output = resolve(options.output)
  directory(dirname(output)); mkdirSync(output, { mode: 0o700 })
  const binding: Binding = { schema: 'drone-runtime-store-v1', storeId: randomBytes(16).toString('hex'), enrollmentId: trusted.enrollmentId, enrollmentSha256: trusted.enrollmentSha256 }
  const writer = createDatabase(join(output, 'writer.sqlite'), [writerSchema])
  try { writer.query('INSERT INTO writer VALUES(1, ?)').run(binding.storeId) }
  finally { writer.close() }
  const db = createDatabase(join(output, 'state.sqlite'), schema)
  try {
    const root = regularFile(join(options.enrollmentDirectory, 'root.json'), metadataLimit)
    if (sha256(root) !== trusted.policy.trustedRootSha256) throw new Error('Enrolled root changed during store initialization')
    db.transaction(() => {
      db.query("INSERT INTO metadata VALUES(0, NULL, 0, 'root', ?, 0, ?, ?)").run(trusted.rootVersion, root, sha256(root))
      db.query('INSERT INTO store_state VALUES(1, ?, ?, 0, ?, 0)').run(binding.storeId, binding.enrollmentSha256, trusted.policy.minimumReleaseSequence)
    })()
  }
  finally { db.close() }
  syncDirectory(output)
  const bytes = Buffer.from(`${JSON.stringify(binding)}\n`), storeSha256 = sha256(bytes)
  writeExclusive(join(output, 'store.json'), bytes); syncDirectory(output); syncDirectory(dirname(output))
  return inspectRuntimeTrustStore({ ...options, directory: output, storeSha256 })
}

/** Inspect protected host state under the same writer exclusion used by update operations. */
export async function inspectRuntimeTrustStore(options: StoreReference): Promise<Readonly<RuntimeTrustStoreSummary>> {
  return withStore(options, (db, binding) => summary(db, binding, options.storeSha256))
}

export interface RuntimeUpdateClock {
  /** Audit label for an independently trusted clock. The label itself is not attestation. */
  source: string
  read: () => Date
}

export interface RuntimeUpdateProgress {
  phase: 'input-committed' | 'metadata-committed' | 'image-written' | 'candidate-completed' | 'candidate-reserved' | 'candidate-recorded' | 'candidate-retired' | 'slot-selected' | 'slot-image-written' | 'runtime-started' | 'runtime-input-committed' | 'final-clock-committed' | 'runtime-confirmed'
  ordinal: number
}
type ProgressObserver = (event: Readonly<RuntimeUpdateProgress>) => void | Promise<void>
interface InputRow { ordinal: number, path: string, status: 200 | 404, bytes: Uint8Array | null, sha256: string | null }

function clockReading(clock: RuntimeUpdateClock, floor: number) {
  if (!clock || typeof clock.source !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(clock.source) || typeof clock.read !== 'function') throw new Error('An independently trusted update clock is required')
  const source = clock.source, time = clock.read()
  const milliseconds = time instanceof Date ? Date.prototype.getTime.call(time) : Number.NaN
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 253402300799000 || milliseconds < floor) throw new Error('Invalid or reversed update clock')
  return { source, time: new Date(milliseconds) }
}
function authorities(bytes: Uint8Array) {
  const roles = object(object(object(JSON.parse(Buffer.from(bytes).toString('utf8'))).signed).roles)
  return JSON.stringify(['timestamp', 'snapshot'].map(name => {
    const role = object(roles[name])
    if (!Array.isArray(role.keyids) || !role.keyids.every(id => typeof id === 'string')) throw new Error('Invalid verified role authority')
    return { keyids: [...role.keyids].sort(), threshold: role.threshold }
  }))
}
function workingCache(db: Database, generation: number) {
  const path = mkdtempSync(join(tmpdir(), 'drone-update-refresh-'))
  try {
    for (const row of activeMetadata(db, generation)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,179}$/i.test(row.role)) throw new Error('Unsafe protected metadata role')
      writeExclusive(join(path, `${row.role}.json`), checkedMetadataBytes(row))
    }
    return path
  }
  catch (error) { rmSync(path, { recursive: true, force: true }); throw error }
}
function invalidateActiveCache(cache: string) {
  for (const role of ['timestamp', 'snapshot']) {
    try { unlinkSync(join(cache, `${role}.json`)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
function commitMetadata(db: Database, binding: Binding, attempt: string, ordinal: number, role: string, bytes: Buffer) {
  validateMetadata(bytes)
  if (bytes.length > metadataLimit || !/^[a-z0-9][a-z0-9._-]{0,179}$/i.test(role)) throw new Error('Invalid verified metadata observation')
  const version = object(object(JSON.parse(bytes.toString('utf8'))).signed).version as number
  const current = state(db, binding), rows = activeMetadata(db, current.generation), prior = rows.find(row => row.role === role)!
  const root = rows.find(row => row.role === 'root')!
  if (current.generation >= maximumGeneration || (role === 'root' && version !== root.version + 1) || (prior && (version < prior.version || (version === prior.version && sha256(bytes) !== prior.sha256)))) throw new Error('Protected metadata floor or history limit rejected advancement')
  const changed = role === 'root' && authorities(root.bytes) !== authorities(bytes), epoch = root.epoch + (changed ? 1 : 0)
  db.transaction(() => {
    db.query('INSERT INTO metadata VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(current.generation + 1, attempt, ordinal, role, version, epoch, bytes, sha256(bytes))
    db.query('UPDATE store_state SET generation = ? WHERE id = 1').run(current.generation + 1)
  })()
  const readback = db.query<MetadataRow, [number]>('SELECT * FROM metadata WHERE generation = ?').get(current.generation + 1)
  if (!readback || readback.sha256 !== sha256(bytes) || !Buffer.from(readback.bytes).equals(bytes)) throw new Error('Verified metadata commit readback failed')
  return changed
}

interface RefreshOptions extends StoreReference { repository: string, clock: RuntimeUpdateClock, onProgress?: ProgressObserver }
interface VerifiedSelection {
  db: Database
  binding: Binding
  trusted: Readonly<RuntimeTrustSummary>
  source: string
  info: TargetFile
  runtime: ReturnType<typeof admitSignedRuntime>
  attempt: string
  path: string
}

async function refreshAndComplete<T>(options: RefreshOptions, complete: (selection: VerifiedSelection) => Promise<T>, before?: (db: Database) => void): Promise<{ store: Readonly<RuntimeTrustStoreSummary>, value: T }> {
  options = { ...options }
  return withStore(options, async (db, binding, trusted, path) => {
    before?.(db)
    if (db.query("SELECT id FROM attempts WHERE phase IN ('pending', 'maintenance')").get()) throw new Error('An unresolved update attempt requires recovery')
    const current = state(db, binding), now = clockReading(options.clock, current.clock_floor_ms)
    if (db.query<{ count: number }, []>('SELECT count(*) AS count FROM attempts').get()!.count >= 256) throw new Error('Update attempt history limit reached')
    const source = realpathSync(options.repository); directory(source)
    const cache = workingCache(db, current.generation), attempt = randomBytes(16).toString('hex')
    let requests = 0, received = 0, observations = 0
    try {
      db.transaction(() => {
        db.query("INSERT INTO attempts VALUES(?, ?, ?, ?, 'pending', NULL)").run(attempt, current.generation, now.time.getTime(), now.source)
        db.query('UPDATE store_state SET clock_floor_ms = ? WHERE id = 1').run(now.time.getTime())
      })()
      const fetcher = {
        async downloadBytes(url: string, limit: number) {
          const address = new URL(url), path = address.pathname.slice('/metadata/'.length)
          if (address.origin !== 'https://offline.invalid' || !address.pathname.startsWith('/metadata/') || address.search || address.hash || !/^(?:[0-9]+\.)?[a-z0-9][a-z0-9._-]{0,179}\.json$/i.test(path) || requests >= 64) throw new Error('Unsupported or excessive metadata request')
          safePath(path)
          let bytes: Buffer | null = null
          try { bytes = repositoryFile(source, `metadata/${path}`, Math.min(limit, metadataLimit)); validateMetadata(bytes) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          received += bytes?.length ?? 0
          if (received > 32 * 1024 * 1024) throw new Error('Metadata input budget exceeded')
          const index = requests++
          db.transaction(() => db.query('INSERT INTO inputs VALUES(?, ?, ?, ?, ?, ?)').run(attempt, index, path, bytes ? 200 : 404, bytes, bytes ? sha256(bytes) : null))()
          const saved = db.query<InputRow, [string, number]>('SELECT * FROM inputs WHERE attempt_id = ? AND ordinal = ?').get(attempt, index)
          if (!saved || saved.path !== path || saved.status !== (bytes ? 200 : 404) || (bytes ? !saved.bytes || !Buffer.from(saved.bytes).equals(bytes) || saved.sha256 !== sha256(bytes) : saved.bytes !== null || saved.sha256 !== null)) throw new Error('Metadata input commit readback failed')
          // Only our absent-file response may enter the SDK's HTTP classification.
          // Observer failures must abort even when their raw cause is an HTTP error.
          try { await options.onProgress?.(Object.freeze({ phase: 'input-committed', ordinal: index })) }
          catch (cause) { throw new Error('Update input progress observer rejected', { cause }) }
          if (!bytes) throw new DownloadHTTPError('Offline metadata is absent', 404)
          return Buffer.from(bytes)
        },
        async downloadFile(): Promise<never> { throw new Error('Metadata refresh never downloads an image') },
      }
      const updater = new Updater({ metadataDir: cache, metadataBaseUrl: 'https://offline.invalid/metadata/', fetcher, referenceTime: now.time, config: { maxRootRotations: 16, maxDelegations: 16, rootMaxLength: metadataLimit, timestampMaxLength: metadataLimit, snapshotMaxLength: metadataLimit, targetsMaxLength: metadataLimit }, async onVerifiedMetadata(role, bytes) {
        const index = observations++
        if (commitMetadata(db, binding, attempt, index, role, bytes)) invalidateActiveCache(cache)
        await options.onProgress?.(Object.freeze({ phase: 'metadata-committed', ordinal: index }))
      } })
      await updater.refresh()
      const info = await updater.getTargetInfo(trusted.policy.target)
      if (!info) throw new Error('Selected runtime target is absent')
      const runtime = admitSignedRuntime(info, { ...trusted.policy, minimumReleaseSequence: state(db, binding).release_floor })
      // The signed release floor survives later image or candidate-output failure.
      db.transaction(() => {
        db.query('UPDATE store_state SET release_floor = max(release_floor, ?) WHERE id = 1').run(runtime.releaseSequence)
        db.query('UPDATE attempts SET accepted_release = ? WHERE id = ?').run(runtime.releaseSequence, attempt)
      })()
      const value = await complete({ db, binding, trusted, source, info, runtime, attempt, path })
      db.query("UPDATE attempts SET phase = 'verified' WHERE id = ?").run(attempt)
      return { store: summary(db, binding, options.storeSha256), value }
    }
    catch (error) {
      try { db.query("UPDATE attempts SET phase = 'maintenance' WHERE id = ?").run(attempt) }
      catch (persistence) { throw new AggregateError([error, persistence], 'Update failed and maintenance state could not be recorded') }
      throw error
    }
    finally { rmSync(cache, { recursive: true, force: true }) }
  })
}

/** Verify bounded offline metadata and retain its accepted prefix. This never downloads an image. */
export async function refreshRuntimeTrustStore(options: RefreshOptions): Promise<Readonly<RuntimeTrustStoreSummary>> {
  return (await refreshAndComplete(options, async () => undefined)).store
}

export interface PreparedRuntimeFirmware {
  schema: 'drone-runtime-prepared-image-v1'
  store: Readonly<RuntimeTrustStoreSummary>
  candidate: Readonly<RuntimeFirmwareStage>
  trustStatePersisted: true
  physicalDeploymentAllowed: false
}

/** Authenticate an image under current protected metadata. Never installs, selects or confirms firmware. */
export async function prepareRuntimeFirmwareUpdate(options: RefreshOptions & { output: string }): Promise<Readonly<PreparedRuntimeFirmware>> {
  options = { ...options }
  const output = runtimeCandidateOutput(options.output, [options.repository, options.directory, options.enrollmentDirectory])
  const result = await refreshAndComplete(options, selection => writePreparedCandidate(selection, output, options.onProgress))
  return Object.freeze({ schema: 'drone-runtime-prepared-image-v1', store: result.store, candidate: result.value, trustStatePersisted: true, physicalDeploymentAllowed: false })
}

function candidateDescription({ db, binding, trusted, info, runtime }: VerifiedSelection): RuntimeFirmwareStage {
  const root = activeMetadata(db, state(db, binding).generation).find(row => row.role === 'root')!
  return { schema: 'drone-runtime-stage-v1', target: trusted.policy.target, platform: trusted.policy.platform, trustedRootSha256: root.sha256, rootVersion: root.version, ...runtime, protocolVersion: 1, signerDeclaredProfile: 'neutral-bench', length: info.length, sha256: info.hashes.sha256!, trustStatePersisted: false, physicalDeploymentAllowed: false }
}

async function writePreparedCandidate(selection: VerifiedSelection, output: string, onProgress?: ProgressObserver) {
  const { db, binding, source, info } = selection
  const rows = activeMetadata(db, state(db, binding).generation), root = rows.find(row => row.role === 'root')!
  const rootBytes = checkedMetadataBytes(root), consistent = object(object(JSON.parse(rootBytes.toString('utf8'))).signed).consistent_snapshot === true
  const path = consistent ? info.path.replace(/([^/]+)$/, `${info.hashes.sha256}.$1`) : info.path
  const image = repositoryFile(source, `targets/${path}`, imageLimit)
  await info.verify(Readable.from(image))
  const files = new Map<string, Buffer>()
  for (const row of rows) {
    if (row.role === 'root') continue
    files.set(`metadata/${row.role === 'timestamp' || !consistent ? '' : `${row.version}.`}${row.role}.json`, checkedMetadataBytes(row))
  }
  files.set(`targets/${path}`, image)
  const candidate = candidateDescription(selection)
  mkdirSync(output, { mode: 0o700 })
  writeExclusive(join(output, 'trust-root.json'), rootBytes)
  writeExclusive(join(output, 'image.bin'), image)
  await onProgress?.(Object.freeze({ phase: 'image-written', ordinal: 0 }))
  await finishRuntimeCandidate(output, info, candidate, files)
  await onProgress?.(Object.freeze({ phase: 'candidate-completed', ordinal: 0 }))
  return Object.freeze(candidate)
}

interface CandidateRow { id: string, attempt_id: string, generation: number, phase: 'reserved' | 'prepared' | 'retired', description: Uint8Array, sha256: string }
export interface RuntimeFirmwareCandidate {
  id: string
  attemptId: string
  generation: number
  phase: CandidateRow['phase']
  directory: string
  description: Readonly<RuntimeFirmwareStage>
  integrity: 'incomplete' | 'recorded-bytes-match' | 'mismatch' | 'unavailable'
  currentTrustValidated: false
}
export interface RuntimeFirmwareCandidates {
  schema: 'drone-runtime-candidates-v1'
  stateFormat: 1 | 2 | 3
  store: Readonly<RuntimeTrustStoreSummary>
  retainedCandidates: number
  /** Owned declarations only. Retired file integrity is not inspected or authenticated for current use. */
  history: ReadonlyArray<Readonly<Omit<RuntimeFirmwareCandidate, 'integrity' | 'currentTrustValidated'>>>
  candidate: Readonly<RuntimeFirmwareCandidate> | null
  physicalDeploymentAllowed: false
}

function candidateRows(db: Database) {
  if (databaseVersion(db) === 1) return []
  const rows = db.query<CandidateRow, []>('SELECT * FROM candidates ORDER BY rowid LIMIT 129').all()
  if (rows.length > 128) throw new Error('Candidate history budget exceeded')
  return rows
}
function ownedDescription(db: Database, row: CandidateRow, trusted: Readonly<RuntimeTrustSummary>): Readonly<RuntimeFirmwareStage> {
  const bytes = Buffer.from(row.description)
  if (!/^[a-f0-9]{32}$/.test(row.id) || sha256(bytes) !== row.sha256) throw new Error('Invalid owned candidate record')
  const value = object(JSON.parse(bytes.toString('utf8')))
  const keys = ['schema', 'target', 'platform', 'trustedRootSha256', 'rootVersion', 'releaseSequence', 'protocolVersion', 'sourceRevision', 'signerDeclaredProfile', 'length', 'sha256', 'trustStatePersisted', 'physicalDeploymentAllowed']
  const root = activeMetadata(db, row.generation).find(item => item.role === 'root')!
  checkedMetadataBytes(root)
  const attempt = db.query<Attempt, [string]>('SELECT * FROM attempts WHERE id = ?').get(row.attempt_id)
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) || value.schema !== 'drone-runtime-stage-v1' || value.target !== trusted.policy.target || value.platform !== trusted.policy.platform || value.trustedRootSha256 !== root.sha256 || value.rootVersion !== root.version || !Number.isSafeInteger(value.releaseSequence) || (value.releaseSequence as number) < trusted.policy.minimumReleaseSequence || value.protocolVersion !== 1 || typeof value.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceRevision) || value.signerDeclaredProfile !== 'neutral-bench' || !Number.isSafeInteger(value.length) || (value.length as number) < 1 || (value.length as number) > imageLimit || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) || value.trustStatePersisted !== false || value.physicalDeploymentAllowed !== false || !attempt || attempt.accepted_release !== value.releaseSequence || row.generation < attempt.base_generation) throw new Error('Owned candidate does not match protected selection')
  return Object.freeze(value as unknown as RuntimeFirmwareStage)
}
function candidateIntegrity(db: Database, generation: number, path: string, description: Readonly<RuntimeFirmwareStage>): RuntimeFirmwareCandidate['integrity'] {
  try {
    protectedDirectory(path)
    const rows = activeMetadata(db, generation), root = rows.find(row => row.role === 'root')!
    const rootBytes = checkedMetadataBytes(root), consistent = object(object(JSON.parse(rootBytes.toString('utf8'))).signed).consistent_snapshot === true
    const imagePath = consistent ? description.target.replace(/([^/]+)$/, `${description.sha256}.$1`) : description.target
    const expected = new Map<string, Buffer>([['trust-root.json', rootBytes], ['stage.json', Buffer.from(`${JSON.stringify(description, null, 2)}\n`)]])
    for (const row of rows) {
      if (row.role !== 'root') expected.set(`repository/metadata/${row.role === 'timestamp' || !consistent ? '' : `${row.version}.`}${row.role}.json`, checkedMetadataBytes(row))
    }
    for (const file of ['image.bin', `repository/targets/${imagePath}`]) {
      const address = join(path, file)
      protectedFile(address, imageLimit)
      const bytes = regularFile(address, imageLimit)
      if (bytes.length !== description.length || sha256(bytes) !== description.sha256) return 'mismatch'
      expected.set(file, bytes)
    }
    const directories = new Set<string>()
    for (const name of expected.keys()) {
      for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) directories.add(parent)
    }
    const visit = (relative: string): boolean => {
      const base = relative ? join(path, relative) : path
      protectedDirectory(base)
      const names = readdirSync(base)
      if (names.length > 64) return false
      return names.every(name => {
        const child = relative ? `${relative}/${name}` : name
        if (directories.has(child)) return visit(child)
        const bytes = expected.get(child)
        if (!bytes) return false
        protectedFile(join(path, child), child.endsWith('image.bin') || child.startsWith('repository/targets/') ? imageLimit : metadataLimit)
        return regularFile(join(path, child), Math.max(bytes.length, 1)).equals(bytes)
      })
    }
    if (!visit('')) return 'mismatch'
    for (const [name, bytes] of expected) {
      protectedFile(join(path, name), Math.max(bytes.length, 1))
      if (!regularFile(join(path, name), Math.max(bytes.length, 1)).equals(bytes)) return 'mismatch'
    }
    return 'recorded-bytes-match'
  }
  catch { return 'unavailable' }
}
function candidatesSummary(db: Database, binding: Binding, trusted: Readonly<RuntimeTrustSummary>, path: string, storeSha256: string): Readonly<RuntimeFirmwareCandidates> {
  const rows = candidateRows(db), active = rows.filter(row => row.phase !== 'retired')
  if (active.length > 1) throw new Error('Multiple active candidate records')
  let candidate: Readonly<RuntimeFirmwareCandidate> | null = null
  const history: Array<Readonly<Omit<RuntimeFirmwareCandidate, 'integrity' | 'currentTrustValidated'>>> = []
  for (const row of rows) {
    const description = ownedDescription(db, row, trusted)
    const directory = join(path, 'candidates', row.id)
    const recorded = Object.freeze({ id: row.id, attemptId: row.attempt_id, generation: row.generation, phase: row.phase, directory, description })
    history.push(recorded)
    if (row === active[0]) {
      candidate = Object.freeze({ ...recorded, integrity: row.phase === 'reserved' ? 'incomplete' : candidateIntegrity(db, row.generation, directory, description), currentTrustValidated: false })
    }
  }
  return Object.freeze({ schema: 'drone-runtime-candidates-v1', stateFormat: databaseVersion(db) as 1 | 2 | 3, store: summary(db, binding, storeSha256), retainedCandidates: rows.length, history: Object.freeze(history), candidate, physicalDeploymentAllowed: false })
}

/** Inspect owned host candidates. Recorded-byte integrity is not fresh selection or boot authorization. */
export async function inspectRuntimeFirmwareCandidates(options: StoreReference): Promise<Readonly<RuntimeFirmwareCandidates>> {
  return withStore(options, (db, binding, trusted, path) => candidatesSummary(db, binding, trusted, path, options.storeSha256))
}

/** Release only the exact active candidate reservation. Retain its records and bytes; never reset trust floors. */
export async function retireRuntimeFirmwareCandidate(options: StoreReference & { candidateId: string, onProgress?: ProgressObserver }): Promise<Readonly<RuntimeFirmwareCandidates>> {
  options = { ...options }
  if (typeof options.candidateId !== 'string' || !/^[a-f0-9]{32}$/.test(options.candidateId)) throw new Error('Exact active candidate identity required')
  return withStore(options, async (db, binding, trusted, path) => {
    const current = candidatesSummary(db, binding, trusted, path, options.storeSha256)
    if (current.store.attempt?.phase === 'pending' || current.store.attempt?.phase === 'maintenance') throw new Error('Resolve the metadata attempt before candidate retirement')
    if (!current.candidate || current.candidate.id !== options.candidateId) throw new Error('Exact active candidate identity required')
    db.query("UPDATE candidates SET phase = 'retired' WHERE id = ? AND phase IN ('reserved', 'prepared')").run(options.candidateId)
    await options.onProgress?.(Object.freeze({ phase: 'candidate-retired', ordinal: 0 }))
    return candidatesSummary(db, binding, trusted, path, options.storeSha256)
  })
}

/** Reserve one owned candidate and prepare signed bytes. No installed slot or health confirmation is changed. */
export async function reserveRuntimeFirmwareCandidate(options: RefreshOptions): Promise<Readonly<RuntimeFirmwareCandidates>> {
  options = { ...options }
  runtimeCandidateOutput(options.directory, [options.repository, options.enrollmentDirectory])
  const result = await refreshAndComplete(options, async selection => {
    const { db, binding, trusted, path, attempt } = selection
    if (databaseVersion(db) === 1) {
      db.transaction(() => { for (const sql of candidateSchema) db.exec(sql); db.exec('PRAGMA user_version=2') })()
      checkSchema(db, [...schema, ...candidateSchema], 2)
    }
    const id = randomBytes(16).toString('hex'), description = candidateDescription(selection)
    const bytes = Buffer.from(`${JSON.stringify(description)}\n`), generation = state(db, binding).generation
    db.query("INSERT INTO candidates VALUES(?, ?, ?, 'reserved', ?, ?)").run(id, attempt, generation, bytes, sha256(bytes))
    await options.onProgress?.(Object.freeze({ phase: 'candidate-reserved', ordinal: 0 }))
    const parent = join(path, 'candidates')
    if (!readdirSync(path).includes('candidates')) { mkdirSync(parent, { mode: 0o700 }); syncDirectory(path) }
    protectedDirectory(parent)
    const output = join(parent, id)
    await writePreparedCandidate(selection, output, options.onProgress)
    if (candidateIntegrity(db, generation, output, description) !== 'recorded-bytes-match') throw new Error('Owned candidate file readback failed')
    db.query("UPDATE candidates SET phase = 'prepared' WHERE id = ? AND phase = 'reserved'").run(id)
    await options.onProgress?.(Object.freeze({ phase: 'candidate-recorded', ordinal: 0 }))
    return candidatesSummary(db, binding, trusted, path, options.storeSha256)
  }, db => {
    const rows = candidateRows(db)
    if (rows.some(row => row.phase !== 'retired')) throw new Error('An active candidate requires explicit retirement or slot transition')
    if (rows.length >= 128) throw new Error('Candidate history budget reached')
  })
  return Object.freeze({ ...result.value, store: result.store })
}

interface HostSlotHealth { bootId: string, sessionId: string, ticks: number, cleanProcessExit: true, transcriptItems: number, transcriptSha256: string }
interface HostSlotRow { id: string, candidate_id: string, attempt_id: string, generation: number, phase: 'selected' | 'running' | 'confirmed' | 'failed' | 'abandoned', description: Uint8Array, sha256: string, checked_ms: number | null, completed_ms: number | null, health: Uint8Array | null }
export interface RuntimeHostSlot {
  id: string
  candidateId: string
  phase: HostSlotRow['phase']
  clockCheckedMs: number | null
  confirmedClockMs: number | null
  description: Readonly<RuntimeFirmwareStage>
  health: Readonly<HostSlotHealth> | null
  integrity: 'recorded-bytes-match' | 'mismatch' | 'unavailable'
  currentTrustValidated: false
}
export interface RuntimeFirmwareSlots {
  schema: 'drone-runtime-host-slots-v1'
  stateFormat: 1 | 2 | 3
  store: Readonly<RuntimeTrustStoreSummary>
  installed: Readonly<RuntimeHostSlot> | null
  knownGood: Readonly<RuntimeHostSlot> | null
  trial: Readonly<RuntimeHostSlot> | null
  retainedSlots: number
  physicalDeploymentAllowed: false
}
function hostRows(db: Database) {
  if (databaseVersion(db) < 3) return []
  const rows = db.query<HostSlotRow, []>('SELECT * FROM host_slots ORDER BY rowid LIMIT 129').all()
  if (rows.length > 128) throw new Error('Host slot history budget exceeded')
  return rows
}
function hostTranscript(db: Database, id: string) {
  const inputs = db.query<{ ordinal: number, kind: 'tx' | 'rx', bytes: Uint8Array }, [string]>('SELECT ordinal, kind, bytes FROM host_inputs WHERE slot_id = ? ORDER BY ordinal LIMIT 257').all(id)
  if (inputs.length > 256 || inputs.some((item, index) => item.ordinal !== index || item.kind !== (index % 2 ? 'rx' : 'tx') || (item.kind === 'rx' && item.bytes.length !== 64))) throw new Error('Invalid host health input history')
  return { inputs, digest: sha256(Buffer.from(JSON.stringify(inputs.map(item => ({ kind: item.kind, hex: Buffer.from(item.bytes).toString('hex') }))))) }
}
function slotHealth(db: Database, row: HostSlotRow): Readonly<HostSlotHealth> | null {
  const attempt = db.query<Attempt, [string]>('SELECT * FROM attempts WHERE id = ?').get(row.attempt_id)
  if (!attempt || (row.checked_ms !== null && row.checked_ms < attempt.started_ms)) throw new Error('Invalid retained host clock observation')
  if (row.phase !== 'confirmed') {
    if (row.health !== null || row.completed_ms !== null) throw new Error('Incomplete host slot has a health confirmation')
    hostTranscript(db, row.id)
    return null
  }
  if (!row.health || row.completed_ms === null || row.checked_ms !== row.completed_ms) throw new Error('Confirmed host slot lacks health or clock evidence')
  const value = object(JSON.parse(Buffer.from(row.health).toString('utf8')))
  const keys = ['bootId', 'sessionId', 'ticks', 'cleanProcessExit', 'transcriptItems', 'transcriptSha256']
  const transcript = hostTranscript(db, row.id)
  if (Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))
    || ![value.bootId, value.sessionId].every(id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id) && BigInt(id) <= 0xFFFFFFFFFFFFFFFFn)
    || value.ticks !== 100 || value.cleanProcessExit !== true || value.transcriptItems !== 214 || transcript.inputs.length !== value.transcriptItems || value.transcriptSha256 !== transcript.digest) throw new Error('Invalid retained host health confirmation')
  verifyRuntimeHostTranscript(transcript.inputs, { bootId: value.bootId as string, sessionId: value.sessionId as string })
  return Object.freeze(value as unknown as HostSlotHealth)
}
function slotsSummary(db: Database, binding: Binding, trusted: Readonly<RuntimeTrustSummary>, path: string, storeSha256: string): Readonly<RuntimeFirmwareSlots> {
  const rows = hostRows(db), slots = new Map<string, Readonly<RuntimeHostSlot>>()
  for (const row of rows) {
    const description = ownedDescription(db, { ...row, phase: 'prepared' }, trusted)
    const candidate = candidateRows(db).find(item => item.id === row.candidate_id)
    if (!candidate) throw new Error('Host slot candidate is missing')
    const original = ownedDescription(db, candidate, trusted)
    if (description.platform !== 'host-neutral-bench-v1' || original.sha256 !== description.sha256 || original.length !== description.length || original.sourceRevision !== description.sourceRevision || original.releaseSequence !== description.releaseSequence) throw new Error('Host slot does not match its owned candidate')
    let integrity: RuntimeHostSlot['integrity'] = 'unavailable'
    try {
      const directory = join(path, 'host-slots', row.id), file = join(directory, 'image.bin')
      protectedDirectory(directory)
      if (readdirSync(directory).length !== 1) integrity = 'mismatch'
      else {
        protectedFile(file, imageLimit)
        const image = regularFile(file, imageLimit)
        integrity = image.length === description.length && sha256(image) === description.sha256 ? 'recorded-bytes-match' : 'mismatch'
      }
    }
    catch { integrity = 'unavailable' }
    slots.set(row.id, Object.freeze({ id: row.id, candidateId: row.candidate_id, phase: row.phase, clockCheckedMs: row.checked_ms, confirmedClockMs: row.completed_ms, description, health: slotHealth(db, row), integrity, currentTrustValidated: false }))
  }
  let installed: Readonly<RuntimeHostSlot> | null = null, knownGood: Readonly<RuntimeHostSlot> | null = null
  if (databaseVersion(db) === 3) {
    const roles = db.query<{ id: number, installed_id: string | null, good_id: string | null }, []>('SELECT * FROM host_roles').all()
    if (roles.length !== 1 || roles[0]!.id !== 1) throw new Error('Invalid host slot roles')
    const role = roles[0]!
    installed = role.installed_id ? slots.get(role.installed_id) ?? null : null
    knownGood = role.good_id ? slots.get(role.good_id) ?? null : null
    if ((role.installed_id && !installed) || (role.good_id && (!knownGood || knownGood.phase !== 'confirmed')) || installed?.phase === 'selected') throw new Error('Invalid installed or known-good host role')
  }
  return Object.freeze({ schema: 'drone-runtime-host-slots-v1', stateFormat: databaseVersion(db) as 1 | 2 | 3, store: summary(db, binding, storeSha256), installed, knownGood, trial: rows.length ? slots.get(rows.at(-1)!.id)! : null, retainedSlots: rows.length, physicalDeploymentAllowed: false })
}

/** Historical host role/evidence inspection. This never authorizes use under current trust. */
export async function inspectRuntimeFirmwareSlots(options: StoreReference): Promise<Readonly<RuntimeFirmwareSlots>> {
  return withStore(options, (db, binding, trusted, path) => slotsSummary(db, binding, trusted, path, options.storeSha256))
}

/** Abandon only the exact interrupted host trial after metadata recovery. Retain every artifact and known-good role. */
export async function abandonRuntimeFirmwareTrial(options: StoreReference & { trialId: string }): Promise<Readonly<RuntimeFirmwareSlots>> {
  options = { ...options }
  if (typeof options.trialId !== 'string' || !/^[a-f0-9]{32}$/.test(options.trialId)) throw new Error('Exact interrupted host trial identity required')
  return withStore(options, (db, binding, trusted, path) => {
    const current = summary(db, binding, options.storeSha256)
    if (current.attempt?.phase === 'pending' || current.attempt?.phase === 'maintenance') throw new Error('Resolve metadata before abandoning a host trial')
    const row = hostRows(db).find(item => item.id === options.trialId && (item.phase === 'selected' || item.phase === 'running'))
    if (!row) throw new Error('Exact interrupted host trial identity required')
    const changed = db.query("UPDATE host_slots SET phase = 'abandoned' WHERE id = ? AND phase IN ('selected', 'running')").run(row.id)
    if (changed.changes !== 1) throw new Error('Host trial abandonment did not commit')
    return slotsSummary(db, binding, trusted, path, options.storeSha256)
  })
}

/** Fresh signed selection and actual owned host health. No caller health receipt is accepted. */
export async function trialRuntimeFirmwareCandidate(options: RefreshOptions & { candidateId: string, project: string }): Promise<Readonly<RuntimeFirmwareSlots>> {
  options = { ...options }
  if (typeof options.candidateId !== 'string' || !/^[a-f0-9]{32}$/.test(options.candidateId)) throw new Error('Exact owned candidate identity required')
  return runHostTrial(options, options.candidateId)
}

/** Rollback re-verifies current policy and observes a new actual health session for the retained good image. */
export async function rollbackRuntimeFirmwareSlot(options: RefreshOptions & { project: string }): Promise<Readonly<RuntimeFirmwareSlots>> {
  return runHostTrial(options)
}

async function runHostTrial(options: RefreshOptions & { project: string }, candidateId?: string): Promise<Readonly<RuntimeFirmwareSlots>> {
  options = { ...options }
  let rollbackSlotId: string | undefined
  if (typeof options.project !== 'string' || !options.project) throw new Error('Trusted local source project required')
  options = { ...options, project: runtimeHostBuildProject(options.project, [options.directory, options.enrollmentDirectory, options.repository]) }
  if (!options.clock || typeof options.clock.read !== 'function') throw new Error('An independently trusted update clock is required')
  const declaredClock = options.clock, readClock = declaredClock.read
  options = { ...options, clock: { source: declaredClock.source, read: () => readClock.call(declaredClock) } }
  const result = await refreshAndComplete(options, async selection => {
    const { db, binding, trusted, path, attempt } = selection
    if (rollbackSlotId) {
      const retained = slotsSummary(db, binding, trusted, path, options.storeSha256).knownGood
      if (!retained || retained.id !== rollbackSlotId || retained.integrity !== 'recorded-bytes-match') throw new Error('Retained known-good integrity failed before rollback')
    }
    const row = candidateRows(db).find(item => item.id === candidateId)
    if (!row || row.phase === 'reserved') throw new Error('A complete owned candidate is required for host trial')
    const description = candidateDescription(selection), original = ownedDescription(db, row, trusted)
    if (description.platform !== 'host-neutral-bench-v1' || original.sha256 !== description.sha256 || original.length !== description.length || original.sourceRevision !== description.sourceRevision || original.releaseSequence !== description.releaseSequence) throw new Error('Owned candidate is not the currently authorized host image')
    const candidatePath = join(path, 'candidates', row.id)
    if (candidateIntegrity(db, row.generation, candidatePath, original) !== 'recorded-bytes-match') throw new Error('Host trial candidate integrity failed')
    const image = regularFile(join(candidatePath, 'image.bin'), imageLimit)
    await selection.info.verify(Readable.from(image))
    if (databaseVersion(db) === 2) {
      db.transaction(() => {
        for (const sql of slotSchema) db.exec(sql)
        db.exec('INSERT INTO host_roles VALUES(1, NULL, NULL); PRAGMA user_version=3')
      })()
      checkSchema(db, [...schema, ...candidateSchema, ...slotSchema], 3)
    }
    const id = randomBytes(16).toString('hex'), bytes = Buffer.from(`${JSON.stringify(description)}\n`)
    db.query("INSERT INTO host_slots VALUES(?, ?, ?, ?, 'selected', ?, ?, NULL, NULL, NULL)").run(id, row.id, attempt, state(db, binding).generation, bytes, sha256(bytes))
    try {
      await options.onProgress?.(Object.freeze({ phase: 'slot-selected', ordinal: 0 }))
      const parent = join(path, 'host-slots')
      if (!readdirSync(path).includes('host-slots')) { mkdirSync(parent, { mode: 0o700 }); syncDirectory(path) }
      protectedDirectory(parent)
      const slotDirectory = join(parent, id)
      mkdirSync(slotDirectory, { mode: 0o700 }); syncDirectory(parent)
      let ordinal = 0
      const append = (kind: 'tx' | 'rx', bytes: Buffer) => {
        if (ordinal >= 256 || bytes.length < 1 || bytes.length > 160) throw new Error('Host trial input budget exceeded')
        const committed = ordinal
        db.query('INSERT INTO host_inputs VALUES(?, ?, ?, ?)').run(id, ordinal, kind, bytes)
        ordinal++
        return committed
      }
      const report = await observeRuntimeHostImage({ project: options.project, description, candidateImage: join(candidatePath, 'image.bin'), slotDirectory, protectedDirectories: [path, options.enrollmentDirectory, options.repository],
        async onReady() {
          await options.onProgress?.(Object.freeze({ phase: 'slot-image-written', ordinal: 0 }))
          db.transaction(() => {
            const changed = db.query("UPDATE host_slots SET phase = 'running' WHERE id = ? AND phase = 'selected'").run(id)
            if (changed.changes !== 1) throw new Error('Selected host slot changed before runtime launch')
            db.query('UPDATE host_roles SET installed_id = ? WHERE id = 1').run(id)
          })()
          await options.onProgress?.(Object.freeze({ phase: 'runtime-started', ordinal: 0 }))
        },
        async onRequest(line) { const ordinal = append('tx', Buffer.from(line)); await options.onProgress?.(Object.freeze({ phase: 'runtime-input-committed', ordinal })) },
        async onStatus(status) { const ordinal = append('rx', Buffer.from(encodeRuntimeFrame(status))); await options.onProgress?.(Object.freeze({ phase: 'runtime-input-committed', ordinal })) },
      })
      const clockStarted = performance.now(), completed = clockReading(options.clock, state(db, binding).clock_floor_ms)
      db.transaction(() => {
        const changed = db.query('UPDATE host_slots SET checked_ms = ? WHERE id = ?').run(completed.time.getTime(), id)
        if (changed.changes !== 1) throw new Error('Host clock observation lost its owned slot')
        db.query('UPDATE store_state SET clock_floor_ms = ? WHERE id = 1').run(completed.time.getTime())
      })()
      await options.onProgress?.(Object.freeze({ phase: 'final-clock-committed', ordinal: 0 }))
      const elapsed = performance.now() - clockStarted
      if (elapsed > 1000) throw new Error('Host confirmation clock sample became stale')
      for (const metadata of activeMetadata(db, state(db, binding).generation)) {
        const expires = object(object(JSON.parse(checkedMetadataBytes(metadata).toString('utf8'))).signed).expires
        if (typeof expires !== 'string' || !Number.isFinite(Date.parse(expires)) || completed.time.getTime() + Math.ceil(elapsed) >= Date.parse(expires)) throw new Error('Host trial metadata expired before confirmation')
      }
      const transcript = hostTranscript(db, id)
      const health: HostSlotHealth = { bootId: report.bootId, sessionId: report.sessionId, ticks: report.ticks, cleanProcessExit: true, transcriptItems: transcript.inputs.length, transcriptSha256: transcript.digest }
      if (health.transcriptItems !== 214) throw new Error('Host trial transcript is incomplete')
      verifyRuntimeHostTranscript(transcript.inputs, health)
      db.transaction(() => {
        const confirmed = db.query("UPDATE host_slots SET phase = 'confirmed', completed_ms = ?, health = ? WHERE id = ? AND phase = 'running'").run(completed.time.getTime(), Buffer.from(JSON.stringify(health)), id)
        if (confirmed.changes !== 1) throw new Error('Running host slot changed before confirmation')
        db.query('UPDATE host_roles SET good_id = ? WHERE id = 1').run(id)
        db.query('UPDATE store_state SET clock_floor_ms = ? WHERE id = 1').run(completed.time.getTime())
        const retired = db.query("UPDATE candidates SET phase = 'retired' WHERE id = ? AND phase = 'prepared'").run(row.id)
        if (retired.changes !== (row.phase === 'prepared' ? 1 : 0)) throw new Error('Owned candidate reservation changed before confirmation')
      })()
      await options.onProgress?.(Object.freeze({ phase: 'runtime-confirmed', ordinal: 0 }))
      return slotsSummary(db, binding, trusted, path, options.storeSha256)
    }
    catch (error) {
      try { db.query("UPDATE host_slots SET phase = 'failed' WHERE id = ? AND phase IN ('selected', 'running')").run(id) }
      catch (persistence) { throw new AggregateError([error, persistence], 'Host trial failed and its failure state could not be recorded') }
      throw error
    }
  }, db => {
    if (hostRows(db).some(row => row.phase === 'selected' || row.phase === 'running')) throw new Error('Interrupted host trial requires explicit recovery')
    if (hostRows(db).length >= 128) throw new Error('Host slot history budget reached')
    if (!candidateId) {
      if (databaseVersion(db) !== 3) throw new Error('No retained known-good host image for rollback')
      const role = db.query<{ good_id: string | null }, []>('SELECT good_id FROM host_roles WHERE id = 1').get()
      const previous = hostRows(db).find(row => row.id === role?.good_id && row.phase === 'confirmed')
      if (!previous) throw new Error('No retained known-good host image for rollback')
      candidateId = previous.candidate_id
      rollbackSlotId = previous.id
    }
  })
  return Object.freeze({ ...result.value, store: result.store })
}

function causedBy(error: unknown, marker: Error) {
  const seen = new Set<unknown>()
  for (let value = error; value instanceof Error && !seen.has(value) && seen.size < 8; value = Object.getOwnPropertyDescriptor(value, 'cause')?.value) {
    if (value === marker) return true
    seen.add(value)
  }
  return false
}

/** Replay an interrupted attempt from its exact base and durable inputs. This only retains floors, never authorizes image use. */
export async function recoverRuntimeTrustStore(options: StoreReference): Promise<Readonly<RuntimeTrustStoreSummary>> {
  options = { ...options }
  return withStore(options, async (db, binding, trusted) => {
    const pending = db.query<Attempt, []>("SELECT * FROM attempts WHERE phase IN ('pending', 'maintenance')").all()
    if (pending.length !== 1) throw new Error('Exactly one unresolved attempt is required for recovery')
    const attempt = pending[0]!, current = state(db, binding)
    const inputs = db.query<InputRow, [string]>('SELECT * FROM inputs WHERE attempt_id = ? ORDER BY ordinal').all(attempt.id)
    const committed = db.query<MetadataRow, [number]>('SELECT * FROM metadata WHERE generation > ? ORDER BY generation').all(attempt.base_generation)
    if (inputs.length > 64 || inputs.some((row, index) => row.ordinal !== index) || committed.some((row, index) => row.attempt_id !== attempt.id || row.ordinal !== index || row.generation !== attempt.base_generation + index + 1) || current.generation !== attempt.base_generation + committed.length) throw new Error('Interrupted attempt history is inconsistent')
    const cache = workingCache(db, attempt.base_generation), end = new Error('Recorded metadata input boundary reached')
    let replayRoot = activeMetadata(db, attempt.base_generation).find(row => row.role === 'root')!
    let delivered = 0, observed = 0, received = 0, release: number | null = null
    try {
      const fetcher = {
        async downloadBytes(url: string, limit: number) {
          const address = new URL(url), path = address.pathname.slice('/metadata/'.length)
          if (address.origin !== 'https://offline.invalid' || !address.pathname.startsWith('/metadata/') || address.search || address.hash) throw new Error('Unexpected recovery request')
          const item = inputs[delivered]
          if (!item) throw end
          if (item.path !== path) throw new Error('Recovery request differs from recorded input')
          delivered++
          if (item.status === 404) {
            if (item.bytes !== null || item.sha256 !== null) throw new Error('Invalid recorded missing response')
            throw new DownloadHTTPError('Recorded offline metadata is absent', 404)
          }
          if (!item.bytes) throw new Error('Missing recorded metadata bytes')
          const bytes = Buffer.from(item.bytes)
          received += bytes.length
          if (bytes.length < 1 || bytes.length > Math.min(limit, metadataLimit) || received > 32 * 1024 * 1024 || sha256(bytes) !== item.sha256) throw new Error('Recorded metadata input integrity or budget failure')
          validateMetadata(bytes)
          return bytes
        },
        async downloadFile(): Promise<never> { throw new Error('Recovery never downloads an image') },
      }
      const updater = new Updater({ metadataDir: cache, metadataBaseUrl: 'https://offline.invalid/metadata/', fetcher, referenceTime: new Date(attempt.started_ms), config: { maxRootRotations: 16, maxDelegations: 16, rootMaxLength: metadataLimit, timestampMaxLength: metadataLimit, snapshotMaxLength: metadataLimit, targetsMaxLength: metadataLimit }, onVerifiedMetadata(role, bytes) {
        const old = committed[observed], changed = role === 'root' && authorities(replayRoot.bytes) !== authorities(bytes)
        const epoch = replayRoot.epoch + (changed ? 1 : 0)
        if (old) {
          if (old.role !== role || old.sha256 !== sha256(bytes) || old.epoch !== epoch || !Buffer.from(old.bytes).equals(bytes)) throw new Error('Recovered metadata differs from committed prefix')
        }
        else commitMetadata(db, binding, attempt.id, observed, role, bytes)
        if (role === 'root') replayRoot = { ...replayRoot, bytes, epoch }
        if (changed) invalidateActiveCache(cache)
        observed++
      } })
      try {
        await updater.refresh()
        const info = await updater.getTargetInfo(trusted.policy.target)
        if (!info) throw new Error('Selected runtime target is absent during recovery')
        release = admitSignedRuntime(info, { ...trusted.policy, minimumReleaseSequence: state(db, binding).release_floor }).releaseSequence
      }
      catch (error) {
        // Only this owned pre-delivery marker can end replay without completing
        // metadata verification. SDK validation/IO/crypto errors stay maintenance.
        // A policy rejection raised here after complete SDK verification can end
        // the attempt without crediting a release. SDK/IO failures cannot.
        if (!causedBy(error, end) && !(error instanceof RuntimeManifestRejected)) throw error
      }
      if (delivered !== inputs.length || observed < committed.length) throw new Error('Recovery did not reproduce the full recorded prefix')
      db.transaction(() => {
        if (release !== null) db.query('UPDATE store_state SET release_floor = max(release_floor, ?) WHERE id = 1').run(release)
        db.query("UPDATE attempts SET phase = 'recovered', accepted_release = ? WHERE id = ?").run(release, attempt.id)
      })()
      return summary(db, binding, options.storeSha256)
    }
    catch (error) {
      try { db.query("UPDATE attempts SET phase = 'maintenance' WHERE id = ?").run(attempt.id) }
      catch (persistence) { throw new AggregateError([error, persistence], 'Recovery failed and maintenance state could not be recorded') }
      throw error
    }
    finally { rmSync(cache, { recursive: true, force: true }) }
  })
}
