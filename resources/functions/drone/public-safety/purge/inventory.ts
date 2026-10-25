import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import type { PurgeCounts } from './types'
import type { PreparedCompletedArtifactReceipt } from '@stacksjs/storage/prepared-completed-artifact-directory'
import { asRows } from '@stacksjs/database/runtime'
import { sha256 } from '../managed/files'
import { purgeConflict } from './internal'
import { purgeCoverage, purgeExclusions, zeroPurgeCounts } from './types'
export interface PurgeInventoryHeader { profile: 'purge-inventory-v1', key: string, incidentVersion: number, retentionVersion: number, eligibleAt: string, configDigest: string, originalHold: string, holdState: string, coverage: typeof purgeCoverage, exclusions: typeof purgeExclusions }
export function purgeInventoryHeader(incident: IncidentRow, scope: { version: number, original_hold: string, hold_state: string }): PurgeInventoryHeader {
  if (incident.config_json === null || incident.purpose === null || incident.revision === null) purgeConflict()
  return { profile: 'purge-inventory-v1', key: incident.incident_key, incidentVersion: incident.version, retentionVersion: scope.version, eligibleAt: incident.retain_until, configDigest: sha256(JSON.stringify([incident.purpose, incident.revision, incident.config_json])), originalHold: scope.original_hold, holdState: scope.hold_state, coverage: purgeCoverage, exclusions: purgeExclusions }
}
export const inventoryGroups = ['sources', 'observations', 'reviews', 'audits', 'nonCustodyMemberships', 'managedArtifacts', 'managedFiles', 'managedEvents'] as const
export type InventoryGroup = typeof inventoryGroups[number]
export const inventoryFields: Record<InventoryGroup, string[]> = {
  sources: ['id', 'incident_id', 'digest', 'byte_length', 'replay_profile', 'evidence', 'uploader_id', 'uploaded_at_iso', 'created_sequence'],
  observations: ['id', 'source_id', 'capture_id', 'modality', 'pixel_x', 'pixel_y', 'actor_id', 'observed_at_iso', 'created_sequence'],
  reviews: ['id', 'observation_id', 'previous_review_id', 'disposition', 'actor_id', 'reviewed_at_iso', 'created_sequence'],
  audits: ['id', 'incident_id', 'sequence', 'actor_id', 'action', 'target_user_id', 'at_iso'],
  nonCustodyMemberships: ['id', 'incident_id', 'user_id', 'role'],
  managedArtifacts: ['id', 'artifact_key', 'incident_id', 'retention_scope_id', 'source_id', 'source_digest', 'source_byte_length', 'source_created_sequence', 'config_digest', 'version', 'generation', 'state', 'planned_root_json', 'target_path', 'receipt_json', 'plan_digest', 'file_count', 'total_planned_bytes', 'manifest_sha256'],
  managedFiles: ['id', 'artifact_id', 'ordinal', 'relative_path', 'role', 'planned_bytes', 'sha256', 'identity_json'],
  managedEvents: ['id', 'artifact_id', 'sequence', 'incident_version', 'action', 'actor_user_id', 'at_iso', 'request_id', 'request_digest', 'step', 'outcome_code'],
}
export const inventoryTables: Record<InventoryGroup, string> = { sources: 'public_safety_sources', observations: 'public_safety_observations', reviews: 'public_safety_reviews', audits: 'public_safety_audits', nonCustodyMemberships: 'public_safety_incident_members', managedArtifacts: 'public_safety_managed_artifacts', managedFiles: 'public_safety_managed_artifact_files', managedEvents: 'public_safety_managed_artifact_events' }
export async function inventoryPage(tx: Pick<TransactionHandle, 'selectFrom'>, incidentId: number, group: InventoryGroup, after: number, limit = 100): Promise<Record<string, unknown>[]> {
  const table = inventoryTables[group]
  let query = tx.selectFrom(table)
  if (group === 'observations' || group === 'reviews') {
    if (group === 'reviews') query = query.innerJoin('public_safety_observations', 'public_safety_observations.id', '=', 'public_safety_reviews.observation_id')
    query = query.innerJoin('public_safety_sources', 'public_safety_sources.id', '=', 'public_safety_observations.source_id').where('public_safety_sources.incident_id', '=', incidentId)
  }
  else if (group === 'managedFiles' || group === 'managedEvents') query = query.innerJoin('public_safety_managed_artifacts', 'public_safety_managed_artifacts.id', '=', `${table}.artifact_id`).where('public_safety_managed_artifacts.incident_id', '=', incidentId)
  else query = query.where(`${table}.incident_id`, '=', incidentId)
  if (group === 'nonCustodyMemberships') query = query.where('role', 'not in', ['coordinator', 'evidence-custodian'])
  return asRows<Record<string, unknown>>(await query.select(inventoryFields[group].map(field => `${table}.${field}`)).where(`${table}.id`, '>', after).orderBy(`${table}.id`, 'asc').limit(limit).execute())
}
export function inventoryLine(group: InventoryGroup, row: Record<string, unknown>): string { return `${JSON.stringify([group, ...inventoryFields[group].map(field => row[field])])}\n` }
export function inventoryAdd(counts: PurgeCounts, group: InventoryGroup, rows: Record<string, unknown>[]): void {
  counts[group] += rows.length
  if (group === 'managedArtifacts') for (const row of rows) {
    counts.totalPlannedFileBytes += Number(row.total_planned_bytes)
    counts.manifestAliases += 2
    if (row.receipt_json !== null) {
      const receipt = JSON.parse(row.receipt_json as string) as PreparedCompletedArtifactReceipt
      counts.managedDirectories += 1 + receipt.directories.length
    }
  }
  for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0) purgeConflict()
}
/** Metadata-only keyset pages. Never copies source JSON, notes, config or manifest bodies. */
export async function purgeInventory(tx: Pick<TransactionHandle, 'selectFrom'>, incidentId: number, header: PurgeInventoryHeader): Promise<{ digest: string, counts: PurgeCounts }> {
  let digest = sha256(`${JSON.stringify(header)}\n`)
  const counts = zeroPurgeCounts()
  counts.incidentPayloads = 1
  for (const group of inventoryGroups) {
    let after = 0
    for (;;) {
      const rows = await inventoryPage(tx, incidentId, group, after)
      for (const row of rows) digest = sha256(`${digest}\n${inventoryLine(group, row)}`)
      inventoryAdd(counts, group, rows)
      if (rows.length < 100) break
      after = rows.at(-1)!.id as number
    }
  }
  return { digest, counts }
}
