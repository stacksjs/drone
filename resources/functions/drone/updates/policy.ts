import { safePath } from './files'

export interface RuntimeFirmwarePolicy {
  target: string
  platform: 'pico2-neutral-bench-v1' | 'host-neutral-bench-v1'
  trustedRootSha256: string
  /** Explicit externally trusted floor. Staging never advances it. */
  minimumReleaseSequence: number
}
export function admitPolicy(input: RuntimeFirmwarePolicy): Readonly<RuntimeFirmwarePolicy> {
  const policy = { target: input.target, platform: input.platform, trustedRootSha256: input.trustedRootSha256, minimumReleaseSequence: input.minimumReleaseSequence }
  if (process.platform === 'win32') throw new Error('Firmware staging requires a POSIX filesystem')
  safePath(policy.target)
  if (policy.platform !== 'pico2-neutral-bench-v1' && policy.platform !== 'host-neutral-bench-v1') throw new TypeError('Select an implemented bench platform')
  if (typeof policy.trustedRootSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(policy.trustedRootSha256)) throw new TypeError('Provide the independently trusted root SHA-256')
  if (!Number.isSafeInteger(policy.minimumReleaseSequence) || policy.minimumReleaseSequence < 1) throw new TypeError('Provide a positive trusted minimum release sequence')
  return Object.freeze(policy)
}
