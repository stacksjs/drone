import type { TransactionHandle } from '@stacksjs/orm'
import type { PurgeRow, PurgeScopeRow } from './internal'
import type { IncidentRow } from '../access/policy'
import type { PurgeCounts } from './types'
import type { PurgeInventoryHeader } from './inventory'
import type { CompletedArtifactIdentity, PreparedCompletedArtifactReceipt } from '../../../artifacts/native-storage/prepared-completed-artifact-directory'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { asRows } from '@stacksjs/database/runtime'
import { sha256 } from '../managed/files'
import { requirePurgeEnabled } from './policy'
import { appendPurgeEvent, purgeConflict, purgeTables, systemPurgeActor, transitionPurge } from './internal'
import { inventoryGroups, inventoryPage, inventoryLine, inventoryAdd } from './inventory'
export interface PurgeFilePlan { root: CompletedArtifactIdentity, tree: CompletedArtifactIdentity, ancestors: CompletedArtifactIdentity[], names: string[], expected: CompletedArtifactIdentity, registeredNames: Record<string, string[]>, artifactId: number }
interface BuildCursor { group: number, after: number, ordinal: number, digest: string }
async function insertItem(tx: TransactionHandle, row: PurgeRow, cursor: BuildCursor, values: Record<string, unknown>): Promise<number> {
  if (++cursor.ordinal >= 2147483647) purgeConflict()
  const at = new Date().toISOString()
  await tx.insertInto(purgeTables.item).values({ purge_id: row.id, ordinal: cursor.ordinal, kind: 'db-row', parent_item_id: null, artifact_ordinal: null, source_table: null, source_row_id: null, planned_json: '{}', identity_json: null, alias_json: null, planned_bytes: null, planned_sha256: null, version: 1, generation: 1, operation_nonce: randomUUID(), state: 'planned', arm_json: null, observed_bytes: null, observed_sha256: null, result_code: null, armed_at_iso: null, verified_at_iso: null, ...values, created_at: at, updated_at: at }).execute()
  const result = asRows<{ id: number }>(await tx.selectFrom(purgeTables.item).select('id').where('purge_id', '=', row.id).where('ordinal', '=', cursor.ordinal).execute())
  if (result.length !== 1) purgeConflict()
  return result[0]!.id
}
async function artifactItems(tx: TransactionHandle, row: PurgeRow, cursor: BuildCursor, artifact: Record<string, unknown>): Promise<void> {
  const artifactOrdinal = cursor.ordinal + 1
  const id = await insertItem(tx, row, cursor, { kind: 'artifact', source_table: 'managed-artifact', source_row_id: artifact.id, planned_json: JSON.stringify(artifact), artifact_ordinal: artifactOrdinal })
  if (artifact.receipt_json === null) return
  const receipt = JSON.parse(artifact.receipt_json as string) as PreparedCompletedArtifactReceipt
  const files = asRows<Record<string, unknown>>(await tx.selectFrom('public_safety_managed_artifact_files').select(['id', 'role', 'relative_path', 'planned_bytes', 'sha256', 'identity_json']).where('artifact_id', '=', artifact.id).orderBy('ordinal', 'asc').limit(772).execute())
  if (files.length !== Number(artifact.file_count) || files.length > 771 || dirname(receipt.directory) !== receipt.parent.path || receipt.directory !== artifact.target_path || receipt.root.path !== receipt.directory) purgeConflict()
  const directories = [receipt.root, ...receipt.directories]
  const registeredNames = Object.fromEntries(directories.map(directory => [directory.path, [] as string[]]))
  for (const directory of receipt.directories) registeredNames[dirname(directory.path)]!.push(directory.path.slice(dirname(directory.path).length + 1))
  for (const file of receipt.files) registeredNames[dirname(file.path)]!.push(file.path.slice(dirname(file.path).length + 1))
  registeredNames[receipt.directory]!.push('manifest.pending.json', 'manifest.json')
  for (const file of files) {
    const expected = file.role === 'manifest' ? receipt.pendingManifest : receipt.files.find(value => value.path === join(receipt.directory, file.relative_path as string))
    if (!expected || file.identity_json !== JSON.stringify(expected) || expected.bytes !== file.planned_bytes || expected.sha256 !== file.sha256) purgeConflict()
    const ancestors = directories.filter(directory => expected.path.startsWith(`${directory.path}/`)).sort((a, b) => a.path.length - b.path.length)
    const plan: PurgeFilePlan = { root: receipt.parent, tree: receipt.root, ancestors, names: file.role === 'manifest' ? [receipt.pendingManifest.path, receipt.completedManifest] : [expected.path], expected, registeredNames, artifactId: artifact.id as number }
    await insertItem(tx, row, cursor, { kind: 'file', parent_item_id: id, artifact_ordinal: artifactOrdinal, planned_json: JSON.stringify(plan), identity_json: JSON.stringify(expected), planned_bytes: file.planned_bytes, planned_sha256: file.sha256 })
  }
  for (const directory of directories.sort((a, b) => b.path.length - a.path.length)) {
    const plan: PurgeFilePlan = { root: receipt.parent, tree: receipt.root, ancestors: directories.filter(parent => directory.path.startsWith(`${parent.path}/`)).sort((a, b) => a.path.length - b.path.length), names: [directory.path], expected: directory, registeredNames, artifactId: artifact.id as number }
    await insertItem(tx, row, cursor, { kind: 'directory', parent_item_id: id, artifact_ordinal: artifactOrdinal, planned_json: JSON.stringify(plan), identity_json: JSON.stringify(directory) })
  }
}
/** One bounded metadata page per committed build unit; no filesystem operations. */
export async function buildPurgePage(tx: TransactionHandle, row: PurgeRow, incident: IncidentRow, scope: PurgeScopeRow): Promise<void> {
  requirePurgeEnabled()
  const cursor = JSON.parse(row.build_cursor_json) as BuildCursor, counts = JSON.parse(row.materialized_counts_json) as PurgeCounts
  const group = inventoryGroups[cursor.group]
  if (group) {
    const rows = await inventoryPage(tx, incident.id, group, cursor.after)
    for (const entry of rows) {
      cursor.digest = sha256(`${cursor.digest}\n${inventoryLine(group, entry)}`)
      if (group === 'managedArtifacts') await artifactItems(tx, row, cursor, entry)
      else if (group !== 'managedFiles' && group !== 'managedEvents') {
        const sourceTable = { sources: 'source', observations: 'observation', reviews: 'review', audits: 'audit', nonCustodyMemberships: 'noncustody-membership' }[group]
        await insertItem(tx, row, cursor, { source_table: sourceTable, source_row_id: entry.id, planned_json: JSON.stringify({ group, metadata: entry }) })
      }
    }
    inventoryAdd(counts, group, rows)
    if (rows.length < 100) { cursor.group++; cursor.after = 0 }
    else cursor.after = rows.at(-1)!.id as number
  }
  else {
    if (cursor.digest !== row.frozen_inventory_digest || JSON.stringify(counts) !== row.frozen_counts_json) purgeConflict()
    const header = JSON.parse(row.frozen_header_json) as PurgeInventoryHeader
    await insertItem(tx, row, cursor, { source_table: 'incident-payload', source_row_id: incident.id, planned_json: JSON.stringify({ configDigest: header.configDigest }) })
  }
  requirePurgeEnabled()
  const next = await transitionPurge(tx, row, incident, { build_cursor_json: JSON.stringify(cursor), materialized_counts_json: JSON.stringify(counts), ...(group ? {} : { state: 'ready', build_digest: cursor.digest }) })
  await appendPurgeEvent(tx, next.row, next.incident, scope, systemPurgeActor, 'build')
}
