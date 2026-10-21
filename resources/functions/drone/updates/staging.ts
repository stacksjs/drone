import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import { Updater } from 'tuf-js'
import { directory, imageLimit, metadataLimit, regularFile, repositoryFile, safePath, sha256, writeExclusive } from './files'
import { object, validateMetadata } from './metadata'
import { admitSignedRuntime } from './manifest'
import { finishRuntimeCandidate, runtimeCandidateOutput } from './candidate-files'
import { admitPolicy } from './policy'
import type { RuntimeFirmwarePolicy } from './policy'
export type { RuntimeFirmwarePolicy } from './policy'

const originPrefix = '/offline-'

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


/** Use the SDK's public HTTP interface on a private loopback server. No external fetch is performed. */
async function verifyRepository(repository: string, root: Buffer, work: string, policy: RuntimeFirmwarePolicy, download?: string) {
  validateMetadata(root)
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
          if (path.startsWith('metadata/')) validateMetadata(bytes)
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
    const runtime = admitSignedRuntime(info, policy)
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
  const repository = realpathSync(options.repository), output = runtimeCandidateOutput(options.output, [repository])
  directory(repository)
  const root = regularFile(options.trustedRoot, metadataLimit)
  if (sha256(root) !== policy.trustedRootSha256) throw new Error('Trusted root SHA-256 does not match the independent pin')
  mkdirSync(output, { mode: 0o700 })
  writeExclusive(join(output, 'trust-root.json'), root)
  const { result, fetched, info } = await verifyRepository(repository, root, join(output, '.verification'), policy, join(output, 'image.bin'))
  await finishRuntimeCandidate(output, info, result, fetched)
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
