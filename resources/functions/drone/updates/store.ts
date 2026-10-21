import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DownloadHTTPError, Updater } from 'tuf-js'
import { inspectRuntimeTrust } from './enrollment'
import type { RuntimeTrustSummary } from './enrollment'
import { directory, metadataLimit, regularFile, repositoryFile, safePath, sha256, syncDirectory, writeExclusive } from './files'
import { object, validateMetadata } from './metadata'
import { admitSignedRuntime, RuntimeManifestRejected } from './manifest'

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
function openDatabase(path: string, expectedSchema: string[]) {
  const before = protectedFile(path, path.endsWith('writer.sqlite') ? 1024 * 1024 : maximumDatabaseBytes)
  const db = new Database(path, { create: false, strict: true })
  try {
    const after = lstatSync(path)
    if (before.dev !== after.dev || before.ino !== after.ino) throw new Error('Update-store file replaced while opening')
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;')
    // Authenticate the protocol format before any configuration that could
    // rewrite a foreign database's journal/header format.
    checkSchema(db, expectedSchema)
    if (Object.values(db.query('PRAGMA journal_mode').get() as Record<string, unknown>)[0] !== 'delete') throw new Error('Unexpected update-store journal format')
    configure(db)
    return db
  }
  catch (error) { db.close(); throw error }
}
function checkSchema(db: Database, expected: string[]) {
  const definitions = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all().map(row => row.sql).sort()
  if (JSON.stringify(definitions) !== JSON.stringify([...expected].sort())) throw new Error('Unexpected update-store schema')
  const values = db.query<{ application_id: number }, []>('PRAGMA application_id').get()
  const version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  if (values?.application_id !== applicationId || version?.user_version !== 1 || Object.values(db.query('PRAGMA quick_check').get() as Record<string, unknown>)[0] !== 'ok' || db.query('PRAGMA foreign_key_check').all().length) throw new Error('Invalid update-store database integrity or version')
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
  const floors = db.query<{ clock: number, release: number, generation: number }, []>('SELECT coalesce((SELECT max(started_ms) FROM attempts), 0) AS clock, coalesce((SELECT max(accepted_release) FROM attempts), 0) AS release, (SELECT max(generation) FROM metadata) AS generation').get()!
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
      if (!['store.json', 'writer.sqlite', 'state.sqlite', 'writer.sqlite-journal', 'state.sqlite-journal'].includes(name)) throw new Error('Unexpected update-store entry')
      if (name.endsWith('-journal')) protectedFile(join(path, name), maximumDatabaseBytes, true)
    }
    writer = openDatabase(join(path, 'writer.sqlite'), [writerSchema])
    writer.exec('BEGIN IMMEDIATE')
    const owner = writer.query<{ store_id: string }, []>('SELECT store_id FROM writer').all()
    if (owner.length !== 1 || owner[0]!.store_id !== binding.storeId) throw new Error('Invalid update-store writer identity')
    db = openDatabase(join(path, 'state.sqlite'), schema)
    const initial = db.query<MetadataRow, []>('SELECT * FROM metadata WHERE generation = 0').get()
    if (initial?.sha256 !== trusted.policy.trustedRootSha256 || initial.version !== trusted.rootVersion || state(db, binding).release_floor < trusted.policy.minimumReleaseSequence) throw new Error('Update-store anchor or floor mismatch')
    summary(db, binding, options.storeSha256)
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
  phase: 'input-committed' | 'metadata-committed'
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

/** Verify bounded offline metadata and retain its accepted prefix. This does not stage, select or install an image. */
export async function refreshRuntimeTrustStore(options: StoreReference & { repository: string, clock: RuntimeUpdateClock, onProgress?: ProgressObserver }): Promise<Readonly<RuntimeTrustStoreSummary>> {
  options = { ...options }
  return withStore(options, async (db, binding, trusted) => {
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
      db.transaction(() => {
        db.query('UPDATE store_state SET release_floor = max(release_floor, ?) WHERE id = 1').run(runtime.releaseSequence)
        db.query("UPDATE attempts SET phase = 'verified', accepted_release = ? WHERE id = ?").run(runtime.releaseSequence, attempt)
      })()
      return summary(db, binding, options.storeSha256)
    }
    catch (error) {
      try { db.query("UPDATE attempts SET phase = 'maintenance' WHERE id = ?").run(attempt) }
      catch (persistence) { throw new AggregateError([error, persistence], 'Update failed and maintenance state could not be recorded') }
      throw error
    }
    finally { rmSync(cache, { recursive: true, force: true }) }
  })
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
