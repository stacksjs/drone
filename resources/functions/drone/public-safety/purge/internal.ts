import type { DatabaseSchema } from '@stacksjs/database'
import type { PurgeState, PurgeArmState, PurgeOutcome, PurgeCounts, PurgeProgress, PurgeActor, PurgeAction, PurgeEvent, PurgeStatus, PurgeReceipt } from './types'
import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { asRow, mutationCount } from '@stacksjs/database/runtime'
import { associateIncidentDeadline, incidentDeadline } from '../access/deadline'
import { PublicSafetyAccessError } from '../access/errors'
import { advance, maximumVersion } from '../access/mutations'
import { purgeCoverage, purgePolicy, zeroPurgeProgress } from './types'
export interface PurgeRow {
  id: number, incident_id: number, retention_scope_id: number, purge_key: string, request_id: string, request_digest: string,
  accepted_by_user_id: number, accepted_at_iso: string, accepted_incident_version: number, accepted_retention_version: number,
  frozen_inventory_digest: string, frozen_counts_json: string, frozen_header_json: string, receipt_retention_days: number,
  completed_at_iso: string | null, receipt_retain_until_iso: string | null, version: number, generation: number, operation_nonce: string,
  state: PurgeState, fs_state: PurgeArmState, db_state: PurgeArmState, build_cursor_json: string, db_cursor_json: string,
  minimize_cursor_json: string, build_digest: string | null, materialized_counts_json: string, progress_counts_json: string,
  sealed_totals_json: string, outcome_code: PurgeOutcome | null, blocked_at_iso: string | null, review_due_at_iso: string | null, next_eligible_at_iso: string,
}
export interface PurgeScopeRow { id: number, incident_id: number, version: number, freeze_state: 'retained' | 'frozen' | 'purged', hold_state: 'none' | 'pending-review' | 'held' | 'released', original_hold: 'none' | 'declared-review-required' }
export interface PurgeItemRow {
  id: number, purge_id: number, ordinal: number, kind: 'artifact' | 'file' | 'directory' | 'db-row', parent_item_id: number | null,
  artifact_ordinal: number | null, source_table: 'managed-artifact' | 'review' | 'observation' | 'source' | 'audit' | 'noncustody-membership' | 'incident-payload' | null,
  source_row_id: number | null, planned_json: string, identity_json: string | null, alias_json: string | null, planned_bytes: number | null,
  planned_sha256: string | null, version: number, generation: number, operation_nonce: string,
  state: 'planned' | 'armed' | 'verified-absent' | 'row-removed' | 'blocked', arm_json: string | null,
  observed_bytes: number | null, observed_sha256: string | null, result_code: DatabaseSchema['public_safety_purge_items']['result_code'], armed_at_iso: string | null, verified_at_iso: string | null,
}
export interface PurgeEventRow { sequence: number, incident_version: number, retention_version: number, actor_kind: 'human' | 'system', actor_user_id: number | null, system_actor: 'public-safety-local-purge-v1' | null, step: PurgeAction, at_iso: string, counts_json: string, outcome_code: PurgeOutcome | null, request_digest: string | null }
export const systemPurgeActor = { kind: 'system', name: 'public-safety-local-purge-v1' } as const
export const purgeTables = { purge: 'public_safety_purges', item: 'public_safety_purge_items', event: 'public_safety_purge_events' } as const
export function purgeConflict(): never { throw new PublicSafetyAccessError(409, 'Accepted purge state has changed') }
export function purgeUnavailable(): never { throw new PublicSafetyAccessError(404, 'Incident purge is unavailable') }
export function purgeUuid(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid purge identifier') }
export function purgePlain(value: unknown, keys: string[], optional = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new PublicSafetyAccessError(422, 'Invalid purge fields')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if ((!optional && Object.keys(descriptors).length !== keys.length) || Object.entries(descriptors).some(([key, descriptor]) => !keys.includes(key) || !descriptor.enumerable || !('value' in descriptor)) || !optional && keys.some(key => !descriptors[key])) throw new PublicSafetyAccessError(422, 'Invalid purge fields')
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
}
export function addProgress(current: PurgeProgress, delta: PurgeProgress): PurgeProgress {
  const result = { ...current }
  for (const key of Object.keys(current) as (keyof PurgeProgress)[]) { result[key] += delta[key]; if (!Number.isSafeInteger(result[key]) || result[key] < 0) purgeConflict() }
  if (result.namesVerifiedAbsent !== result.namesUnlinked + result.namesInitiallyAbsent + result.namesAbsenceReconciled) purgeConflict()
  return result
}
export function purgeEventProjection(row: PurgeEventRow): PurgeEvent {
  if (row.actor_kind === 'human' ? row.actor_user_id === null || row.system_actor !== null : row.actor_user_id !== null || row.system_actor !== systemPurgeActor.name) purgeConflict()
  return { sequence: row.sequence, incidentVersion: row.incident_version, retentionVersion: row.retention_version, actor: row.actor_kind === 'human' ? { kind: 'human', userId: row.actor_user_id! } : systemPurgeActor, action: row.step, at: row.at_iso, outcome: row.outcome_code, delta: JSON.parse(row.counts_json) }
}
export function purgeDeadline(row: PurgeRow): number | undefined { return row.state === 'complete' || row.completed_at_iso !== null ? Date.parse(row.receipt_retain_until_iso ?? '') : undefined }
export function tagPurgeReceipt(receipt: PurgeReceipt): PurgeReceipt { const deadline = incidentDeadline(receipt.purge); associateIncidentDeadline(receipt.event, deadline); return associateIncidentDeadline(receipt, deadline) }
export function purgeReceiptDeadline(row: PurgeRow): void { if ((row.state === 'complete' || row.completed_at_iso !== null) && (!row.receipt_retain_until_iso || Date.parse(row.receipt_retain_until_iso) <= Date.now())) purgeUnavailable() }
export function purgeStatus(row: PurgeRow, incident: IncidentRow, scope: PurgeScopeRow): PurgeStatus {
  purgeReceiptDeadline(row)
  const completed = JSON.parse(row.progress_counts_json) as PurgeProgress
  return associateIncidentDeadline({ key: incident.incident_key, purgeKey: row.purge_key, policyVersion: purgePolicy, coverage: purgeCoverage, version: row.version, incidentVersion: incident.version, retentionVersion: scope.version, state: row.state, fsState: row.fs_state, dbState: row.db_state, acceptedAt: row.accepted_at_iso, acceptedByUserId: row.accepted_by_user_id, completedAt: row.completed_at_iso, receiptRetentionDays: row.receipt_retention_days, receiptRetainUntil: row.receipt_retain_until_iso, blockedReviewDueAt: row.review_due_at_iso, reviewOverdue: row.state === 'blocked' && row.review_due_at_iso !== null && Date.parse(row.review_due_at_iso) <= Date.now(), inventoryDigest: row.frozen_inventory_digest, planned: JSON.parse(row.frozen_counts_json) as PurgeCounts, completed, outcomeCode: row.outcome_code, contentDeletionPerformed: completed.namesUnlinked > 0 || completed.sourceRowsRemoved + completed.observationRowsRemoved + completed.reviewRowsRemoved + completed.auditRowsRemoved + completed.nonCustodyMembershipRowsRemoved + completed.incidentPayloadRowsCleared > 0, diagnosticsErased: false, allCopiesErased: false, mediaErasure: false }, purgeDeadline(row))
}
export async function appendPurgeEvent(tx: TransactionHandle, row: PurgeRow, incident: IncidentRow, scope: PurgeScopeRow, actor: PurgeActor, step: PurgeAction, delta = zeroPurgeProgress(), operationId: string = randomUUID(), requestDigest: string | null = null): Promise<PurgeEvent> {
  const at = new Date().toISOString()
  await tx.insertInto(purgeTables.event).values({ purge_id: row.id, sequence: row.version, incident_version: incident.version, retention_version: scope.version, operation_id: operationId, step, actor_kind: actor.kind, actor_user_id: actor.kind === 'human' ? actor.userId : null, system_actor: actor.kind === 'system' ? actor.name : null, request_digest: requestDigest, at_iso: at, counts_json: JSON.stringify(delta), outcome_code: row.outcome_code, created_at: at, updated_at: at }).execute()
  return { sequence: row.version, incidentVersion: incident.version, retentionVersion: scope.version, actor, action: step, at, outcome: row.outcome_code, delta }
}
export async function transitionPurge(tx: TransactionHandle, row: PurgeRow, incident: IncidentRow, changes: Partial<PurgeRow> = {}): Promise<{ row: PurgeRow, incident: IncidentRow }> {
  if (row.version >= maximumVersion || row.generation >= maximumVersion) purgeConflict()
  const next = { ...row, ...changes, version: row.version + 1, generation: row.generation + 1, operation_nonce: randomUUID() }
  const updated = await tx.updateTable(purgeTables.purge).set({ ...changes, version: next.version, generation: next.generation, operation_nonce: next.operation_nonce, updated_at: new Date().toISOString() }).where('id', '=', row.id).where('version', '=', row.version).where('generation', '=', row.generation).where('operation_nonce', '=', row.operation_nonce).executeTakeFirst()
  if (mutationCount(updated) !== 1) purgeConflict()
  return { row: next, incident: await advance(tx, incident) }
}
export async function findPurge(tx: Pick<TransactionHandle, 'selectFrom'>, incidentId: number, purgeKey?: string): Promise<PurgeRow> {
  let query = tx.selectFrom(purgeTables.purge).selectAll().where('incident_id', '=', incidentId)
  if (purgeKey) query = query.where('purge_key', '=', purgeKey)
  return asRow<PurgeRow>(await query.executeTakeFirst()) ?? purgeUnavailable()
}
