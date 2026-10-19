import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import type { RetentionAbility, OriginalHold, RetentionHoldState, RetentionPreview, RetentionScopeProjection, RetentionEventProjection, RetentionReceipt, RetentionEventOptions, RetentionEventPage, RetentionAction, PurgedCustodyProjection } from './types'
import type { PurgeReceipt } from '../purge/types'
import type { PurgeRow, PurgeScopeRow, PurgeEventRow } from '../purge/internal'
import { purgeStatus, purgeEventProjection, appendPurgeEvent, transitionPurge, purgeReceiptDeadline } from '../purge/internal'
import { zeroPurgeProgress } from '../purge/types'
import { createHash } from 'node:crypto'
import { asRow, asRows, lockRow, mutationCount } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { PublicSafetyAccessError } from '../access/errors'
import { exactRecord, expectedVersion, advance, maximumVersion, pagination } from '../access/mutations'
import { assertIncidentPayload } from '../access/policy'
import { publicSafetyRecordingData } from '../evidence'
import { authorizePublicSafetyRetention, requirePublicSafetyRetentionAccess } from './policy'
export { PublicSafetyAccessError } from '../access/errors'

interface ScopeRow {
  id: number, incident_id: number, version: number, policy_version: 'local-managed-v1', inventory_digest: string | null, freeze_state: 'retained' | 'frozen' | 'purged',
  original_hold: OriginalHold, hold_state: RetentionHoldState, case_reference: string | null, review_due_at: string | null,
  reviewer_user_id: number | null, reviewed_at_iso: string | null, enrolled_by_user_id: number, enrolled_at_iso: string,
}
interface EventRow {
  id: number, scope_id: number, sequence: number, incident_version: number, action: RetentionAction,
  request_id: string, request_digest: string, actor_user_id: number, at_iso: string,
  decision: 'retain' | 'release' | null, case_reference: string | null, review_due_at: string | null, target_user_id: number | null,
}
type Access = Awaited<ReturnType<typeof requirePublicSafetyRetentionAccess>>
type Reader = Pick<TransactionHandle, 'selectFrom'>
const flags = { purgeImplemented: false, contentDeletionPerformed: false, legacyOfflineExportsManaged: false } as const
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
function unavailable(): never { throw new PublicSafetyAccessError(404, 'Incident custody is not enrolled') }
function conflict(): never { throw new PublicSafetyAccessError(409, 'Incident custody has changed') }
function requestId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid custody request identifier')
}
function scopeProjection(scope: ScopeRow, access: Access): RetentionScopeProjection {
  if (scope.original_hold !== access.originalHold || scope.policy_version !== 'local-managed-v1') conflict()
  return {
    key: access.incident.incident_key, policyVersion: scope.policy_version, version: scope.version, incidentVersion: access.incident.version,
    retainUntil: access.incident.retain_until, expired: Date.parse(access.incident.retain_until) <= Date.now(), originalHold: scope.original_hold,
    holdState: scope.hold_state, reviewRequired: scope.hold_state === 'pending-review',
    reviewOverdue: (scope.hold_state === 'held' || scope.hold_state === 'pending-review') && scope.review_due_at !== null && Date.parse(scope.review_due_at) <= Date.now(),
    caseReference: scope.case_reference, reviewDueAt: scope.review_due_at, reviewerUserId: scope.reviewer_user_id, reviewedAt: scope.reviewed_at_iso,
    enrolledByUserId: scope.enrolled_by_user_id, enrolledAt: scope.enrolled_at_iso,
    capabilities: { canManageHold: access.principal.canCoordinate, canRevokeMembers: access.principal.canCoordinate && access.member.role === 'coordinator' && access.member.user_id === access.incident.coordinator_id }, ...flags,
  }
}
function eventProjection(row: EventRow): RetentionEventProjection {
  return { id: row.id, sequence: row.sequence, incidentVersion: row.incident_version, action: row.action, requestId: row.request_id, actorUserId: row.actor_user_id, at: row.at_iso, decision: row.decision, caseReference: row.case_reference, reviewDueAt: row.review_due_at, targetUserId: row.target_user_id }
}
async function scopeRow(tx: Reader, incidentId: number): Promise<ScopeRow> {
  return asRow<ScopeRow>(await tx.selectFrom('public_safety_retention_scopes').selectAll().where('incident_id', '=', incidentId).executeTakeFirst()) ?? unavailable()
}
async function lockedAccess(tx: TransactionHandle, key: string, ability: RetentionAbility): Promise<Access> {
  const row = asRow<IncidentRow>(await lockRow(tx, 'public_safety_incidents', { incident_key: key }))
  if (!row) throw new PublicSafetyAccessError(404, 'Incident custody is unavailable')
  return requirePublicSafetyRetentionAccess(key, ability, tx, row)
}
async function lockedScope(tx: TransactionHandle, incidentId: number): Promise<ScopeRow> {
  return asRow<ScopeRow>(await lockRow(tx, 'public_safety_retention_scopes', { incident_id: incidentId })) ?? unavailable()
}
async function replay(tx: Reader, scope: ScopeRow, access: Access, id: string, fingerprint: string): Promise<RetentionReceipt | undefined> {
  const event = asRow<EventRow>(await tx.selectFrom('public_safety_retention_events').selectAll().where('scope_id', '=', scope.id).where('request_id', '=', id).executeTakeFirst())
  if (!event) return
  if (event.request_digest !== fingerprint) conflict()
  return { scope: scopeProjection(scope, access), event: eventProjection(event), replayed: true }
}
async function appendEvent(tx: TransactionHandle, scope: ScopeRow, access: Access, body: { action: RetentionAction, requestId: string, fingerprint: string, decision?: 'retain' | 'release', caseReference?: string, reviewDueAt?: string | null, targetUserId?: number }): Promise<RetentionReceipt> {
  const at = new Date().toISOString()
  await tx.insertInto('public_safety_retention_events').values({ scope_id: scope.id, sequence: scope.version, incident_version: access.incident.version, action: body.action, request_id: body.requestId, request_digest: body.fingerprint, actor_user_id: access.principal.userId, at_iso: at, decision: body.decision ?? null, case_reference: body.caseReference ?? null, review_due_at: body.reviewDueAt ?? null, target_user_id: body.targetUserId ?? null, created_at: at, updated_at: at }).execute()
  const event = asRow<EventRow>(await tx.selectFrom('public_safety_retention_events').selectAll().where('scope_id', '=', scope.id).where('sequence', '=', scope.version).executeTakeFirst())!
  return { scope: scopeProjection(scope, access), event: eventProjection(event), replayed: false }
}
async function nextScope(tx: TransactionHandle, scope: ScopeRow, changes: Partial<ScopeRow> = {}): Promise<ScopeRow> {
  if (scope.version >= maximumVersion) conflict()
  const next = { ...scope, ...changes, version: scope.version + 1 }
  const result = await tx.updateTable('public_safety_retention_scopes').set({ ...changes, version: next.version, updated_at: new Date().toISOString() }).where('id', '=', scope.id).where('version', '=', scope.version).executeTakeFirst()
  if (mutationCount(result) !== 1) conflict()
  return next
}

/** Metadata pages only: never select canonical source planes or private declaration text. */
async function inventory(tx: Reader, access: Access): Promise<Pick<RetentionPreview, 'inventoryDigest' | 'counts' | 'managedArtifactCount'>> {
  assertIncidentPayload(access.incident)
  if (access.lifecycle !== 'retained') conflict()
  const digest = createHash('sha256'), counts = { sources: 0, observations: 0, reviews: 0 }
  digest.update(publicSafetyRecordingData({ key: access.incident.incident_key, version: access.incident.version, retainUntil: access.incident.retain_until, originalHold: access.originalHold, config: JSON.parse(access.incident.config_json) }))
  const fields = {
    sources: ['id', 'digest', 'byte_length', 'replay_profile', 'evidence', 'uploader_id', 'uploaded_at_iso', 'created_sequence'],
    observations: ['id', 'source_id', 'capture_id', 'modality', 'pixel_x', 'pixel_y', 'actor_id', 'observed_at_iso', 'created_sequence'],
    reviews: ['id', 'observation_id', 'previous_review_id', 'disposition', 'actor_id', 'reviewed_at_iso', 'created_sequence'],
  }
  for (const table of ['sources', 'observations', 'reviews'] as const) {
    let after = 0
    for (;;) {
      const owned = table === 'sources'
        ? tx.selectFrom('public_safety_sources').where('public_safety_sources.incident_id', '=', access.incident.id)
        : table === 'observations'
          ? tx.selectFrom('public_safety_observations').innerJoin('public_safety_sources', 'public_safety_sources.id', '=', 'public_safety_observations.source_id').where('public_safety_sources.incident_id', '=', access.incident.id)
          : tx.selectFrom('public_safety_reviews').innerJoin('public_safety_observations', 'public_safety_observations.id', '=', 'public_safety_reviews.observation_id').innerJoin('public_safety_sources', 'public_safety_sources.id', '=', 'public_safety_observations.source_id').where('public_safety_sources.incident_id', '=', access.incident.id)
      const rows = asRows<Record<string, string | number | null>>(await owned.select(fields[table].map(field => `public_safety_${table}.${field}`)).where(`public_safety_${table}.id`, '>', after).orderBy(`public_safety_${table}.id`, 'asc').limit(100).execute())
      for (const row of rows) digest.update(`${JSON.stringify([table, ...fields[table].map(field => row[field])])}\n`)
      counts[table] += rows.length
      if (rows.length < 100) break
      after = rows.at(-1)!.id as number
    }
  }
  let managedArtifactCount = 0
  for (const kind of ['artifacts', 'files'] as const) {
    let after = 0
    const columns = kind === 'artifacts'
      ? ['id', 'artifact_key', 'source_id', 'source_digest', 'version', 'generation', 'state', 'plan_digest', 'file_count', 'total_planned_bytes', 'manifest_sha256', 'prepared_at_iso', 'completed_at_iso']
      : ['id', 'artifact_id', 'ordinal', 'relative_path', 'planned_bytes', 'sha256', 'identity_json', 'observed_bytes', 'observed_sha256']
    const table = kind === 'artifacts' ? 'public_safety_managed_artifacts' : 'public_safety_managed_artifact_files'
    for (;;) {
      const owned = kind === 'artifacts'
        ? tx.selectFrom(table).where('public_safety_managed_artifacts.incident_id', '=', access.incident.id)
        : tx.selectFrom(table).innerJoin('public_safety_managed_artifacts', 'public_safety_managed_artifacts.id', '=', 'public_safety_managed_artifact_files.artifact_id').where('public_safety_managed_artifacts.incident_id', '=', access.incident.id)
      const rows = asRows<Record<string, string | number | null>>(await owned.select(columns.map(field => `${table}.${field}`)).where(`${table}.id`, '>', after).orderBy(`${table}.id`, 'asc').limit(100).execute())
      for (const row of rows) digest.update(`${JSON.stringify([kind, ...columns.map(field => row[field])])}\n`)
      if (kind === 'artifacts') managedArtifactCount += rows.length
      if (rows.length < 100) break
      after = rows.at(-1)!.id as number
    }
  }
  return { inventoryDigest: digest.digest('hex'), counts, managedArtifactCount }
}
export async function previewPublicSafetyRetention(key: string): Promise<RetentionPreview> {
  await authorizePublicSafetyRetention(key, 'read')
  return transaction(async tx => {
    const access = await requirePublicSafetyRetentionAccess(key, 'read', tx)
    return { key, incidentVersion: access.incident.version, retainUntil: access.incident.retain_until, expired: Date.parse(access.incident.retain_until) <= Date.now(), originalHold: access.originalHold, ...await inventory(tx, access), ...flags }
  })
}
export async function enrollPublicSafetyRetention(key: string, input: unknown): Promise<RetentionReceipt> {
  const body = exactRecord(input, ['expectedVersion', 'policyVersion', 'inventoryDigest', 'requestId']), expected = expectedVersion(body.expectedVersion)
  requestId(body.requestId)
  if (body.policyVersion !== 'local-managed-v1' || typeof body.inventoryDigest !== 'string' || body.inventoryDigest.length !== 64 || !/^[a-f0-9]{64}$/.test(body.inventoryDigest)) throw new PublicSafetyAccessError(422, 'Invalid custody enrollment')
  const fingerprint = hash(JSON.stringify(['enroll', body]))
  await authorizePublicSafetyRetention(key, 'manage')
  return transaction(async tx => {
    const access = await lockedAccess(tx, key, 'manage')
    const existing = asRow<ScopeRow>(await lockRow(tx, 'public_safety_retention_scopes', { incident_id: access.incident.id }))
    if (existing) return await replay(tx, existing, access, body.requestId as string, fingerprint) ?? conflict()
    if (access.incident.version !== expected || (await inventory(tx, access)).inventoryDigest !== body.inventoryDigest) conflict()
    access.incident = await advance(tx, access.incident)
    const at = new Date().toISOString()
    await tx.insertInto('public_safety_retention_scopes').values({ incident_id: access.incident.id, version: 1, policy_version: 'local-managed-v1', inventory_digest: body.inventoryDigest, original_hold: access.originalHold, hold_state: access.originalHold === 'none' ? 'none' : 'pending-review', case_reference: null, review_due_at: null, reviewer_user_id: null, reviewed_at_iso: null, enrolled_by_user_id: access.principal.userId, enrolled_at_iso: at, created_at: at, updated_at: at }).execute()
    return appendEvent(tx, await scopeRow(tx, access.incident.id), access, { action: 'enrolled', requestId: body.requestId as string, fingerprint })
  })
}
export async function readPublicSafetyRetention(key: string): Promise<RetentionScopeProjection | PurgedCustodyProjection> {
  await authorizePublicSafetyRetention(key, 'read')
  return transaction(async tx => {
    const access = await requirePublicSafetyRetentionAccess(key, 'read', tx)
    const scope = await scopeRow(tx, access.incident.id)
    if (scope.freeze_state !== 'retained') return completedCustody(tx, scope, access)
    return scopeProjection(scope, access)
  })
}
export async function reviewPublicSafetyRetentionHold(key: string, input: unknown): Promise<RetentionReceipt> {
  const body = exactRecord(input, ['expectedRetentionVersion', 'decision', 'caseReference', 'reviewDueAt', 'requestId']), expected = expectedVersion(body.expectedRetentionVersion)
  requestId(body.requestId)
  if (body.decision !== 'retain' && body.decision !== 'release' || typeof body.caseReference !== 'string' || body.caseReference.length < 1 || body.caseReference.length > 128 || body.caseReference.match(/^[A-Za-z0-9._:-]+$/)?.[0] !== body.caseReference) throw new PublicSafetyAccessError(422, 'Invalid custody hold declaration')
  if (body.decision === 'release' ? body.reviewDueAt !== null : typeof body.reviewDueAt !== 'string' || body.reviewDueAt.length !== 24 || !Number.isFinite(Date.parse(body.reviewDueAt)) || new Date(body.reviewDueAt).toISOString() !== body.reviewDueAt) throw new PublicSafetyAccessError(422, 'Invalid custody review deadline')
  const decision = body.decision, caseReference = body.caseReference, reviewDueAt = body.reviewDueAt as string | null, fingerprint = hash(JSON.stringify(['hold', body]))
  await authorizePublicSafetyRetention(key, 'manage')
  return transaction(async tx => {
    const access = await lockedAccess(tx, key, 'manage'), scope = await lockedScope(tx, access.incident.id)
    if (scope.freeze_state !== 'retained') conflict()
    const existing = await replay(tx, scope, access, body.requestId as string, fingerprint)
    if (existing) return existing
    if (scope.version !== expected) conflict()
    const now = Date.now()
    if (reviewDueAt !== null && (Date.parse(reviewDueAt) <= now || Date.parse(reviewDueAt) - now > 30 * 86400000)) throw new PublicSafetyAccessError(422, 'Invalid custody review deadline')
    const next = await nextScope(tx, scope, { hold_state: decision === 'retain' ? 'held' : 'released', case_reference: caseReference, review_due_at: reviewDueAt, reviewer_user_id: access.principal.userId, reviewed_at_iso: new Date(now).toISOString() })
    access.incident = await advance(tx, access.incident)
    return appendEvent(tx, next, access, { action: 'hold-reviewed', requestId: body.requestId as string, fingerprint, decision, caseReference, reviewDueAt })
  })
}
export async function listPublicSafetyRetentionEvents(key: string, options: RetentionEventOptions = {}): Promise<RetentionEventPage & { historyRetired?: true }> {
  const { after, limit } = pagination(options)
  await authorizePublicSafetyRetention(key, 'read')
  return transaction(async tx => {
    const access = await requirePublicSafetyRetentionAccess(key, 'read', tx), scope = await scopeRow(tx, access.incident.id)
    if (scope.freeze_state !== 'retained') { await completedCustody(tx, scope, access); return { entries: [], cursor: scope.version, hasMore: false, historyRetired: true } }
    const rows = asRows<EventRow>(await tx.selectFrom('public_safety_retention_events').selectAll().where('scope_id', '=', scope.id).where('sequence', '>', after).orderBy('sequence', 'asc').limit(limit + 1).execute())
    const entries = rows.slice(0, limit).map(eventProjection)
    return { entries, cursor: entries.at(-1)?.sequence ?? after, hasMore: rows.length > limit }
  })
}
export async function revokePublicSafetyCustodyMember(key: string, input: unknown): Promise<RetentionReceipt | PurgeReceipt> {
  const body = exactRecord(input, ['expectedRetentionVersion', 'userId', 'requestId']), expected = expectedVersion(body.expectedRetentionVersion)
  requestId(body.requestId)
  if (!Number.isSafeInteger(body.userId) || (body.userId as number) < 1) throw new PublicSafetyAccessError(422, 'Invalid custody membership')
  const userId = body.userId as number, fingerprint = hash(JSON.stringify(['revoke', body]))
  await authorizePublicSafetyRetention(key, 'revoke')
  return transaction(async tx => {
    const access = await lockedAccess(tx, key, 'revoke'), scope = await lockedScope(tx, access.incident.id)
    if (scope.freeze_state !== 'retained') return revokeFrozen(tx, scope, access, body, expected, userId)
    const existing = await replay(tx, scope, access, body.requestId as string, fingerprint)
    if (existing) return existing
    if (scope.version !== expected || userId === access.incident.coordinator_id || userId === access.principal.userId) conflict()
    const member = asRow<{ id: number, role: string, active: boolean | number, version: number }>(await tx.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', access.incident.id).where('user_id', '=', userId).executeTakeFirst())
    if (!member || member.active !== true && member.active !== 1 || member.role === 'coordinator' || member.version >= maximumVersion) conflict()
    await tx.updateTable('public_safety_incident_members').set({ active: false, version: member.version + 1, revoked_by: access.principal.userId, updated_at: new Date().toISOString() }).where('id', '=', member.id).execute()
    const next = await nextScope(tx, scope)
    access.incident = await advance(tx, access.incident)
    return appendEvent(tx, next, access, { action: 'member-revoked', requestId: body.requestId as string, fingerprint, targetUserId: userId })
  })
}

async function completedCustody(tx: Reader, scope: ScopeRow, access: Access): Promise<PurgedCustodyProjection> {
  const row = asRow<PurgeRow>(await tx.selectFrom('public_safety_purges').selectAll().where('retention_scope_id', '=', scope.id).executeTakeFirst())
  if (!row || row.state !== 'complete') throw new PublicSafetyAccessError(409, 'Use the accepted purge status while custody history is retiring')
  purgeReceiptDeadline(row)
  return { key: access.incident.incident_key, policyVersion: 'local-managed-v1', version: scope.version, incidentVersion: access.incident.version, retainUntil: access.incident.retain_until, expired: true, purged: true, purgeKey: row.purge_key, historyRetired: true, capabilities: { canRevokeMembers: access.member.role === 'coordinator' && access.member.user_id === access.incident.coordinator_id && access.principal.canCoordinate } }
}
async function revokeFrozen(tx: TransactionHandle, scope: ScopeRow, access: Access, body: Record<string, unknown>, expected: number, userId: number): Promise<PurgeReceipt> {
  const row = asRow<PurgeRow>(await lockRow(tx, 'public_safety_purges', { retention_scope_id: scope.id }))
  if (!row) conflict()
  purgeReceiptDeadline(row)
  const fingerprint = hash(JSON.stringify(['revoke-frozen', access.incident.incident_key, access.principal.userId, expected, userId, body.requestId]))
  const event = asRow<PurgeEventRow>(await tx.selectFrom('public_safety_purge_events').selectAll().where('purge_id', '=', row.id).where('operation_id', '=', body.requestId).where('step', '=', 'member-revoked').executeTakeFirst())
  if (event) {
    if (event.request_digest !== fingerprint || event.actor_user_id !== access.principal.userId) conflict()
    return { purge: purgeStatus(row, access.incident, scope as PurgeScopeRow), event: purgeEventProjection(event), replayed: true }
  }
  if (scope.version !== expected || userId === access.incident.coordinator_id || userId === access.principal.userId) conflict()
  const member = asRow<{ id: number, role: string, active: boolean | number, version: number }>(await tx.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', access.incident.id).where('user_id', '=', userId).executeTakeFirst())
  if (!member || member.active !== true && member.active !== 1 || member.role === 'coordinator' || member.version >= maximumVersion) conflict()
  await tx.updateTable('public_safety_incident_members').set({ active: false, version: member.version + 1, revoked_by: access.principal.userId, updated_at: new Date().toISOString() }).where('id', '=', member.id).execute()
  const nextScopeRow = await nextScope(tx, scope), next = await transitionPurge(tx, row, access.incident)
  return { purge: purgeStatus(next.row, next.incident, nextScopeRow as PurgeScopeRow), event: await appendPurgeEvent(tx, next.row, next.incident, nextScopeRow as PurgeScopeRow, { kind: 'human', userId: access.principal.userId }, 'member-revoked', zeroPurgeProgress(), body.requestId as string, fingerprint), replayed: false }
}
