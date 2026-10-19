import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import type { PurgeRow, PurgeScopeRow, PurgeItemRow } from './internal'
import type { PurgeProgress, PurgeOutcome } from './types'
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { asRow, asRows, lockRow, mutationCount, resolvedDatabaseDriver } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { PublicSafetyAccessError } from '../access/errors'
import { maximumVersion } from '../access/mutations'
import { sha256, sameRoot } from '../managed/files'
import { purgeTables, purgeConflict, appendPurgeEvent, transitionPurge, systemPurgeActor, addProgress, purgeUuid } from './internal'
import { zeroPurgeProgress } from './types'
import { purgeEnabled, requirePurgeEnabled } from './policy'
import { buildPurgePage } from './build'
import { executePurgeFile, observePurgeFile, revalidatePurgeArmObservation, PurgeFileBlocked } from './files'
import { verifyPurgeConvergence } from './convergence'
import { inventoryFields, inventoryTables } from './inventory'
interface Context { row: PurgeRow, incident: IncidentRow, scope: PurgeScopeRow }
interface BatchOptions { maxPurges?: 1, maxItems?: number, maxRows?: number, maxBytes?: number, budgetMs?: number, purgeKey?: string }
export interface PurgeBatchResult { unitsCommitted: number, enabled: boolean, selected: boolean }
async function current(tx: TransactionHandle, id: number): Promise<Context> {
  const initial = asRow<PurgeRow>(await tx.selectFrom(purgeTables.purge).selectAll().where('id', '=', id).executeTakeFirst()) ?? purgeConflict()
  const incident = asRow<IncidentRow>(await lockRow(tx, 'public_safety_incidents', { id: initial.incident_id })) ?? purgeConflict()
  const scope = asRow<PurgeScopeRow>(await lockRow(tx, 'public_safety_retention_scopes', { id: initial.retention_scope_id })) ?? purgeConflict()
  const row = asRow<PurgeRow>(await lockRow(tx, purgeTables.purge, { id })) ?? purgeConflict()
  if (row.incident_id !== incident.id || scope.incident_id !== incident.id || scope.freeze_state === 'retained' || row.accepted_incident_version >= incident.version || row.accepted_retention_version >= scope.version) purgeConflict()
  return { row, incident, scope }
}
/** Captured transaction only, new uncommitted nonce and exact phase/generation immediately before synchronous effects. */
function continuity(tx: TransactionHandle, row: PurgeRow, item: PurgeItemRow): void {
  requirePurgeEnabled()
  if (resolvedDatabaseDriver() !== 'sqlite') throw new PurgeFileBlocked('inspection-unavailable')
  const nonce = randomUUID()
  const statement = tx.unsafe('UPDATE public_safety_purge_items SET operation_nonce = ? WHERE id = ? AND purge_id = ? AND version = ? AND generation = ? AND state = ? AND operation_nonce = ? AND EXISTS (SELECT 1 FROM public_safety_purges WHERE id = ? AND version = ? AND generation = ? AND operation_nonce = ?) RETURNING id', [nonce, item.id, row.id, item.version, item.generation, 'armed', item.operation_nonce, row.id, row.version, row.generation, row.operation_nonce]) as unknown as { executeSync?: () => unknown }
  if (typeof statement.executeSync !== 'function') throw new PurgeFileBlocked('inspection-unavailable')
  const result = statement.executeSync()
  if (!Array.isArray(result) || result.length !== 1 || !result[0] || typeof result[0] !== 'object' || (result[0] as { id?: unknown }).id !== item.id) purgeConflict()
  const fresh = tx.unsafe('SELECT id FROM public_safety_purge_items WHERE id = ? AND purge_id = ? AND version = ? AND generation = ? AND state = ? AND operation_nonce = ? AND EXISTS (SELECT 1 FROM public_safety_purges WHERE id = ? AND version = ? AND generation = ? AND operation_nonce = ?)', [item.id, row.id, item.version, item.generation, 'armed', nonce, row.id, row.version, row.generation, row.operation_nonce]) as unknown as { executeSync?: () => unknown }
  if (typeof fresh.executeSync !== 'function') throw new PurgeFileBlocked('inspection-unavailable')
  const verified = fresh.executeSync()
  if (!Array.isArray(verified) || verified.length !== 1 || !verified[0] || typeof verified[0] !== 'object' || (verified[0] as { id?: unknown }).id !== item.id) purgeConflict()
}
async function updateItem(tx: TransactionHandle, item: PurgeItemRow, changes: Partial<PurgeItemRow>): Promise<PurgeItemRow> {
  if (item.version >= maximumVersion || item.generation >= maximumVersion) purgeConflict()
  const next = { ...item, ...changes, version: item.version + 1, generation: item.generation + 1, operation_nonce: randomUUID() }
  const changed = await tx.updateTable(purgeTables.item).set({ ...changes, version: next.version, generation: next.generation, operation_nonce: next.operation_nonce, updated_at: new Date().toISOString() }).where('id', '=', item.id).where('version', '=', item.version).where('generation', '=', item.generation).executeTakeFirst()
  if (mutationCount(changed) !== 1) purgeConflict()
  return next
}
async function recordStep(tx: TransactionHandle, context: Context, step: 'arm' | 'result' | 'db-batch' | 'blocked' | 'minimize' | 'complete', delta = zeroPurgeProgress(), changes: Partial<PurgeRow> = {}): Promise<void> {
  const next = await transitionPurge(tx, context.row, context.incident, { progress_counts_json: JSON.stringify(addProgress(JSON.parse(context.row.progress_counts_json), delta)), ...changes })
  await appendPurgeEvent(tx, next.row, next.incident, context.scope, systemPurgeActor, step, delta)
}
async function blockUnit(id: number, outcome: PurgeOutcome, phase: 'build' | 'db' | 'fs' | 'minimize' | 'retire'): Promise<void> {
  await transaction(async tx => {
    const context = await current(tx, id)
    if (context.row.state === 'complete' || context.row.completed_at_iso !== null) return
    requirePurgeEnabled()
    const at = new Date().toISOString()
    await recordStep(tx, context, 'blocked', zeroPurgeProgress(), { state: 'blocked', ...(phase === 'fs' ? { fs_state: 'blocked' as const } : phase === 'db' || phase === 'build' ? { db_state: 'blocked' as const } : {}), outcome_code: outcome, blocked_at_iso: context.row.blocked_at_iso ?? at, review_due_at_iso: context.row.review_due_at_iso ?? new Date(Date.now() + 30 * 86400000).toISOString(), next_eligible_at_iso: new Date(Date.now() + 60000).toISOString() })
  }, { retries: 0 })
}
async function dbUnit(tx: TransactionHandle, context: Context, maxRows: number): Promise<boolean> {
  let selected: PurgeItemRow[] = []
  for (const sourceTable of ['review', 'observation', 'source', 'audit', 'noncustody-membership', 'incident-payload']) {
    selected = asRows<PurgeItemRow>(await tx.selectFrom(purgeTables.item).selectAll().where('purge_id', '=', context.row.id).where('kind', '=', 'db-row').where('state', '=', 'planned').where('source_table', '=', sourceTable).orderBy('source_row_id', 'desc').limit(maxRows).execute())
    if (selected.length) break
  }
  if (!selected.length) return false
  const delta = zeroPurgeProgress()
  for (const item of selected) {
    requirePurgeEnabled()
    if (item.source_table === 'incident-payload') {
      const expected = JSON.parse(item.planned_json) as { configDigest: string }
      if (context.incident.config_json === null || sha256(JSON.stringify([context.incident.purpose, context.incident.revision, context.incident.config_json])) !== expected.configDigest) throw new PurgeFileBlocked('inventory-changed')
      const changed = await tx.updateTable('public_safety_incidents').set({ config_json: null, purpose: null, revision: null, status: 'purged' }).where('id', '=', context.incident.id).where('version', '=', context.incident.version).where('config_json', '=', context.incident.config_json).executeTakeFirst()
      if (mutationCount(changed) !== 1) purgeConflict()
      context.incident = { ...context.incident, config_json: null, purpose: null, revision: null, status: 'purged' }; delta.incidentPayloadRowsCleared++
    }
    else {
      const plan = JSON.parse(item.planned_json) as { group: keyof typeof inventoryTables, metadata: Record<string, unknown> }, table = inventoryTables[plan.group]
      const actual = asRow<Record<string, unknown>>(await tx.selectFrom(table).select(inventoryFields[plan.group]).where('id', '=', item.source_row_id).executeTakeFirst())
      if (!actual || inventoryFields[plan.group].some(field => actual[field] !== plan.metadata[field])) throw new PurgeFileBlocked('inventory-changed')
      if (item.source_table === 'review') {
        const child = await tx.selectFrom('public_safety_reviews').select('id').where('previous_review_id', '=', item.source_row_id).limit(1).executeTakeFirst()
        if (child) throw new PurgeFileBlocked('foreign-reference')
      }
      if (item.source_table === 'source' && await tx.selectFrom('public_safety_managed_artifacts').select('id').where('source_id', '=', item.source_row_id).where('incident_id', '!=', context.incident.id).limit(1).executeTakeFirst()) throw new PurgeFileBlocked('foreign-reference')
      const removed = asRows<{ id: number }>(await tx.deleteFrom(table).where('id', '=', item.source_row_id).returning('id').execute())
      if (removed.length !== 1 || removed[0]!.id !== item.source_row_id) purgeConflict()
      if (item.source_table === null || item.source_table === 'managed-artifact') purgeConflict()
      const field = { review: 'reviewRowsRemoved', observation: 'observationRowsRemoved', source: 'sourceRowsRemoved', audit: 'auditRowsRemoved', 'noncustody-membership': 'nonCustodyMembershipRowsRemoved' }[item.source_table!] as keyof PurgeProgress
      delta[field]++
    }
    await updateItem(tx, item, { state: 'row-removed', result_code: 'row-removed', verified_at_iso: new Date().toISOString() })
  }
  requirePurgeEnabled()
  const remaining = await tx.selectFrom(purgeTables.item).select('id').where('purge_id', '=', context.row.id).where('kind', '=', 'db-row').where('state', '=', 'planned').limit(1).executeTakeFirst()
  await recordStep(tx, context, 'db-batch', delta, { state: context.row.fs_state === 'blocked' ? 'blocked' : 'running', db_state: remaining ? 'running' : 'complete' })
  return true
}
async function noPreparation(tx: TransactionHandle, context: Context, item: PurgeItemRow): Promise<void> {
  const artifact = JSON.parse(item.planned_json) as { receipt_json: string | null, planned_root_json: string, target_path: string }
  if (artifact.receipt_json !== null) purgeConflict()
  try { sameRoot(JSON.parse(artifact.planned_root_json)); lstatSync(artifact.target_path); throw new PurgeFileBlocked('ownership-uncertain') }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const delta = zeroPurgeProgress(); delta.noPreparationObserved = 1
  await updateItem(tx, item, { state: 'verified-absent', result_code: 'no-preparation-observed', verified_at_iso: new Date().toISOString() })
  await recordStep(tx, context, 'result', delta)
}
async function fileUnit(id: number): Promise<boolean> {
  const staged = await transaction(async tx => {
    const context = await current(tx, id)
    let item: PurgeItemRow | undefined
    for (const kind of ['file', 'directory', 'artifact']) {
      item = asRow<PurgeItemRow>(await tx.selectFrom(purgeTables.item).selectAll().where('purge_id', '=', id).where('kind', '=', kind).where('state', 'in', ['planned', 'armed']).orderBy('ordinal', 'asc').limit(1).executeTakeFirst())
      if (item) break
    }
    if (!item) return undefined
    if (item.kind === 'artifact') {
      const artifact = JSON.parse(item.planned_json) as { receipt_json: string | null }
      if (artifact.receipt_json === null) await noPreparation(tx, context, item)
      else {
        await updateItem(tx, item, { state: 'verified-absent', result_code: 'absence-reconciled', verified_at_iso: new Date().toISOString() })
        await recordStep(tx, context, 'result')
      }
      return { done: true as const }
    }
    return { item }
  }, { retries: 0 })
  if (!staged) return false
  if ('done' in staged) return true
  let item = staged.item!
  if (item.state === 'planned') {
    const arm = observePurgeFile(item)
    await transaction(async tx => {
      const context = await current(tx, id), lockedItem = asRow<PurgeItemRow>(await lockRow(tx, purgeTables.item, { id: item.id })) ?? purgeConflict()
      requirePurgeEnabled()
      if (lockedItem.version !== item.version || lockedItem.generation !== item.generation || lockedItem.state !== 'planned') purgeConflict()
      revalidatePurgeArmObservation(lockedItem, arm)
      item = await updateItem(tx, lockedItem, { state: 'armed', arm_json: JSON.stringify(arm), alias_json: JSON.stringify(arm.aliases), observed_bytes: arm.observedBytes, observed_sha256: arm.observedSha256, armed_at_iso: new Date().toISOString() })
      await recordStep(tx, context, 'arm')
    }, { retries: 0 })
    // Real arm COMMIT has resolved before the captured execution transaction can perform an effect.
  }
  await transaction(async tx => {
    const context = await current(tx, id), lockedItem = asRow<PurgeItemRow>(await lockRow(tx, purgeTables.item, { id: item.id })) ?? purgeConflict()
    if (lockedItem.version !== item.version || lockedItem.generation !== item.generation || lockedItem.arm_json !== item.arm_json || lockedItem.state !== 'armed') purgeConflict()
    continuity(tx, context.row, lockedItem)
    const delta = executePurgeFile(lockedItem)
    await updateItem(tx, lockedItem, { state: 'verified-absent', result_code: delta.namesUnlinked > 0 ? 'observed-unlinked' : 'absence-reconciled', verified_at_iso: new Date().toISOString() })
    await recordStep(tx, context, 'result', delta, { state: context.row.db_state === 'complete' ? 'running' : context.row.state, fs_state: 'running', outcome_code: null })
  }, { retries: 0 })
  return true
}
async function minimize(tx: TransactionHandle, context: Context, maxRows: number): Promise<void> {
  requirePurgeEnabled()
  const row = context.row
  if (row.sealed_totals_json === '{}') {
    const unfinished = await tx.selectFrom(purgeTables.item).select('id').where('purge_id', '=', row.id).where('state', 'not in', ['verified-absent', 'row-removed']).limit(1).executeTakeFirst()
    if (unfinished || row.db_state !== 'complete') purgeConflict()
    await verifyPurgeConvergence(tx, row)
    await tx.updateTable('public_safety_retention_scopes').set({ inventory_digest: null, case_reference: null, review_due_at: null, reviewer_user_id: null, reviewed_at_iso: null }).where('id', '=', context.scope.id).execute()
    await recordStep(tx, context, 'minimize', zeroPurgeProgress(), { state: 'minimizing', fs_state: 'complete', db_state: 'complete', sealed_totals_json: JSON.stringify({ inventoryDigest: row.frozen_inventory_digest, planned: JSON.parse(row.frozen_counts_json), completed: JSON.parse(row.progress_counts_json) }) })
    return
  }
  const artifacts = asRows<{ id: number }>(await tx.selectFrom('public_safety_managed_artifacts').select('id').where('incident_id', '=', context.incident.id).orderBy('id', 'asc').limit(1).execute())
  if (artifacts.length) {
    const id = artifacts[0]!.id
    for (const table of ['public_safety_managed_artifact_files', 'public_safety_managed_artifact_events']) {
      const children = asRows<{ id: number }>(await tx.selectFrom(table).select('id').where('artifact_id', '=', id).orderBy('id', 'asc').limit(maxRows).execute())
      if (children.length) { requirePurgeEnabled(); await tx.deleteFrom(table).where('id', 'in', children.map(value => value.id)).execute(); await recordStep(tx, context, 'minimize'); return }
    }
    requirePurgeEnabled(); await tx.deleteFrom('public_safety_managed_artifacts').where('id', '=', id).where('incident_id', '=', context.incident.id).execute()
    await recordStep(tx, context, 'minimize'); return
  }
  const children = asRows<{ id: number }>(await tx.selectFrom(purgeTables.item).select('id').where('purge_id', '=', row.id).where('parent_item_id', 'is not', null).orderBy('id', 'desc').limit(maxRows).execute())
  const items = children.length ? children : asRows<{ id: number }>(await tx.selectFrom(purgeTables.item).select('id').where('purge_id', '=', row.id).orderBy('id', 'desc').limit(maxRows).execute())
  if (items.length) { requirePurgeEnabled(); await tx.deleteFrom(purgeTables.item).where('id', 'in', items.map(item => item.id)).execute(); await recordStep(tx, context, 'minimize'); return }
  const old = asRows<{ id: number }>(await tx.selectFrom('public_safety_retention_events').select('id').where('scope_id', '=', context.scope.id).orderBy('id', 'asc').limit(maxRows).execute())
  if (old.length) { requirePurgeEnabled(); await tx.deleteFrom('public_safety_retention_events').where('id', 'in', old.map(item => item.id)).execute(); await recordStep(tx, context, 'minimize'); return }
  if (context.incident.config_json !== null || context.incident.status !== 'purged') purgeConflict()
  // These checks are exact remaining active-payload and private-ledger inventories, not an all-copy claim.
  for (const table of ['public_safety_sources', 'public_safety_audits', 'public_safety_managed_artifacts']) if (await tx.selectFrom(table).select('id').where('incident_id', '=', context.incident.id).limit(1).executeTakeFirst()) purgeConflict()
  requirePurgeEnabled()
  await tx.updateTable('public_safety_retention_scopes').set({ freeze_state: 'purged', inventory_digest: null, case_reference: null, review_due_at: null, reviewer_user_id: null, reviewed_at_iso: null }).where('id', '=', context.scope.id).execute()
  const at = new Date().toISOString(), until = new Date(Date.parse(at) + row.receipt_retention_days * 86400000).toISOString()
  await recordStep(tx, context, 'complete', zeroPurgeProgress(), { state: 'complete', fs_state: 'complete', db_state: 'complete', completed_at_iso: at, receipt_retain_until_iso: until, outcome_code: null, blocked_at_iso: null, review_due_at_iso: null, frozen_header_json: '{}', build_cursor_json: '{}', db_cursor_json: '{}', minimize_cursor_json: '{}', build_digest: null, materialized_counts_json: '{}', next_eligible_at_iso: until })
}
async function retireMetadata(tx: TransactionHandle, context: Context, maxRows: number): Promise<void> {
  requirePurgeEnabled()
  if (context.row.state !== 'complete' || !context.row.receipt_retain_until_iso || Date.parse(context.row.receipt_retain_until_iso) > Date.now()) purgeConflict()
  for (const [table, column, id] of [[purgeTables.event, 'purge_id', context.row.id], ['public_safety_retention_events', 'scope_id', context.scope.id], ['public_safety_incident_members', 'incident_id', context.incident.id]] as const) {
    const rows = asRows<{ id: number }>(await tx.selectFrom(table).select('id').where(column, '=', id).orderBy('id', 'asc').limit(maxRows).execute())
    if (rows.length) { requirePurgeEnabled(); await tx.deleteFrom(table).where('id', 'in', rows.map(value => value.id)).execute(); return }
  }
  requirePurgeEnabled()
  await tx.deleteFrom(purgeTables.purge).where('id', '=', context.row.id).execute()
  await tx.deleteFrom('public_safety_retention_scopes').where('id', '=', context.scope.id).execute()
  await tx.deleteFrom('public_safety_incidents').where('id', '=', context.incident.id).where('status', '=', 'purged').execute()
}
/** Trusted bounded executor. No scheduler registration, clock lease, impersonated human or detached work. */
export async function runPublicSafetyPurgeBatch(options: BatchOptions = {}): Promise<PurgeBatchResult> {
  requirePurgeEnabled()
  const maxItems = options.maxItems ?? 16, maxRows = options.maxRows ?? 100, maxBytes = options.maxBytes ?? 33554432, budgetMs = options.budgetMs ?? 5000
  if (options.maxPurges !== undefined && options.maxPurges !== 1 || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 16 || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100 || maxBytes !== 33554432 || !Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 5000) throw new PublicSafetyAccessError(422, 'Invalid internal purge batch bound')
  if (options.purgeKey !== undefined) purgeUuid(options.purgeKey)
  const { db } = await import('@stacksjs/database/runtime')
  let query = db.primary.selectFrom(purgeTables.purge).selectAll().where('next_eligible_at_iso', '<=', new Date().toISOString()).orderBy('next_eligible_at_iso', 'asc').orderBy('id', 'asc').limit(1)
  if (options.purgeKey) query = query.where('purge_key', '=', options.purgeKey)
  const selected = asRow<PurgeRow>(await query.executeTakeFirst())
  if (!selected) return { unitsCommitted: 0, enabled: true, selected: false }
  const deadline = performance.now() + budgetMs
  let units = 0
  while (units < maxItems && performance.now() < deadline && purgeEnabled()) {
    let phase: 'build' | 'db' | 'fs' | 'minimize' | 'retire' = 'build'
    try {
      const context = await transaction(tx => current(tx, selected.id), { retries: 0 })
      if (context.row.build_digest === null && context.row.sealed_totals_json === '{}') await transaction(async tx => { const value = await current(tx, selected.id); await buildPurgePage(tx, value.row, value.incident, value.scope) }, { retries: 0 })
      else if (context.row.state === 'complete') { phase = 'retire'; if (!context.row.receipt_retain_until_iso || Date.parse(context.row.receipt_retain_until_iso) > Date.now()) break; await transaction(async tx => retireMetadata(tx, await current(tx, selected.id), maxRows), { retries: 0 }); units++; break }
      else if (context.row.sealed_totals_json !== '{}') { phase = 'minimize'; await transaction(async tx => minimize(tx, await current(tx, selected.id), maxRows), { retries: 0 }) }
      else {
        phase = 'db'
        const removed = context.row.db_state !== 'blocked' && await transaction(async tx => dbUnit(tx, await current(tx, selected.id), maxRows), { retries: 0 })
        if (!removed) {
          phase = 'fs'
          if (!await fileUnit(selected.id)) {
            if (context.row.db_state !== 'complete') break
            phase = 'minimize'; await transaction(async tx => minimize(tx, await current(tx, selected.id), maxRows), { retries: 0 })
          }
        }
      }
      units++
    }
    catch (error) {
      if (!purgeEnabled()) break
      await blockUnit(selected.id, error instanceof PurgeFileBlocked ? error.outcome : phase === 'fs' && !(error instanceof PublicSafetyAccessError) ? 'io-failed' : 'sql-failed', phase)
      units++; break
    }
  }
  return { unitsCommitted: units, enabled: purgeEnabled(), selected: true }
}
