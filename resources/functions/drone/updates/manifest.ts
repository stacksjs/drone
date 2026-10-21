import type { TargetFile } from 'tuf-js'
import { imageLimit } from './files'
import type { RuntimeFirmwarePolicy } from './policy'

/** A completed metadata verification can still be refused by our explicit image policy. */
export class RuntimeManifestRejected extends Error {}

export function admitSignedRuntime(info: TargetFile, policy: RuntimeFirmwarePolicy) {
  const value = info.custom.drone
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeManifestRejected('Unsupported signed runtime manifest')
  const data = value as Record<string, unknown>
  const keys = ['schema', 'platform', 'protocolVersion', 'releaseSequence', 'sourceRevision', 'profile']
  if (Object.keys(data).length !== keys.length || !keys.every(key => Object.hasOwn(data, key)) || data.schema !== 'drone-runtime-image-v1' || data.profile !== 'neutral-bench') throw new RuntimeManifestRejected('Unsupported signed runtime manifest')
  if (data.platform !== policy.platform || data.protocolVersion !== 1) throw new RuntimeManifestRejected('Signed runtime platform or protocol does not match policy')
  if (!Number.isSafeInteger(data.releaseSequence) || (data.releaseSequence as number) < policy.minimumReleaseSequence) throw new RuntimeManifestRejected('Signed release is below the trusted minimum release sequence')
  if (typeof data.sourceRevision !== 'string' || !/^[a-f0-9]{40}$/.test(data.sourceRevision)) throw new RuntimeManifestRejected('Invalid signed source revision')
  if (!Number.isSafeInteger(info.length) || info.length < 1 || info.length > imageLimit || !/^[a-f0-9]{64}$/.test(info.hashes.sha256 ?? '')) throw new RuntimeManifestRejected('Runtime image requires a bounded length and SHA-256')
  return { releaseSequence: data.releaseSequence as number, sourceRevision: data.sourceRevision }
}
