import { createHash, randomBytes } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { canonicalize } from '@tufjs/canonical-json'
import { Updater } from 'tuf-js'
import type { TargetFile } from 'tuf-js'

const metadataLimit = 512 * 1024
const imageLimit = 16 * 1024 * 1024
const originPrefix = '/offline-'
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export interface RuntimeFirmwarePolicy {
  target: string
  platform: 'pico2-neutral-bench-v1' | 'host-neutral-bench-v1'
  trustedRootSha256: string
  /** Explicit externally trusted floor. This module does not persist or advance it. */
  minimumReleaseSequence: number
}
export interface RuntimeFirmwareStage {
  schema: 'drone-runtime-stage-v1'
  target: string
  platform: RuntimeFirmwarePolicy['platform']
  trustedRootSha256: string
  rootVersion: number
  releaseSequence: number
  protocolVersion: 1
  sourceRevision: string
  signerDeclaredProfile: 'neutral-bench'
  length: number
  sha256: string
  physicalDeploymentAllowed: false
  trustStatePersisted: false
}

function admitPolicy(input: RuntimeFirmwarePolicy): Readonly<RuntimeFirmwarePolicy> {
  const policy = { target: input.target, platform: input.platform, trustedRootSha256: input.trustedRootSha256, minimumReleaseSequence: input.minimumReleaseSequence }
  if (process.platform === 'win32') throw new Error('Firmware staging requires a POSIX filesystem')
  safePath(policy.target)
  if (policy.platform !== 'pico2-neutral-bench-v1' && policy.platform !== 'host-neutral-bench-v1') throw new TypeError('Select an implemented bench platform')
  if (typeof policy.trustedRootSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(policy.trustedRootSha256)) throw new TypeError('Provide the independently trusted root SHA-256')
  if (!Number.isSafeInteger(policy.minimumReleaseSequence) || policy.minimumReleaseSequence < 1) throw new TypeError('Provide a positive trusted minimum release sequence')
  return Object.freeze(policy)
}
function safePath(path: string) {
  if (typeof path !== 'string' || path.length > 256 || !path.split('/').every(part => /^[a-z0-9][a-z0-9._-]{0,179}$/i.test(part) && part !== '.' && part !== '..')) throw new TypeError('Unsafe offline repository path')
}
function regularFile(path: string, limit: number): Buffer {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > limit) throw new Error('Expected a nonempty bounded regular file')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 1 || stat.size > limit || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Expected the same bounded regular file')
    const bytes = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset !== stat.size) throw new Error('Source file changed length while reading')
    return bytes.subarray(0, offset)
  }
  finally { closeSync(fd) }
}
function directory(path: string) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected a real directory')
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) throw new Error('Repository and candidate directories must be owned and not writable by other principals')
}
function repositoryFile(root: string, path: string, limit: number) {
  safePath(path)
  directory(root)
  const parts = path.split('/')
  for (let i = 1; i < parts.length; i++) directory(join(root, ...parts.slice(0, i)))
  return regularFile(join(root, ...parts), limit)
}
function writeExclusive(path: string, bytes: Uint8Array) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    let offset = 0
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset)
      if (count <= 0) throw new Error('No progress writing firmware candidate')
      offset += count
    }
    fsyncSync(fd)
  }
  finally { closeSync(fd) }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) }
  finally { closeSync(fd) }
}
function syncTree(path: string) {
  directory(path)
  for (const name of readdirSync(path)) {
    const child = join(path, name), stat = lstatSync(child)
    if (stat.isDirectory()) syncTree(child)
    else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected candidate entry')
      const fd = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(fd) }
      finally { closeSync(fd) }
    }
  }
  syncDirectory(path)
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid signed runtime metadata')
  return value as Record<string, unknown>
}
function validateMetadataKeyIDs(bytes: Buffer) {
  const signed = object(object(JSON.parse(bytes.toString('utf8'))).signed)
  const keys = signed._type === 'root' ? object(signed.keys) : signed._type === 'targets' && signed.delegations !== undefined ? object(object(signed.delegations).keys) : undefined
  // The SDK verifies signatures by key ID but does not recompute the ID. Reject arbitrary
  // identifier aliases by binding each declared ID to the canonical key object.
  for (const [id, key] of Object.entries(keys ?? {})) {
    if (id !== sha256(Buffer.from(canonicalize(object(key))))) throw new Error('TUF key identifier does not match canonical key data')
  }
}
function signedRuntime(info: TargetFile, policy: RuntimeFirmwarePolicy) {
  const data = object(info.custom.drone)
  const keys = ['schema', 'platform', 'protocolVersion', 'releaseSequence', 'sourceRevision', 'profile']
  if (Object.keys(data).length !== keys.length || !keys.every(key => Object.hasOwn(data, key)) || data.schema !== 'drone-runtime-image-v1' || data.profile !== 'neutral-bench') throw new Error('Unsupported signed runtime manifest')
  if (data.platform !== policy.platform || data.protocolVersion !== 1) throw new Error('Signed runtime platform or protocol does not match policy')
  if (!Number.isSafeInteger(data.releaseSequence) || (data.releaseSequence as number) < policy.minimumReleaseSequence) throw new Error('Signed release is below the trusted minimum release sequence')
  if (typeof data.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(data.sourceRevision)) throw new Error('Invalid signed source revision')
  if (!Number.isSafeInteger(info.length) || info.length < 1 || info.length > imageLimit || !/^[a-f0-9]{64}$/.test(info.hashes.sha256 ?? '')) throw new Error('Runtime image requires a bounded length and SHA-256')
  return { releaseSequence: data.releaseSequence as number, sourceRevision: data.sourceRevision }
}

/** Use the SDK's public HTTP interface on a private loopback server. No external fetch is performed. */
async function verifyRepository(repository: string, root: Buffer, work: string, policy: RuntimeFirmwarePolicy, download?: string) {
  validateMetadataKeyIDs(root)
  const fetched = new Map<string, Buffer>()
  let requests = 0, received = 0
  const prefix = `${originPrefix}${randomBytes(32).toString('hex')}/`
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'GET' || url.search || !url.pathname.startsWith(prefix)) return new Response(null, { status: 404 })
      if (++requests > 64) return new Response(null, { status: 429 })
      const path = url.pathname.slice(prefix.length)
      try {
        safePath(path)
        if (!path.startsWith('targets/') && !/^metadata\/[a-z0-9][a-z0-9._-]{0,179}\.json$/i.test(path)) throw new Error('Unsupported metadata path')
        let bytes = fetched.get(path)
        if (!bytes) {
          bytes = repositoryFile(repository, path, path.startsWith('metadata/') ? metadataLimit : imageLimit)
          if (path.startsWith('metadata/')) validateMetadataKeyIDs(bytes)
          received += bytes.length
          if (received > 32 * 1024 * 1024) throw new Error('Repository byte budget exceeded')
          fetched.set(path, bytes)
        }
        return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } })
      }
      catch (error) {
        // Only an absent file is a TUF 404. Rejected devices, symlinks and IO failures must fail refresh.
        return new Response(null, { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500 })
      }
    },
  })
  try {
    mkdirSync(work, { mode: 0o700 })
    writeExclusive(join(work, 'root.json'), root)
    const base = `http://127.0.0.1:${server.port}${prefix}`
    const updater = new Updater({ metadataDir: work, metadataBaseUrl: `${base}metadata/`, targetBaseUrl: `${base}targets/`, config: { maxRootRotations: 16, maxDelegations: 16, rootMaxLength: metadataLimit, timestampMaxLength: metadataLimit, snapshotMaxLength: metadataLimit, targetsMaxLength: metadataLimit, fetchTimeout: 5000, fetchRetry: false } })
    await updater.refresh()
    const info = await updater.getTargetInfo(policy.target)
    if (!info) throw new Error('Selected firmware target is absent')
    const runtime = signedRuntime(info, policy)
    if (download) await updater.downloadTarget(info, download)
    const latest = object(JSON.parse(regularFile(join(work, 'root.json'), metadataLimit).toString('utf8')))
    const rootVersion = object(latest.signed).version
    if (!Number.isSafeInteger(rootVersion)) throw new Error('Invalid verified root version')
    const result: RuntimeFirmwareStage = { schema: 'drone-runtime-stage-v1', target: policy.target, platform: policy.platform, trustedRootSha256: policy.trustedRootSha256, rootVersion: rootVersion as number, ...runtime, protocolVersion: 1, signerDeclaredProfile: 'neutral-bench', length: info.length, sha256: info.hashes.sha256!, physicalDeploymentAllowed: false, trustStatePersisted: false }
    return { result, fetched, info }
  }
  finally { await server.stop(true) }
}

/** Exclusive offline candidate only. This never changes installed firmware, boot slots or trust floors. */
export async function stageRuntimeFirmware(options: RuntimeFirmwarePolicy & { repository: string, trustedRoot: string, output: string }): Promise<RuntimeFirmwareStage> {
  const policy = admitPolicy(options)
  const repository = realpathSync(options.repository), output = resolve(options.output)
  directory(repository)
  const root = regularFile(options.trustedRoot, metadataLimit)
  if (sha256(root) !== policy.trustedRootSha256) throw new Error('Trusted root SHA-256 does not match the independent pin')
  // Resolve the existing parent before creating anything, so a symlinked parent cannot hide overlap.
  const destination = join(realpathSync(dirname(output)), output.slice(dirname(output).length + 1))
  const child = relative(repository, destination), parent = relative(destination, repository)
  if (!child || (!child.startsWith(`..${sep}`) && child !== '..') || (!parent.startsWith(`..${sep}`) && parent !== '..')) throw new Error('Candidate and source repository must be separate')
  mkdirSync(output, { mode: 0o700 })
  writeExclusive(join(output, 'trust-root.json'), root)
  const { result, fetched, info } = await verifyRepository(repository, root, join(output, '.verification'), policy, join(output, 'image.bin'))
  // Re-read the actual staged bytes, rather than trusting a successful copy or receipt.
  await info.verify(Readable.from(regularFile(join(output, 'image.bin'), imageLimit)))
  for (const [path, bytes] of fetched) {
    const file = join(output, 'repository', path)
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeExclusive(file, bytes)
  }
  syncTree(output)
  // A final marker means logical completeness. It cannot attest to power-loss durability after fsync.
  writeExclusive(join(output, 'stage.json'), Buffer.from(`${JSON.stringify(result, null, 2)}\n`))
  syncDirectory(output)
  syncDirectory(dirname(output))
  return result
}

/** Re-authenticate staged metadata and image using caller-supplied trust/policy, never a self-asserted receipt. */
export async function inspectStagedRuntimeFirmware(options: RuntimeFirmwarePolicy & { directory: string }): Promise<RuntimeFirmwareStage> {
  const policy = admitPolicy(options), candidate = resolve(options.directory)
  directory(candidate)
  const receipt: unknown = JSON.parse(regularFile(join(candidate, 'stage.json'), 16384).toString('utf8'))
  const root = regularFile(join(candidate, 'trust-root.json'), metadataLimit)
  if (sha256(root) !== policy.trustedRootSha256) throw new Error('Trusted root SHA-256 does not match the independent pin')
  const work = mkdtempSync(join(tmpdir(), 'drone-update-inspect-'))
  try {
    const { result, info } = await verifyRepository(join(candidate, 'repository'), root, join(work, 'metadata'), policy)
    await info.verify(Readable.from(regularFile(join(candidate, 'image.bin'), imageLimit)))
    if (!isDeepStrictEqual(receipt, result)) throw new Error('Staged receipt does not match re-authenticated image metadata')
    return result
  }
  finally { rmSync(work, { recursive: true, force: true }) }
}
