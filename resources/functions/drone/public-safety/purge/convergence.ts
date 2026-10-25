import type { TransactionHandle } from '@stacksjs/orm'
import type { PurgeRow, PurgeItemRow, PurgeEventRow } from './internal'
import type { PurgeCounts, PurgeProgress } from './types'
import type { PurgeFileArm } from './files'
import type { PreparedCompletedArtifactReceipt, CompletedArtifactIdentity } from '@stacksjs/storage/prepared-completed-artifact-directory'
import { lstatSync } from 'node:fs'
import { asRows } from '@stacksjs/database/runtime'
import { sameRoot } from '../managed/files'
import { addProgress, purgeConflict } from './internal'
import { zeroPurgeProgress } from './types'
function strictAbsent(path: string): void {
  try { lstatSync(path); purgeConflict() }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
}
/** Independent convergence from exact materialized plans and committed deltas, before retiring any ownership metadata. */
export async function verifyPurgeConvergence(tx: Pick<TransactionHandle, 'selectFrom'>, row: PurgeRow): Promise<void> {
  const planned = JSON.parse(row.frozen_counts_json) as PurgeCounts, progress = JSON.parse(row.progress_counts_json) as PurgeProgress
  if (row.build_digest !== row.frozen_inventory_digest || row.materialized_counts_json !== row.frozen_counts_json) purgeConflict()
  const derived = zeroPurgeProgress()
  let artifacts = 0, expectedFiles = 0, expectedDirectories = 0, expectedBytes = 0, aliases = 0, after = 0
  for (;;) {
    const items = asRows<PurgeItemRow>(await tx.selectFrom('public_safety_purge_items').selectAll().where('purge_id', '=', row.id).where('id', '>', after).orderBy('id', 'asc').limit(100).execute())
    for (const item of items) {
      if (item.kind === 'db-row') {
        if (item.state !== 'row-removed' || item.result_code !== 'row-removed') purgeConflict()
        const field = { source: 'sourceRowsRemoved', observation: 'observationRowsRemoved', review: 'reviewRowsRemoved', audit: 'auditRowsRemoved', 'noncustody-membership': 'nonCustodyMembershipRowsRemoved', 'incident-payload': 'incidentPayloadRowsCleared' }[item.source_table as Exclude<NonNullable<PurgeItemRow['source_table']>, 'managed-artifact'>] as keyof PurgeProgress | undefined
        if (!field) purgeConflict()
        derived[field]++
      }
      else if (item.kind === 'artifact') {
        if (item.state !== 'verified-absent') purgeConflict()
        artifacts++
        const snapshot = JSON.parse(item.planned_json) as { receipt_json: string | null, planned_root_json: string, target_path: string, file_count: number, total_planned_bytes: number }
        expectedFiles += snapshot.file_count; expectedBytes += snapshot.total_planned_bytes; aliases += 2
        sameRoot(JSON.parse(snapshot.planned_root_json) as CompletedArtifactIdentity)
        strictAbsent(snapshot.target_path)
        if (snapshot.receipt_json === null) { if (item.result_code !== 'no-preparation-observed') purgeConflict(); derived.noPreparationObserved++ }
        else { const receipt = JSON.parse(snapshot.receipt_json) as PreparedCompletedArtifactReceipt; expectedDirectories += receipt.directories.length + 1 }
      }
      else {
        if (item.state !== 'verified-absent' || !item.arm_json) purgeConflict()
        const arm = JSON.parse(item.arm_json) as PurgeFileArm
        if (item.kind === 'directory') derived.directoriesVerifiedAbsent++
        else {
          derived.fileInodesVerifiedAbsent++; derived.observedFileBytes += arm.observedBytes
          derived.namesVerifiedAbsent += arm.aliases.length
          derived.namesInitiallyAbsent += arm.aliases.filter(alias => !alias.present).length
        }
      }
    }
    if (items.length < 100) break
    after = items.at(-1)!.id
  }
  if (derived.sourceRowsRemoved !== planned.sources || derived.observationRowsRemoved !== planned.observations || derived.reviewRowsRemoved !== planned.reviews || derived.auditRowsRemoved !== planned.audits || derived.nonCustodyMembershipRowsRemoved !== planned.nonCustodyMemberships || derived.incidentPayloadRowsCleared !== planned.incidentPayloads || artifacts !== planned.managedArtifacts || expectedFiles !== planned.managedFiles || expectedDirectories !== planned.managedDirectories || expectedBytes !== planned.totalPlannedFileBytes || aliases !== planned.manifestAliases) purgeConflict()
  const eventTotals = zeroPurgeProgress()
  let sequence = 0
  for (;;) {
    const events = asRows<PurgeEventRow>(await tx.selectFrom('public_safety_purge_events').selectAll().where('purge_id', '=', row.id).where('sequence', '>', sequence).orderBy('sequence', 'asc').limit(100).execute())
    for (const event of events) {
      if (event.sequence !== sequence + 1) purgeConflict()
      Object.assign(eventTotals, addProgress(eventTotals, JSON.parse(event.counts_json)))
      sequence = event.sequence
    }
    if (events.length < 100) break
  }
  if (sequence !== row.version || JSON.stringify(eventTotals) !== row.progress_counts_json) purgeConflict()
  for (const field of Object.keys(derived) as (keyof PurgeProgress)[]) if (field !== 'namesUnlinked' && field !== 'namesAbsenceReconciled' && derived[field] !== progress[field]) purgeConflict()
  if (progress.namesVerifiedAbsent !== progress.namesUnlinked + progress.namesInitiallyAbsent + progress.namesAbsenceReconciled) purgeConflict()
  // Every owned artifact has one file item per registered inode. Intent-only catalogs deliberately have no inode items.
  let ownedCatalogFiles = 0
  for (let cursor = 0;;) {
    const items = asRows<PurgeItemRow>(await tx.selectFrom('public_safety_purge_items').selectAll().where('purge_id', '=', row.id).where('kind', '=', 'artifact').where('id', '>', cursor).orderBy('id', 'asc').limit(100).execute())
    for (const item of items) { const snapshot = JSON.parse(item.planned_json) as { receipt_json: string | null, file_count: number }; if (snapshot.receipt_json !== null) ownedCatalogFiles += snapshot.file_count }
    if (items.length < 100) break
    cursor = items.at(-1)!.id
  }
  if (derived.fileInodesVerifiedAbsent !== ownedCatalogFiles) purgeConflict()
}
