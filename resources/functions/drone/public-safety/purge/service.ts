import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import type { PurgePreview, PurgeReceipt, PurgeStatus, PurgeEventPage, PurgeEventOptions } from './types'
import type { PurgeRow, PurgeScopeRow, PurgeEventRow } from './internal'
import { randomUUID } from 'node:crypto'
import { asRow, asRows, lockRow, mutationCount } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { associateIncidentDeadline, checkedIncidentResult } from '../access/deadline'
import { PublicSafetyAccessError } from '../access/errors'
import { advance, expectedVersion, maximumVersion } from '../access/mutations'
import { sha256 } from '../managed/files'
import { authorizePublicSafetyPurge, requirePublicSafetyPurgeAccess, requirePurgeEnabled, purgeEnabled } from './policy'
import { purgeCoverage, purgePolicy, purgeExclusions, zeroPurgeProgress } from './types'
import { purgeConflict, purgeUnavailable, purgeUuid, purgePlain, purgeStatus, purgeEventProjection, appendPurgeEvent, transitionPurge, findPurge, purgeTables, purgeReceiptDeadline, purgeDeadline, tagPurgeReceipt } from './internal'
import { purgeInventory, purgeInventoryHeader } from './inventory'
export { PublicSafetyAccessError } from '../access/errors'
async function scope(tx: Pick<TransactionHandle, 'selectFrom'>, incidentId: number): Promise<PurgeScopeRow> { return asRow<PurgeScopeRow>(await tx.selectFrom('public_safety_retention_scopes').selectAll().where('incident_id', '=', incidentId).executeTakeFirst()) ?? purgeUnavailable() }
async function locked(tx: TransactionHandle, key: string, ability: 'accept' | 'retry') {
  const incident = asRow<IncidentRow>(await lockRow(tx, 'public_safety_incidents', { incident_key: key })) ?? purgeUnavailable()
  const access = await requirePublicSafetyPurgeAccess(key, ability, tx, incident)
  const retained = asRow<PurgeScopeRow>(await lockRow(tx, 'public_safety_retention_scopes', { incident_id: incident.id })) ?? purgeUnavailable()
  return { ...access, scope: retained }
}
export async function previewPublicSafetyPurge(key: string): Promise<PurgePreview> {
  await authorizePublicSafetyPurge(key, 'preview')
  return checkedIncidentResult(transaction(async tx => {
    const access = await requirePublicSafetyPurgeAccess(key, 'preview', tx), retained = await scope(tx, access.incident.id)
    const existing = asRow<PurgeRow>(await tx.selectFrom(purgeTables.purge).selectAll().where('incident_id', '=', access.incident.id).executeTakeFirst())
    if (existing) purgeReceiptDeadline(existing)
    const current = existing ? { digest: existing.frozen_inventory_digest, counts: JSON.parse(existing.frozen_counts_json) } : await purgeInventory(tx, access.incident.id, purgeInventoryHeader(access.incident, retained))
    const expired = Date.parse(access.incident.retain_until) <= Date.now()
    const reason = existing ? 'already-accepted' : !purgeEnabled() ? 'executor-disabled' : !expired ? 'not-due' : retained.hold_state === 'held' || retained.hold_state === 'pending-review' ? 'held' : 'eligible'
    return associateIncidentDeadline({ key, incidentVersion: access.incident.version, retentionVersion: retained.version, eligibleAt: access.incident.retain_until, expired, executorEnabled: purgeEnabled(), holdState: retained.hold_state, eligibility: reason === 'eligible' ? 'eligible' : 'ineligible', reason, inventoryDigest: current.digest, counts: current.counts, existingPurgeKey: existing?.purge_key ?? null, inventoryKind: existing ? 'accepted-frozen' : 'current-preview', coverage: purgeCoverage, exclusions: purgeExclusions, limits: { diagnosticsErased: false, allCopiesErased: false, mediaErasure: false }, receiptRetentionDays: { min: 1, max: 365 } }, existing ? purgeDeadline(existing) : undefined)
  }, { retries: 0 }))
}
export async function acceptPublicSafetyPurge(key: string, input: unknown): Promise<PurgeReceipt> {
  const body = purgePlain(input, ['expectedVersion', 'expectedRetentionVersion', 'policyVersion', 'coverage', 'inventoryDigest', 'exclusions', 'receiptRetentionDays', 'requestId'])
  const expected = expectedVersion(body.expectedVersion), expectedRetention = expectedVersion(body.expectedRetentionVersion)
  purgeUuid(body.requestId)
  const exclusions = purgePlain(body.exclusions, Object.keys(purgeExclusions))
  if (body.policyVersion !== purgePolicy || body.coverage !== purgeCoverage || Object.values(exclusions).some(value => value !== true) || typeof body.inventoryDigest !== 'string' || body.inventoryDigest.length !== 64 || !/^[a-f0-9]{64}$/.test(body.inventoryDigest) || !Number.isSafeInteger(body.receiptRetentionDays) || (body.receiptRetentionDays as number) < 1 || (body.receiptRetentionDays as number) > 365) throw new PublicSafetyAccessError(422, 'Invalid purge acceptance')
  await authorizePublicSafetyPurge(key, 'accept')
  return checkedIncidentResult(transaction(async tx => {
    const access = await locked(tx, key, 'accept'), fingerprint = sha256(JSON.stringify(['accept', key, access.principal.userId, expected, expectedRetention, purgePolicy, purgeCoverage, body.inventoryDigest, Object.keys(purgeExclusions).map(name => exclusions[name]), body.receiptRetentionDays, body.requestId]))
    const existing = asRow<PurgeRow>(await tx.selectFrom(purgeTables.purge).selectAll().where('incident_id', '=', access.incident.id).executeTakeFirst())
    if (existing) {
      if (existing.request_id !== body.requestId || existing.request_digest !== fingerprint || existing.accepted_by_user_id !== access.principal.userId) purgeConflict()
      const original = asRow<PurgeEventRow>(await tx.selectFrom(purgeTables.event).selectAll().where('purge_id', '=', existing.id).where('step', '=', 'accept').executeTakeFirst()) ?? purgeUnavailable()
      return tagPurgeReceipt({ purge: purgeStatus(existing, access.incident, access.scope), event: purgeEventProjection(original), replayed: true })
    }
    requirePurgeEnabled()
    if (access.scope.freeze_state !== 'retained' || access.scope.hold_state !== 'none' && access.scope.hold_state !== 'released' || Date.parse(access.incident.retain_until) > Date.now() || access.incident.version !== expected || access.scope.version !== expectedRetention || access.scope.version >= maximumVersion) purgeConflict()
    const header = purgeInventoryHeader(access.incident, access.scope), inventory = await purgeInventory(tx, access.incident.id, header)
    if (inventory.digest !== body.inventoryDigest) purgeConflict()
    requirePurgeEnabled()
    access.incident = await advance(tx, access.incident)
    requirePurgeEnabled()
    const changed = await tx.updateTable('public_safety_retention_scopes').set({ freeze_state: 'frozen', version: access.scope.version + 1, updated_at: new Date().toISOString() }).where('id', '=', access.scope.id).where('version', '=', access.scope.version).where('freeze_state', '=', 'retained').executeTakeFirst()
    if (mutationCount(changed) !== 1) purgeConflict()
    access.scope = { ...access.scope, version: access.scope.version + 1, freeze_state: 'frozen' }
    const at = new Date().toISOString(), purgeKey = randomUUID(), progress = zeroPurgeProgress()
    await tx.insertInto(purgeTables.purge).values({ incident_id: access.incident.id, retention_scope_id: access.scope.id, purge_key: purgeKey, policy_version: purgePolicy, coverage: purgeCoverage, request_id: body.requestId, request_digest: fingerprint, accepted_by_user_id: access.principal.userId, accepted_at_iso: at, accepted_incident_version: expected, accepted_retention_version: expectedRetention, frozen_inventory_digest: inventory.digest, frozen_counts_json: JSON.stringify(inventory.counts), frozen_header_json: JSON.stringify(header), receipt_retention_days: body.receiptRetentionDays, completed_at_iso: null, receipt_retain_until_iso: null, version: 1, generation: 1, operation_nonce: randomUUID(), state: 'building', fs_state: 'pending', db_state: 'pending', build_cursor_json: JSON.stringify({ group: 0, after: 0, ordinal: 0, digest: sha256(`${JSON.stringify(header)}\n`) }), db_cursor_json: '{}', minimize_cursor_json: '{}', build_digest: null, materialized_counts_json: JSON.stringify({ ...inventory.counts, ...Object.fromEntries(Object.keys(inventory.counts).map(name => [name, name === 'incidentPayloads' ? 1 : 0])) }), progress_counts_json: JSON.stringify(progress), sealed_totals_json: '{}', outcome_code: null, blocked_at_iso: null, review_due_at_iso: null, next_eligible_at_iso: at, created_at: at, updated_at: at }).execute()
    const row = await findPurge(tx, access.incident.id, purgeKey)
    return tagPurgeReceipt({ purge: purgeStatus(row, access.incident, access.scope), event: await appendPurgeEvent(tx, row, access.incident, access.scope, { kind: 'human', userId: access.principal.userId }, 'accept', progress, body.requestId as string, fingerprint), replayed: false })
  }, { retries: 0 }))
}
export async function readPublicSafetyPurge(key: string, purgeKey: string): Promise<PurgeStatus> {
  purgeUuid(purgeKey); await authorizePublicSafetyPurge(key, 'read')
  return checkedIncidentResult(transaction(async tx => {
    const access = await requirePublicSafetyPurgeAccess(key, 'read', tx)
    return purgeStatus(await findPurge(tx, access.incident.id, purgeKey), access.incident, await scope(tx, access.incident.id))
  }, { retries: 0 }))
}
export async function listPublicSafetyPurgeEvents(key: string, purgeKey: string, options: PurgeEventOptions = {}): Promise<PurgeEventPage> {
  purgeUuid(purgeKey)
  const body = purgePlain(options, ['after', 'limit'], true), after = body.after ?? 0, limit = body.limit ?? 100
  if (!Number.isSafeInteger(after) || (after as number) < 0 || (after as number) > maximumVersion || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new PublicSafetyAccessError(422, 'Invalid purge event query')
  await authorizePublicSafetyPurge(key, 'events')
  return checkedIncidentResult(transaction(async tx => {
    const access = await requirePublicSafetyPurgeAccess(key, 'events', tx), row = await findPurge(tx, access.incident.id, purgeKey)
    purgeReceiptDeadline(row)
    const rows = asRows<PurgeEventRow>(await tx.selectFrom(purgeTables.event).selectAll().where('purge_id', '=', row.id).where('sequence', '>', after).orderBy('sequence', 'asc').limit((limit as number) + 1).execute()), entries = rows.slice(0, limit as number).map(purgeEventProjection)
    purgeReceiptDeadline(row)
    return associateIncidentDeadline({ entries, cursor: entries.at(-1)?.sequence ?? after as number, hasMore: rows.length > (limit as number) }, purgeDeadline(row))
  }, { retries: 0 }))
}
export async function retryPublicSafetyPurge(key: string, purgeKey: string, input: unknown): Promise<PurgeReceipt> {
  purgeUuid(purgeKey)
  const body = purgePlain(input, ['expectedPurgeVersion', 'expectedRetentionVersion', 'requestId']), expected = expectedVersion(body.expectedPurgeVersion), expectedRetention = expectedVersion(body.expectedRetentionVersion)
  purgeUuid(body.requestId); await authorizePublicSafetyPurge(key, 'retry')
  return checkedIncidentResult(transaction(async tx => {
    const access = await locked(tx, key, 'retry'), row = await findPurge(tx, access.incident.id, purgeKey), fingerprint = sha256(JSON.stringify(['retry', key, purgeKey, access.principal.userId, expected, expectedRetention, body.requestId]))
    purgeReceiptDeadline(row)
    const existing = asRow<PurgeEventRow>(await tx.selectFrom(purgeTables.event).selectAll().where('purge_id', '=', row.id).where('operation_id', '=', body.requestId).where('step', '=', 'retry').executeTakeFirst())
    if (existing) {
      if (existing.actor_user_id !== access.principal.userId || existing.request_digest !== fingerprint) purgeConflict()
      return tagPurgeReceipt({ purge: purgeStatus(row, access.incident, access.scope), event: purgeEventProjection(existing), replayed: true })
    }
    requirePurgeEnabled()
    if (row.state === 'complete' || row.version !== expected || access.scope.version !== expectedRetention || access.scope.version >= maximumVersion) purgeConflict()
    const updated = await tx.updateTable('public_safety_retention_scopes').set({ version: access.scope.version + 1 }).where('id', '=', access.scope.id).where('version', '=', access.scope.version).executeTakeFirst()
    if (mutationCount(updated) !== 1) purgeConflict()
    access.scope = { ...access.scope, version: access.scope.version + 1 }
    const next = await transitionPurge(tx, row, access.incident, { next_eligible_at_iso: new Date().toISOString(), ...(row.db_state === 'blocked' ? { db_state: 'pending' } : {}), ...(row.fs_state === 'blocked' ? { fs_state: 'pending' } : {}) })
    return tagPurgeReceipt({ purge: purgeStatus(next.row, next.incident, access.scope), event: await appendPurgeEvent(tx, next.row, next.incident, access.scope, { kind: 'human', userId: access.principal.userId }, 'retry', zeroPurgeProgress(), body.requestId as string, fingerprint), replayed: false })
  }, { retries: 0 }))
}
