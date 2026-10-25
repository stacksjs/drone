import type { BigIntStats } from 'node:fs'
import type { PurgeItemRow } from './internal'
import type { PurgeOutcome, PurgeProgress } from './types'
import type { PurgeFilePlan } from './build'
import type { CompletedArtifactIdentity } from '@stacksjs/storage/prepared-completed-artifact-directory'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { inspectDirectoryMounts, inspectTemporaryWorkspace } from '@stacksjs/storage/temporary-workspaces'
import { identityMatches, sameRoot, sha256 } from '../managed/files'
import { requirePurgeEnabled } from './policy'
import { zeroPurgeProgress } from './types'
export class PurgeFileBlocked extends Error { constructor(readonly outcome: PurgeOutcome) { super('Accepted purge filesystem unit is blocked') } }
function blocked(outcome: PurgeOutcome): never { throw new PurgeFileBlocked(outcome) }
function absent(path: string): boolean { try { lstatSync(path); return false } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true; throw error } }
function match(expected: CompletedArtifactIdentity, links?: string): BigIntStats {
  try { const stat = lstatSync(expected.path, { bigint: true }); if (links !== undefined && String(stat.nlink) !== links) blocked('unexpected-link'); identityMatches(expected, stat, links); return stat }
  catch (error) { if (error instanceof PurgeFileBlocked) throw error; return blocked('identity-changed') }
}
interface AliasArm { path: string, present: boolean }
export interface PurgeFileArm { profile: 'local-purge-arm-v1', plan: PurgeFilePlan, aliases: AliasArm[], observedBytes: number, observedSha256: string | null, fingerprint: string }
function checkAncestors(plan: PurgeFilePlan): void {
  try { sameRoot(plan.root) } catch { blocked('identity-changed') }
  for (const directory of plan.ancestors) match(directory)
}
function supportingInspection(plan: PurgeFilePlan, directoryAbsent = false): void {
  const path = directoryAbsent ? dirname(plan.expected.path) : plan.tree.path
  if (!inspectDirectoryMounts(path).unmounted || !inspectTemporaryWorkspace(path).unused) blocked('inspection-unavailable')
}
function namespace(plan: PurgeFilePlan): void {
  for (const [directory, names] of Object.entries(plan.registeredNames)) {
    if (absent(directory)) continue
    const identity = directory === plan.tree.path ? plan.tree : plan.ancestors.find(item => item.path === directory)
    // Other registered subdirectories are checked by their own units, never traversed here.
    if (!identity) continue
    match(identity)
    if (readdirSync(directory).some(name => !names.includes(name))) blocked('unexpected-entry')
  }
}
function readHash(expected: CompletedArtifactIdentity, maximum: number, links: string): { bytes: number, hash: string } {
  const before = match(expected, links)
  if (before.size < 0n || before.size > BigInt(maximum) || maximum > 33554432) blocked('identity-changed')
  const fd = openSync(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    identityMatches(expected, fstatSync(fd, { bigint: true }), links)
    const hash = createHash('sha256'), scratch = new Uint8Array(65536), size = Number(before.size)
    let offset = 0
    while (offset < size) { const read = readSync(fd, scratch, 0, Math.min(scratch.length, size - offset), offset); if (read <= 0) blocked('identity-changed'); hash.update(scratch.subarray(0, read)); offset += read }
    if (readSync(fd, scratch, 0, 1, size) !== 0) blocked('identity-changed')
    identityMatches(expected, fstatSync(fd, { bigint: true }), links)
    const after = match(expected, links)
    if (after.size !== before.size || after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) blocked('identity-changed')
    return { bytes: size, hash: hash.digest('hex') }
  }
  finally { closeSync(fd) }
}
function armFingerprint(arm: Omit<PurgeFileArm, 'fingerprint'>): string { return sha256(JSON.stringify(arm)) }
/** Observe one exact registered unit outside the write transaction. Never unlink here. */
function observe(item: PurgeItemRow, inspect: boolean): PurgeFileArm {
  const plan = JSON.parse(item.planned_json) as PurgeFilePlan
  checkAncestors(plan)
  namespace(plan)
  const aliases = plan.names.map(path => ({ path, present: !absent(path) })), present = aliases.filter(alias => alias.present)
  if (!present.length) blocked('missing-unarmed')
  let observedBytes = 0, observedSha256: string | null = null
  if (item.kind === 'directory') { match(plan.expected); if (readdirSync(plan.expected.path).length) blocked('unexpected-entry') }
  else {
    for (const alias of present) match({ ...plan.expected, path: alias.path }, String(present.length))
    const observed = readHash({ ...plan.expected, path: present[0]!.path }, item.planned_bytes!, String(present.length))
    observedBytes = observed.bytes; observedSha256 = observed.hash
  }
  if (inspect) supportingInspection(plan)
  const arm = { profile: 'local-purge-arm-v1' as const, plan, aliases, observedBytes, observedSha256 }
  return { ...arm, fingerprint: armFingerprint(arm) }
}
export function observePurgeFile(item: PurgeItemRow): PurgeFileArm { return observe(item, true) }
/** Recheck the exact bounded observation under the arm CAS; effect execution independently repeats actual native inspection. */
export function revalidatePurgeArmObservation(item: PurgeItemRow, expected: PurgeFileArm): void {
  if (JSON.stringify(observe(item, false)) !== JSON.stringify(expected)) blocked('identity-changed')
}
function syncParent(path: string, identity: CompletedArtifactIdentity): void {
  const parent = dirname(path)
  if (parent !== identity.path) blocked('identity-changed')
  match(identity)
  const fd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { identityMatches(identity, fstatSync(fd, { bigint: true })); fsyncSync(fd); match(identity) }
  finally { closeSync(fd) }
}
/** Exact synchronous effect stack. Caller must place its captured SQLite nonce fence immediately before this call. */
export function executePurgeFile(item: PurgeItemRow): PurgeProgress {
  requirePurgeEnabled()
  if (!item.arm_json || item.state !== 'armed') blocked('ownership-uncertain')
  const arm = JSON.parse(item.arm_json) as PurgeFileArm, { fingerprint, ...contents } = arm
  if (arm.profile !== 'local-purge-arm-v1' || fingerprint !== armFingerprint(contents) || JSON.stringify(arm.plan) !== item.planned_json || arm.aliases.length !== arm.plan.names.length || arm.aliases.some((alias, index) => alias.path !== arm.plan.names[index])) blocked('ownership-uncertain')
  const plan = arm.plan, delta = zeroPurgeProgress()
  checkAncestors(plan)
  namespace(plan)
  supportingInspection(plan, item.kind === 'directory' && absent(plan.expected.path))
  const current = arm.aliases.map(alias => ({ ...alias, remains: !absent(alias.path) }))
  if (current.some(alias => !alias.present && alias.remains)) blocked('identity-changed')
  const present = current.filter(alias => alias.remains)
  if (item.kind === 'directory') {
    if (present.length) { match(plan.expected); if (readdirSync(plan.expected.path).length) blocked('unexpected-entry'); requirePurgeEnabled(); rmdirSync(plan.expected.path) }
    syncParent(plan.expected.path, plan.ancestors.at(-1) ?? plan.root)
    if (!absent(plan.expected.path)) blocked('identity-changed')
    delta.directoriesVerifiedAbsent = 1
    return delta
  }
  for (const alias of present) match({ ...plan.expected, path: alias.path }, String(present.length))
  if (present.length) {
    const observed = readHash({ ...plan.expected, path: present[0]!.path }, item.planned_bytes!, String(present.length))
    if (observed.bytes !== arm.observedBytes || observed.hash !== arm.observedSha256) blocked('identity-changed')
  }
  let remaining = present.length
  for (const alias of current) {
    if (!alias.present) { delta.namesInitiallyAbsent++; continue }
    if (!alias.remains) delta.namesAbsenceReconciled++
    else {
      match({ ...plan.expected, path: alias.path }, String(remaining))
      requirePurgeEnabled()
      unlinkSync(alias.path)
      remaining--; delta.namesUnlinked++
    }
    syncParent(alias.path, plan.ancestors.at(-1) ?? plan.root)
    if (!absent(alias.path)) blocked('identity-changed')
    for (const other of current.filter(value => value.path !== alias.path && !absent(value.path))) match({ ...plan.expected, path: other.path }, String(remaining))
  }
  if (current.some(alias => !absent(alias.path))) blocked('identity-changed')
  delta.namesVerifiedAbsent = delta.namesUnlinked + delta.namesInitiallyAbsent + delta.namesAbsenceReconciled
  delta.fileInodesVerifiedAbsent = 1; delta.observedFileBytes = arm.observedBytes
  return delta
}
