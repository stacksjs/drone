import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Updater } from 'tuf-js'
import { directory, metadataLimit, regularFile, sha256, syncDirectory, writeExclusive } from './files'
import { object, validateMetadata } from './metadata'
import { admitPolicy } from './policy'
import type { RuntimeFirmwarePolicy } from './policy'

interface Enrollment {
  schema: 'drone-runtime-trust-enrollment-v1'
  enrollmentId: string
  policy: Readonly<RuntimeFirmwarePolicy>
  rootVersion: number
}
export interface RuntimeTrustSummary {
  schema: 'drone-runtime-trust-v1'
  enrollmentId: string
  enrollmentSha256: string
  policy: Readonly<RuntimeFirmwarePolicy>
  rootVersion: number
  metadataState: 'initial-root-only'
  metadataRefreshPerformed: false
  firmwareSelectionPerformed: false
  physicalDeploymentAllowed: false
}

function authenticatedRoot(path: string, policy: RuntimeFirmwarePolicy) {
  const root = regularFile(join(path, 'root.json'), metadataLimit)
  if (sha256(root) !== policy.trustedRootSha256) throw new Error('Trusted root SHA-256 does not match the independent pin')
  validateMetadata(root)
  // The public constructor verifies root self-signatures. Never refresh against the
  // enrollment directory: it is the immutable anchor, not the SDK's writable cache.
  new Updater({ metadataDir: path, metadataBaseUrl: 'http://127.0.0.1/unused-enrollment-only/' })
  return object(object(JSON.parse(root.toString('utf8'))).signed).version as number
}
function summary(enrollment: Enrollment, enrollmentSha256: string): Readonly<RuntimeTrustSummary> {
  return Object.freeze({ ...enrollment, schema: 'drone-runtime-trust-v1', enrollmentSha256, metadataState: 'initial-root-only', metadataRefreshPerformed: false, firmwareSelectionPerformed: false, physicalDeploymentAllowed: false })
}

/** Persist an independently authenticated initial anchor and policy, without metadata refresh or deployment. */
export function enrollRuntimeTrust(options: RuntimeFirmwarePolicy & { trustedRoot: string, output: string }): Readonly<RuntimeTrustSummary> {
  const policy = admitPolicy(options), output = resolve(options.output)
  const root = regularFile(options.trustedRoot, metadataLimit)
  if (sha256(root) !== policy.trustedRootSha256) throw new Error('Trusted root SHA-256 does not match the independent pin')
  validateMetadata(root)
  directory(dirname(output))
  mkdirSync(output, { mode: 0o700 })
  writeExclusive(join(output, 'root.json'), root)
  const rootVersion = authenticatedRoot(output, policy)
  const enrollment: Enrollment = { schema: 'drone-runtime-trust-enrollment-v1', enrollmentId: randomBytes(16).toString('hex'), policy, rootVersion }
  syncDirectory(output)
  const bytes = Buffer.from(`${JSON.stringify(enrollment, null, 2)}\n`)
  writeExclusive(join(output, 'enrollment.json'), bytes)
  syncDirectory(output)
  syncDirectory(dirname(output))
  return summary(enrollment, sha256(bytes))
}

/** Independently verify an enrollment. A hash read from the same directory is not an independent trust pin. */
export function inspectRuntimeTrust(options: { directory: string, enrollmentSha256: string }): Readonly<RuntimeTrustSummary> {
  const path = resolve(options.directory), expected = options.enrollmentSha256
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw new TypeError('Provide the independently retained enrollment SHA-256')
  directory(dirname(path))
  directory(path)
  const bytes = regularFile(join(path, 'enrollment.json'), 16384)
  if (sha256(bytes) !== expected) throw new Error('Enrollment SHA-256 does not match the independent pin')
  const record = object(JSON.parse(bytes.toString('utf8')))
  const keys = ['schema', 'enrollmentId', 'policy', 'rootVersion']
  if (record.schema !== 'drone-runtime-trust-enrollment-v1' || Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) || typeof record.enrollmentId !== 'string' || !/^[a-f0-9]{32}$/.test(record.enrollmentId)) throw new Error('Invalid runtime trust enrollment')
  const input = object(record.policy), policyKeys = ['target', 'platform', 'trustedRootSha256', 'minimumReleaseSequence']
  if (Object.keys(input).length !== policyKeys.length || !policyKeys.every(key => Object.hasOwn(input, key)) || typeof input.target !== 'string' || typeof input.trustedRootSha256 !== 'string' || typeof input.minimumReleaseSequence !== 'number' || (input.platform !== 'pico2-neutral-bench-v1' && input.platform !== 'host-neutral-bench-v1')) throw new Error('Invalid enrolled trust policy')
  const policy = admitPolicy({ target: input.target, platform: input.platform, trustedRootSha256: input.trustedRootSha256, minimumReleaseSequence: input.minimumReleaseSequence })
  const rootVersion = authenticatedRoot(path, policy)
  if (rootVersion !== record.rootVersion) throw new Error('Enrolled root version does not match authenticated bytes')
  return summary({ schema: 'drone-runtime-trust-enrollment-v1', enrollmentId: record.enrollmentId, policy, rootVersion }, expected)
}
