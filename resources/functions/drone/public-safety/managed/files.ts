import type { BigIntStats } from 'node:fs'
import type { CompletedArtifactIdentity, PreparedCompletedArtifactReceipt } from '../../../artifacts/native-storage/prepared-completed-artifact-directory'
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { env } from '@stacksjs/env'
import { publicPath, storagePath } from '@stacksjs/path'
import { inspectTemporaryWorkspace } from '@stacksjs/storage'
import { PublicSafetyAccessError } from '../access/errors'

export const managedBytes = 32 * 1024 * 1024
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
export function managedUnavailable(): never { throw new PublicSafetyAccessError(409, 'Managed dataset is unavailable') }
export function observedIdentity(path: string, stat = lstatSync(path, { bigint: true })): CompletedArtifactIdentity {
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || stat.birthtimeNs <= 0n) managedUnavailable()
  return { path, type: stat.isDirectory() ? 'directory' : 'file', dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), birthtimeNs: String(stat.birthtimeNs), nlink: String(stat.nlink), mode: Number(stat.mode & 0o7777n) }
}
export function identityMatches(expected: CompletedArtifactIdentity, stat: BigIntStats, links?: string): void {
  const actual = observedIdentity(expected.path, stat)
  if (actual.type !== expected.type || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.uid !== expected.uid || actual.birthtimeNs !== expected.birthtimeNs || actual.mode !== expected.mode || actual.mode !== (actual.type === 'file' ? 0o600 : 0o700) || actual.uid !== String(process.getuid?.()) || links !== undefined && actual.nlink !== links) managedUnavailable()
}
function beneath(path: string, parent: string): boolean { const part = relative(parent, path); return part === '' || part !== '..' && !part.startsWith('../') && !part.startsWith('/') }
export function managedRoot(): CompletedArtifactIdentity {
  try {
    const configured = env.PUBLIC_SAFETY_MANAGED_ROOT || storagePath('app/private/public-safety-managed')
    const path = realpathSync(configured)
    const knownPublic = [publicPath(), storagePath('app/public')].map(value => { try { return realpathSync(value) } catch { return resolve(value) } })
    if (knownPublic.some(parent => beneath(path, parent))) managedUnavailable()
    const identity = observedIdentity(path)
    if (identity.type !== 'directory' || identity.uid !== String(process.getuid?.()) || identity.mode !== 0o700) managedUnavailable()
    return identity
  }
  catch { return managedUnavailable() }
}
export function sameRoot(expected: CompletedArtifactIdentity): void {
  const current = managedRoot()
  if (current.path !== expected.path) managedUnavailable()
  identityMatches(expected, lstatSync(current.path, { bigint: true }))
}
export function qualifiedReceipt(receipt: PreparedCompletedArtifactReceipt): void {
  for (const item of [receipt.parent, receipt.root, ...receipt.directories, ...receipt.files, receipt.pendingManifest]) {
    if (!/^[1-9]\d*$/.test(item.birthtimeNs) || BigInt(item.birthtimeNs) <= 0n) managedUnavailable()
  }
}
export interface FilePlan { id: number, ordinal: number, relative_path: string, planned_bytes: number, sha256: string, identity_json: string | null, role: string }
export interface FileObservation { id: number, bytes: number, sha256: string }
export interface ArtifactInspection { state: 'complete' | 'interrupted' | 'blocked', observed: FileObservation[] }

function readObserved(expected: CompletedArtifactIdentity, maximum: number, links: string, retain = false): { bytes: Uint8Array, size: number, hash: string } {
  const before = lstatSync(expected.path, { bigint: true })
  identityMatches(expected, before, links)
  if (before.size < 0n || before.size > BigInt(maximum) || maximum > managedBytes) managedUnavailable()
  const fd = openSync(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd, { bigint: true })
    identityMatches(expected, stat, links)
    if (stat.size !== before.size) managedUnavailable()
    const size = Number(stat.size), hash = createHash('sha256')
    const output = retain ? new Uint8Array(size) : new Uint8Array(0)
    const scratch = new Uint8Array(Math.min(65536, Math.max(size, 1)))
    let offset = 0
    while (offset < size) {
      const n = readSync(fd, scratch, 0, Math.min(scratch.length, size - offset), offset)
      if (n <= 0) managedUnavailable()
      hash.update(scratch.subarray(0, n))
      if (retain) output.set(scratch.subarray(0, n), offset)
      offset += n
    }
    if (readSync(fd, scratch, 0, 1, size) !== 0) managedUnavailable()
    identityMatches(expected, fstatSync(fd, { bigint: true }), links)
    identityMatches(expected, lstatSync(expected.path, { bigint: true }), links)
    if (fstatSync(fd, { bigint: true }).size !== BigInt(size)) managedUnavailable()
    return { bytes: output, size, hash: hash.digest('hex') }
  }
  finally { closeSync(fd) }
}
function missing(path: string): boolean {
  try { lstatSync(path); return false }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true; throw error }
}
function ledger(receipt: PreparedCompletedArtifactReceipt, files: readonly FilePlan[]): void {
  sameRoot(receipt.parent)
  qualifiedReceipt(receipt)
  if (dirname(receipt.directory) !== receipt.parent.path || receipt.root.path !== receipt.directory || receipt.completedManifest !== join(receipt.directory, 'manifest.json') || receipt.pendingManifest.path !== join(receipt.directory, 'manifest.pending.json') || files.length !== receipt.files.length + 1 || files.length > 771) managedUnavailable()
  for (const directory of [receipt.root, ...receipt.directories]) {
    if (!beneath(directory.path, receipt.directory)) managedUnavailable()
    identityMatches(directory, lstatSync(directory.path, { bigint: true }))
  }
  for (const file of files) {
    if (!/^[a-zA-Z0-9._/-]{1,240}$/.test(file.relative_path) || file.relative_path.split('/').some(part => !part || part === '.' || part === '..')) managedUnavailable()
    const expected = file.role === 'manifest' ? receipt.pendingManifest : receipt.files.find(item => item.path === join(receipt.directory, file.relative_path))
    if (!expected || expected.bytes !== file.planned_bytes || expected.sha256 !== file.sha256 || file.identity_json !== JSON.stringify(expected)) managedUnavailable()
  }
  // Reuse native conservative mount/process inspection; incomplete visibility is not safety evidence.
  if (!inspectTemporaryWorkspace(receipt.directory).unused) managedUnavailable()
}
export function inspectManagedArtifact(receipt: PreparedCompletedArtifactReceipt | null, target: string, files: readonly FilePlan[]): ArtifactInspection {
  try {
    if (!receipt) return { state: missing(target) ? 'interrupted' : 'blocked', observed: [] }
    if (receipt.directory !== target) managedUnavailable()
    ledger(receipt, files)
    const pending = !missing(receipt.pendingManifest.path), complete = !missing(receipt.completedManifest)
    if (!pending && !complete) managedUnavailable()
    const directories = [receipt.root, ...receipt.directories]
    const expected = new Map(directories.map(item => [item.path, [] as string[]]))
    for (const directory of receipt.directories) expected.get(dirname(directory.path))!.push(basename(directory.path))
    for (const file of receipt.files) expected.get(dirname(file.path))!.push(basename(file.path))
    if (pending) expected.get(receipt.directory)!.push('manifest.pending.json')
    if (complete) expected.get(receipt.directory)!.push('manifest.json')
    for (const [path, names] of expected) {
      const actual = readdirSync(path).sort(), wanted = names.sort()
      if (actual.length !== wanted.length || actual.some((name, i) => name !== wanted[i])) managedUnavailable()
    }
    let full = complete
    const observed: FileObservation[] = []
    for (const file of files) {
      const original = file.role === 'manifest' ? receipt.pendingManifest : receipt.files.find(item => item.path === join(receipt.directory, file.relative_path))!
      const item = file.role === 'manifest' && complete ? { ...original, path: receipt.completedManifest } : original
      const links = file.role === 'manifest' && pending && complete ? '2' : '1'
      const actual = readObserved(item, file.planned_bytes, links)
      if (file.role === 'manifest' && pending && complete) identityMatches(original, lstatSync(original.path, { bigint: true }), '2')
      if (actual.size !== file.planned_bytes || actual.hash !== file.sha256) full = false
      observed.push({ id: file.id, bytes: actual.size, sha256: actual.hash })
    }
    return { state: full ? 'complete' : 'interrupted', observed }
  }
  catch { return { state: 'blocked', observed: [] } }
}
export function readManagedBytes(receipt: PreparedCompletedArtifactReceipt, files: readonly FilePlan[], selected: FilePlan): Uint8Array {
  if (inspectManagedArtifact(receipt, receipt.directory, files).state !== 'complete') managedUnavailable()
  const original = selected.role === 'manifest' ? receipt.pendingManifest : receipt.files.find(item => item.path === join(receipt.directory, selected.relative_path))
  if (!original) managedUnavailable()
  const expected = selected.role === 'manifest' ? { ...original, path: receipt.completedManifest } : original
  const links = selected.role === 'manifest' && !missing(receipt.pendingManifest.path) ? '2' : '1'
  const actual = readObserved(expected, selected.planned_bytes, links, true)
  if (actual.size !== selected.planned_bytes || actual.hash !== selected.sha256) managedUnavailable()
  return actual.bytes
}

/** Read-only metadata continuity for a previously hashed bounded tree. No payload hashing under the final SQL lock. */
export function managedFingerprint(receipt: PreparedCompletedArtifactReceipt): string {
  sameRoot(receipt.parent)
  const paths = [receipt.parent.path, receipt.root.path, ...receipt.directories.map(item => item.path), ...receipt.files.map(item => item.path), receipt.pendingManifest.path, receipt.completedManifest]
  return sha256(JSON.stringify(paths.map(path => {
    try {
      const stat = lstatSync(path, { bigint: true })
      return [path, String(stat.dev), String(stat.ino), String(stat.birthtimeNs), String(stat.ctimeNs), String(stat.mtimeNs), String(stat.size), String(stat.mode), String(stat.nlink)]
    }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [path, null]; throw error }
  })))
}
