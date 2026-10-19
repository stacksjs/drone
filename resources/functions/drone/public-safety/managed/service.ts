import type { TransactionHandle } from '@stacksjs/orm'
import type { PreparedCompletedArtifactDirectory, PreparedCompletedArtifactReceipt } from '../../../artifacts/native-storage/prepared-completed-artifact-directory'
import type { IncidentRow, ContentIncidentRow } from '../access/policy'
import type { SourceRow } from '../access/records'
import type { ManagedAbility, ManagedState, ManagedAction, ManagedOutcome, ManagedArtifactProjection, ManagedFileProjection, ManagedEventProjection, ManagedReceipt, ManagedListOptions, ManagedArtifactPage, ManagedArtifactRead, ManagedDownload, ManagedEventOptions, ManagedEventPage } from './types'
import type { FilePlan } from './files'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import { types } from 'node:util'
import { asRow, asRows, lockRow, mutationCount, resolvedDatabaseDriver } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { prepareCompletedArtifactDirectorySync } from '../../../artifacts/native-storage/prepared-completed-artifact-directory'
import { PublicSafetyAccessError } from '../access/errors'
import { exactRecord, expectedVersion, advance, maximumVersion, pagination } from '../access/mutations'
import { verifyStoredSource, matchConfig } from '../access/records'
import { renderPublicSafetyDataset } from '../export'
import { authorizePublicSafetyManaged, requirePublicSafetyManagedAccess, managedDeadline } from './policy'
import { managedBytes, managedRoot, sameRoot, qualifiedReceipt, sha256, managedUnavailable, inspectManagedArtifact, readManagedBytes, managedFingerprint } from './files'
export { PublicSafetyAccessError } from '../access/errors'

interface ArtifactRow {
  id: number, artifact_key: string, incident_id: number, retention_scope_id: number, source_id: number,
  source_digest: string, source_byte_length: number, source_created_sequence: number, config_digest: string,
  source_profile: string, dataset_profile: 'owned-public-safety-dataset-v1', request_id: string, request_digest: string,
  requester_user_id: number, requested_at_iso: string, version: number, generation: number, operation_nonce: string, state: ManagedState,
  created_incident_version: number, latest_incident_version: number, requested_retention_version: number,
  planned_root_json: string, target_path: string, receipt_json: string | null, plan_digest: string, file_count: number,
  total_planned_bytes: number, manifest_sha256: string, prepared_at_iso: string | null, completed_at_iso: string | null,
  interrupted_at_iso: string | null, completed_by_user_id: number | null, outcome_code: ManagedOutcome,
}
interface FileRow extends FilePlan { artifact_id: number, role: ManagedFileProjection['role'], capture_id: string | null, mime_type: string, observed_bytes: number | null, observed_sha256: string | null }
interface EventRow { id: number, artifact_id: number, sequence: number, incident_version: number, action: ManagedAction, actor_user_id: number, request_id: string, request_digest: string, step: string, at_iso: string, outcome_code: ManagedOutcome }
interface ScopeRow { id: number, incident_id: number, version: number, policy_version: string }
type Access = Awaited<ReturnType<typeof requirePublicSafetyManagedAccess>>
type Reader = Pick<TransactionHandle, 'selectFrom'>
const table = 'public_safety_managed_artifacts'
const fileTable = 'public_safety_managed_artifact_files'
const eventTable = 'public_safety_managed_artifact_events'
const sourceFields = ['id', 'incident_id', 'digest', 'byte_length', 'canonical_json', 'replay_profile', 'evidence', 'uploader_id', 'uploaded_at_iso', 'created_sequence']
const artifactListFields = ['id', 'artifact_key', 'version', 'state', 'source_id', 'source_digest', 'dataset_profile', 'requester_user_id', 'requested_at_iso', 'completed_at_iso', 'prepared_at_iso', 'file_count', 'total_planned_bytes', 'outcome_code']
const metadataFields = sourceFields.filter(field => field !== 'canonical_json')
function conflict(): never { throw new PublicSafetyAccessError(409, 'Managed dataset state has changed') }
function unavailable(): never { throw new PublicSafetyAccessError(404, 'Managed dataset is unavailable') }
function uuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid managed dataset identifier')
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid managed source digest')
}
function plain(input: unknown, keys: string[]) { if (types.isProxy(input)) throw new PublicSafetyAccessError(422, 'Invalid managed dataset fields'); return exactRecord(input, keys) }
function artifactProjection(row: ArtifactRow, access: Access): ManagedArtifactProjection {
  return { key: row.artifact_key, version: row.version, incidentVersion: access.incident.version, state: row.state, sourceId: row.source_id, sourceDigest: row.source_digest, datasetProfile: row.dataset_profile, requesterUserId: row.requester_user_id, requestedAt: row.requested_at_iso, completedAt: row.completed_at_iso, fileCount: row.file_count, totalBytes: row.total_planned_bytes, ownershipRecorded: row.prepared_at_iso !== null, outcome: row.outcome_code, sourceIdentityAuthenticated: false, physicalFlightEnabled: false, physicalThermalVerified: false, purgeImplemented: false, contentDeletionPerformed: false }
}
function fileProjection(row: FileRow): ManagedFileProjection { return { id: row.id, ordinal: row.ordinal, role: row.role, captureId: row.capture_id, filename: basename(row.relative_path), mimeType: row.mime_type, bytes: row.planned_bytes, sha256: row.sha256 } }
function eventProjection(row: EventRow): ManagedEventProjection { return { id: row.id, sequence: row.sequence, incidentVersion: row.incident_version, action: row.action, actorUserId: row.actor_user_id, requestId: row.request_id, at: row.at_iso, outcome: row.outcome_code } }
async function findArtifact(tx: Reader, access: Access, key: string): Promise<ArtifactRow> { return asRow<ArtifactRow>(await tx.selectFrom(table).selectAll().where('incident_id', '=', access.incident.id).where('artifact_key', '=', key).executeTakeFirst()) ?? unavailable() }
async function filesFor(tx: Reader, artifact: ArtifactRow): Promise<FileRow[]> {
  const rows = asRows<FileRow>(await tx.selectFrom(fileTable).selectAll().where('artifact_id', '=', artifact.id).orderBy('ordinal', 'asc').limit(772).execute())
  if (rows.length !== artifact.file_count || rows.length > 771 || rows.some((row, index) => row.ordinal !== index)) conflict()
  return rows
}
async function scopeFor(tx: Reader, access: Access): Promise<ScopeRow> {
  const scope = asRow<ScopeRow>(await tx.selectFrom('public_safety_retention_scopes').selectAll().where('incident_id', '=', access.incident.id).executeTakeFirst())
  if (!scope || scope.policy_version !== 'local-managed-v1') throw new PublicSafetyAccessError(409, 'Incident custody is not enrolled')
  return scope
}
async function locked(tx: TransactionHandle, key: string, ability: ManagedAbility) {
  const incident = asRow<IncidentRow>(await lockRow(tx, 'public_safety_incidents', { incident_key: key })) ?? unavailable()
  const access = await requirePublicSafetyManagedAccess(key, ability, tx, incident)
  await lockRow(tx, 'public_safety_retention_scopes', { incident_id: incident.id })
  return access
}
async function boundSource(tx: Reader, access: Access, artifact: ArtifactRow): Promise<void> {
  const row = asRow<SourceRow>(await tx.selectFrom('public_safety_sources').select(metadataFields).where('id', '=', artifact.source_id).where('incident_id', '=', access.incident.id).executeTakeFirst())
  const scope = await scopeFor(tx, access)
  if (!row || row.digest !== artifact.source_digest || row.byte_length !== artifact.source_byte_length || row.created_sequence !== artifact.source_created_sequence || row.replay_profile !== artifact.source_profile || row.evidence !== 'owned-public-safety-physics-simulation' || sha256(access.incident.config_json) !== artifact.config_digest || scope.id !== artifact.retention_scope_id) conflict()
}
function receipt(row: ArtifactRow): PreparedCompletedArtifactReceipt {
  if (!row.receipt_json || row.receipt_json.length > 4194304) return conflict()
  const value = JSON.parse(row.receipt_json) as PreparedCompletedArtifactReceipt
  if (value.directory !== row.target_path) conflict()
  return value
}
async function latest(tx: Reader, artifact: ArtifactRow): Promise<EventRow> { return asRow<EventRow>(await tx.selectFrom(eventTable).selectAll().where('artifact_id', '=', artifact.id).orderBy('sequence', 'desc').executeTakeFirst()) ?? conflict() }
async function replay(tx: Reader, access: Access, requestId: string, fingerprint: string): Promise<ManagedReceipt | undefined> {
  const row = asRow<ArtifactRow>(await tx.selectFrom(table).selectAll().where('incident_id', '=', access.incident.id).where('request_id', '=', requestId).executeTakeFirst())
  if (!row) return
  if (row.request_digest !== fingerprint || row.requester_user_id !== access.principal.userId) conflict()
  await boundSource(tx, access, row)
  const original = asRow<EventRow>(await tx.selectFrom(eventTable).selectAll().where('artifact_id', '=', row.id).where('step', '=', 'intent').executeTakeFirst()) ?? conflict()
  managedDeadline(access.incident)
  return { artifact: artifactProjection(row, access), event: eventProjection(original), replayed: true }
}
async function event(tx: TransactionHandle, access: Access, row: ArtifactRow, action: ManagedAction, requestId: string, fingerprint: string, step: string): Promise<ManagedReceipt> {
  const at = new Date().toISOString()
  await tx.insertInto(eventTable).values({ artifact_id: row.id, sequence: row.version, incident_version: access.incident.version, action, actor_user_id: access.principal.userId, at_iso: at, request_id: requestId, request_digest: fingerprint, step, outcome_code: row.outcome_code, created_at: at, updated_at: at }).execute()
  return { artifact: artifactProjection(row, access), event: eventProjection(await latest(tx, row)), replayed: false }
}
async function transition(tx: TransactionHandle, access: Access, row: ArtifactRow, state: ManagedState, changes: Partial<ArtifactRow> = {}): Promise<ArtifactRow> {
  if (row.version >= maximumVersion || row.generation >= maximumVersion) conflict()
  access.incident = await advance(tx, access.incident) as ContentIncidentRow
  const next = { ...row, ...changes, state, version: row.version + 1, generation: row.generation + 1, operation_nonce: randomUUID(), latest_incident_version: access.incident.version }
  const update = await tx.updateTable(table).set({ ...changes, state, version: next.version, generation: next.generation, operation_nonce: next.operation_nonce, latest_incident_version: next.latest_incident_version, updated_at: new Date().toISOString() }).where('id', '=', row.id).where('version', '=', row.version).where('generation', '=', row.generation).where('state', '=', row.state).executeTakeFirst()
  if (mutationCount(update) !== 1) conflict()
  return next
}
/** Same captured local tx, immediately followed by the synchronous deadline and FS stack. */
function continuity(tx: TransactionHandle, access: Access, row: ArtifactRow): void {
  if (resolvedDatabaseDriver() !== 'sqlite') managedUnavailable()
  const statement = tx.unsafe('UPDATE public_safety_managed_artifacts SET operation_nonce = operation_nonce WHERE id = ? AND version = ? AND generation = ? AND state = ? AND operation_nonce = ? RETURNING id', [row.id, row.version, row.generation, row.state, row.operation_nonce]) as unknown as { executeSync?: () => unknown }
  if (typeof statement.executeSync !== 'function') managedUnavailable()
  const rows = statement.executeSync()
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || (rows[0] as { id?: unknown }).id !== row.id) conflict()
  const observed = tx.unsafe('SELECT id FROM public_safety_managed_artifacts WHERE id = ? AND version = ? AND generation = ? AND state = ? AND operation_nonce = ?', [row.id, row.version, row.generation, row.state, row.operation_nonce]) as unknown as { executeSync?: () => unknown }
  if (typeof observed.executeSync !== 'function') managedUnavailable()
  const verified = observed.executeSync()
  if (!Array.isArray(verified) || verified.length !== 1 || !verified[0] || typeof verified[0] !== 'object' || (verified[0] as { id?: unknown }).id !== row.id) conflict()
  managedDeadline(access.incident)
}
function planFile(path: string, contents: string | Uint8Array, ordinal: number) {
  const name = basename(path)
  const role: ManagedFileProjection['role'] = path === 'recording.json' ? 'recording' : path === 'README.txt' ? 'readme' : path === 'manifest.json' ? 'manifest' : path.endsWith('.png') ? 'visible' : path.endsWith('.thermal-u16le') ? 'thermal' : 'support'
  return { ordinal, relative_path: path, role, capture_id: path.startsWith('images/') ? name.split('.')[0]! : null, mime_type: role === 'visible' ? 'image/png' : role === 'recording' || role === 'manifest' ? 'application/json' : role === 'readme' ? 'text/plain; charset=utf-8' : 'application/octet-stream', planned_bytes: Buffer.byteLength(contents), sha256: sha256(contents) }
}

export async function createPublicSafetyManagedDataset(key: string, input: unknown): Promise<ManagedReceipt> {
  const body = plain(input, ['expectedVersion', 'expectedRetentionVersion', 'sourceDigest', 'datasetProfile', 'requestId'])
  const expected = expectedVersion(body.expectedVersion), expectedRetention = expectedVersion(body.expectedRetentionVersion)
  uuid(body.requestId); digest(body.sourceDigest)
  if (body.datasetProfile !== 'owned-public-safety-dataset-v1') throw new PublicSafetyAccessError(422, 'Invalid managed dataset profile')
  await authorizePublicSafetyManaged(key, 'create')
  const staged = await transaction(async tx => {
    const access = await requirePublicSafetyManagedAccess(key, 'create', tx), fingerprint = sha256(JSON.stringify(['create', access.principal.userId, body]))
    const existing = await replay(tx, access, body.requestId as string, fingerprint)
    if (existing) return { existing }
    const scope = await scopeFor(tx, access)
    if (access.incident.version !== expected || scope.version !== expectedRetention) conflict()
    const source = asRow<SourceRow>(await tx.selectFrom('public_safety_sources').select(sourceFields).where('incident_id', '=', access.incident.id).where('digest', '=', body.sourceDigest).executeTakeFirst()) ?? unavailable()
    return { source, incident: access.incident, fingerprint }
  }, { retries: 0 })
  if (staged.existing) return staged.existing
  const run = verifyStoredSource(staged.source!), fingerprint = staged.fingerprint!
  matchConfig(run, staged.incident!)
  const rendered = await renderPublicSafetyDataset(run)
  const plan = [...rendered.files.map((file, i) => planFile(file.path, file.contents, i)), planFile('manifest.json', rendered.manifestJson, rendered.files.length)]
  const total = plan.reduce((sum, file) => sum + file.planned_bytes, 0)
  if (plan.length > 771 || total > managedBytes) throw new PublicSafetyAccessError(422, 'Managed dataset exceeds resource limits')
  const root = managedRoot(), artifactKey = randomUUID(), at = new Date().toISOString()
  const intent = await transaction(async tx => {
    const access = await locked(tx, key, 'create'), existing = await replay(tx, access, body.requestId as string, fingerprint)
    if (existing) return { existing }
    const scope = await scopeFor(tx, access)
    if (access.incident.version !== expected || scope.version !== expectedRetention) conflict()
    const current = asRow<SourceRow>(await tx.selectFrom('public_safety_sources').select(metadataFields).where('id', '=', staged.source!.id).where('incident_id', '=', access.incident.id).executeTakeFirst())
    if (!current || metadataFields.some(field => current[field as keyof SourceRow] !== staged.source![field as keyof SourceRow]) || access.incident.config_json !== staged.incident!.config_json) conflict()
    sameRoot(root)
    access.incident = await advance(tx, access.incident) as ContentIncidentRow
    managedDeadline(access.incident)
    await tx.insertInto(table).values({ artifact_key: artifactKey, incident_id: access.incident.id, retention_scope_id: scope.id, source_id: current.id, source_digest: current.digest, source_byte_length: current.byte_length, source_created_sequence: current.created_sequence, config_digest: sha256(access.incident.config_json), source_profile: current.replay_profile, dataset_profile: 'owned-public-safety-dataset-v1', request_id: body.requestId, request_digest: fingerprint, requester_user_id: access.principal.userId, requested_at_iso: at, version: 1, generation: 1, operation_nonce: randomUUID(), state: 'intent', created_incident_version: access.incident.version, latest_incident_version: access.incident.version, requested_retention_version: scope.version, planned_root_json: JSON.stringify(root), target_path: join(root.path, artifactKey), receipt_json: null, plan_digest: sha256(JSON.stringify(plan)), file_count: plan.length, total_planned_bytes: total, manifest_sha256: plan.at(-1)!.sha256, prepared_at_iso: null, completed_at_iso: null, interrupted_at_iso: null, completed_by_user_id: null, outcome_code: null, created_at: at, updated_at: at }).execute()
    const artifact = await findArtifact(tx, access, artifactKey)
    for (const file of plan) await tx.insertInto(fileTable).values({ artifact_id: artifact.id, ...file, identity_json: null, observed_bytes: null, observed_sha256: null, created_at: at, updated_at: at }).execute()
    return { artifact, result: await event(tx, access, artifact, 'intent-recorded', body.requestId as string, fingerprint, 'intent') }
  }, { retries: 0 })
  if (intent.existing) return intent.existing
  let prepared: PreparedCompletedArtifactDirectory | undefined
  try {
    const owned = await transaction(async tx => {
      const access = await locked(tx, key, 'create'), current = await findArtifact(tx, access, artifactKey)
      if (current.state !== 'intent' || current.version !== 1) conflict()
      await boundSource(tx, access, current)
      sameRoot(root)
      const next = await transition(tx, access, current, 'prepared')
      continuity(tx, access, next)
      prepared = prepareCompletedArtifactDirectorySync(current.target_path, rendered.files, rendered.manifestJson, { directories: rendered.directories })
      qualifiedReceipt(prepared.receipt)
      if (prepared.receipt.parent.path !== root.path || prepared.receipt.parent.dev !== root.dev || prepared.receipt.parent.ino !== root.ino || prepared.receipt.parent.birthtimeNs !== root.birthtimeNs) managedUnavailable()
      const encoded = JSON.stringify(prepared.receipt)
      if (encoded.length > 4194304) managedUnavailable()
      const files = await filesFor(tx, current)
      for (const file of files) {
        const identity = file.role === 'manifest' ? prepared.receipt.pendingManifest : prepared.receipt.files.find(item => item.path === join(prepared!.receipt.directory, file.relative_path))
        if (!identity || identity.bytes !== file.planned_bytes || identity.sha256 !== file.sha256) conflict()
        await tx.updateTable(fileTable).set({ identity_json: JSON.stringify(identity), observed_bytes: 0 }).where('id', '=', file.id).execute()
      }
      next.prepared_at_iso = new Date().toISOString()
      await tx.updateTable(table).set({ receipt_json: encoded, prepared_at_iso: next.prepared_at_iso }).where('id', '=', current.id).execute()
      next.receipt_json = encoded
      return event(tx, access, next, 'ownership-recorded', body.requestId as string, fingerprint, 'prepare')
    }, { retries: 0 })
    // The actual identity COMMIT has resolved before any call to the payload closure.
    await transaction(async tx => {
      const access = await locked(tx, key, 'create'), current = await findArtifact(tx, access, artifactKey)
      if (!prepared || current.state !== 'prepared' || current.version !== owned.artifact.version || current.receipt_json !== JSON.stringify(prepared.receipt)) conflict()
      await boundSource(tx, access, current)
      sameRoot(root)
      const next = await transition(tx, access, current, 'complete', { completed_by_user_id: access.principal.userId })
      continuity(tx, access, next)
      prepared.publishSync()
      next.completed_at_iso = new Date().toISOString()
      await tx.updateTable(table).set({ completed_at_iso: next.completed_at_iso }).where('id', '=', next.id).execute()
      return event(tx, access, next, 'published', body.requestId as string, fingerprint, 'publish')
    }, { retries: 0 })
  }
  catch (error) { if (error instanceof PublicSafetyAccessError) throw error; throw new PublicSafetyAccessError(409, 'Managed dataset publication requires reconciliation') }
  finally { prepared = undefined }
  return transaction(async tx => {
    const access = await requirePublicSafetyManagedAccess(key, 'create', tx), row = await findArtifact(tx, access, artifactKey)
    await boundSource(tx, access, row)
    const result = { artifact: artifactProjection(row, access), event: eventProjection(await latest(tx, row)), replayed: false }
    managedDeadline(access.incident)
    return result
  }, { retries: 0 })
}

export async function listPublicSafetyManagedArtifacts(key: string, options: ManagedListOptions = {}): Promise<ManagedArtifactPage> {
  const descriptors = plainOptions(options, ['afterId', 'limit', 'requestId'])
  const request = descriptors.requestId?.value
  if (request !== undefined) { uuid(request); if (descriptors.afterId || descriptors.limit) throw new PublicSafetyAccessError(422, 'Invalid managed dataset query') }
  const { after, limit } = pagination({ afterSequence: descriptors.afterId?.value, limit: descriptors.limit?.value })
  await authorizePublicSafetyManaged(key, 'read')
  return transaction(async tx => {
    const access = await requirePublicSafetyManagedAccess(key, 'read', tx)
    let query = tx.selectFrom(table).select(artifactListFields).where('incident_id', '=', access.incident.id).where('id', '>', after).orderBy('id', 'asc').limit(request === undefined ? limit + 1 : 1)
    if (request !== undefined) query = query.where('request_id', '=', request)
    const rows = asRows<ArtifactRow>(await query.execute()), entries = rows.slice(0, limit)
    managedDeadline(access.incident)
    return { entries: entries.map(row => artifactProjection(row, access)), cursor: entries.at(-1)?.id ?? after, hasMore: request === undefined && rows.length > limit }
  }, { retries: 0 })
}
function plainOptions(options: unknown, keys: string[]): PropertyDescriptorMap {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length) throw new PublicSafetyAccessError(422, 'Invalid managed dataset query')
  const descriptors = Object.getOwnPropertyDescriptors(options)
  if (Object.entries(descriptors).some(([key, value]) => !keys.includes(key) || !value.enumerable || !('value' in value))) throw new PublicSafetyAccessError(422, 'Invalid managed dataset query')
  return descriptors
}
export async function readPublicSafetyManagedArtifact(key: string, artifactKey: string): Promise<ManagedArtifactRead> {
  uuid(artifactKey); await authorizePublicSafetyManaged(key, 'read')
  return transaction(async tx => {
    const access = await requirePublicSafetyManagedAccess(key, 'read', tx), row = await findArtifact(tx, access, artifactKey)
    await boundSource(tx, access, row)
    const files = (await filesFor(tx, row)).map(fileProjection)
    managedDeadline(access.incident)
    return { artifact: artifactProjection(row, access), files }
  }, { retries: 0 })
}
export async function readPublicSafetyManagedArtifactFile(key: string, artifactKey: string, fileId: number): Promise<ManagedDownload> {
  uuid(artifactKey)
  if (!Number.isSafeInteger(fileId) || fileId < 1) throw new PublicSafetyAccessError(422, 'Invalid managed file identifier')
  await authorizePublicSafetyManaged(key, 'read')
  const staged = await transaction(async tx => {
    const access = await requirePublicSafetyManagedAccess(key, 'read', tx), row = await findArtifact(tx, access, artifactKey)
    if (row.state !== 'complete') unavailable()
    await boundSource(tx, access, row)
    const files = await filesFor(tx, row), selected = files.find(file => file.id === fileId) ?? unavailable()
    return { row, files, selected, receipt: receipt(row) }
  }, { retries: 0 })
  let bytes: Uint8Array, continuityHash: string
  try { bytes = readManagedBytes(staged.receipt, staged.files, staged.selected); continuityHash = managedFingerprint(staged.receipt) }
  catch { return managedUnavailable() }
  return transaction(async tx => {
    const access = await requirePublicSafetyManagedAccess(key, 'read', tx), row = await findArtifact(tx, access, artifactKey)
    await boundSource(tx, access, row)
    if (row.state !== 'complete' || row.version !== staged.row.version || row.receipt_json !== staged.row.receipt_json || managedFingerprint(staged.receipt) !== continuityHash) conflict()
    managedDeadline(access.incident)
    return { bytes, mimeType: staged.selected.mime_type, filename: basename(staged.selected.relative_path), retainUntil: access.incident.retain_until }
  }, { retries: 0 })
}
export async function listPublicSafetyManagedArtifactEvents(key: string, artifactKey: string, options: ManagedEventOptions = {}): Promise<ManagedEventPage> {
  uuid(artifactKey); plainOptions(options, ['afterSequence', 'limit']); const { after, limit } = pagination(options)
  await authorizePublicSafetyManaged(key, 'events')
  return transaction(async tx => {
    const access = await requirePublicSafetyManagedAccess(key, 'events', tx), row = await findArtifact(tx, access, artifactKey)
    const rows = asRows<EventRow>(await tx.selectFrom(eventTable).selectAll().where('artifact_id', '=', row.id).where('sequence', '>', after).orderBy('sequence', 'asc').limit(limit + 1).execute()), entries = rows.slice(0, limit)
    managedDeadline(access.incident)
    return { entries: entries.map(eventProjection), cursor: entries.at(-1)?.sequence ?? after, hasMore: rows.length > limit }
  }, { retries: 0 })
}
export async function reconcilePublicSafetyManagedArtifact(key: string, artifactKey: string, input: unknown): Promise<ManagedReceipt> {
  uuid(artifactKey)
  const body = plain(input, ['expectedVersion', 'expectedArtifactVersion', 'requestId']), expected = expectedVersion(body.expectedVersion), expectedArtifact = expectedVersion(body.expectedArtifactVersion)
  uuid(body.requestId)
  await authorizePublicSafetyManaged(key, 'reconcile')
  const claim = await transaction(async tx => {
    const access = await locked(tx, key, 'reconcile'), row = await findArtifact(tx, access, artifactKey)
    await boundSource(tx, access, row)
    const fingerprint = sha256(JSON.stringify(['reconcile', access.principal.userId, artifactKey, body]))
    const previous = asRows<EventRow>(await tx.selectFrom(eventTable).selectAll().where('artifact_id', '=', row.id).where('request_id', '=', body.requestId).orderBy('sequence', 'asc').execute())
    if (previous.length) {
      if (previous.some(item => item.request_digest !== fingerprint || item.actor_user_id !== access.principal.userId || item.step !== 'claim' && item.step !== 'result')) conflict()
      return { existing: { artifact: artifactProjection(row, access), event: eventProjection(previous.at(-1)!), replayed: true } }
    }
    if (access.incident.version !== expected || row.version !== expectedArtifact) conflict()
    const next = await transition(tx, access, row, 'inspecting')
    const result = await event(tx, access, next, 'reconcile-claimed', body.requestId as string, fingerprint, 'claim')
    return { row: next, files: await filesFor(tx, row), fingerprint, result }
  }, { retries: 0 })
  if (claim.existing) return claim.existing
  const row = claim.row!, files = claim.files!
  let inspection, continuityHash: string | undefined
  try {
    const ownership = row.receipt_json ? receipt(row) : null
    inspection = inspectManagedArtifact(ownership, row.target_path, files)
    if (ownership && inspection.state !== 'blocked') continuityHash = managedFingerprint(ownership)
  }
  catch { inspection = { state: 'blocked' as const, observed: [] } }
  return transaction(async tx => {
    const access = await locked(tx, key, 'reconcile'), current = await findArtifact(tx, access, artifactKey)
    await boundSource(tx, access, current)
    if (current.version !== row.version || current.generation !== row.generation || current.state !== 'inspecting' || current.receipt_json !== row.receipt_json) conflict()
    const outcome: ManagedOutcome = inspection.state === 'complete' ? null : inspection.state === 'blocked' ? 'ownership-uncertain' : 'interrupted'
    const next = await transition(tx, access, current, inspection.state, { outcome_code: outcome, ...(inspection.state === 'complete' ? { completed_at_iso: new Date().toISOString(), completed_by_user_id: access.principal.userId } : { interrupted_at_iso: new Date().toISOString() }) })
    continuity(tx, access, next)
    if (continuityHash && managedFingerprint(receipt(current)) !== continuityHash) conflict()
    for (const observed of inspection.observed) await tx.updateTable(fileTable).set({ observed_bytes: observed.bytes, observed_sha256: observed.sha256 }).where('id', '=', observed.id).where('artifact_id', '=', current.id).execute()
    const result = await event(tx, access, next, inspection.state === 'complete' ? 'reconciled-complete' : inspection.state, body.requestId as string, claim.fingerprint!, 'result')
    managedDeadline(access.incident)
    return result
  }, { retries: 0 })
}
