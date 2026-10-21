import type { RuntimeFirmwarePolicy } from './staging'

export const firmwarePolicyFlags = {
  '--target <path>': 'Explicit signed target path inside the offline repository',
  '--platform <name>': 'Expected pico2-neutral-bench-v1 or host-neutral-bench-v1 platform',
  '--root-sha256 <hex>': 'Independently trusted SHA-256 of the initial root metadata',
  '--minimum-release-sequence <n>': 'Explicit externally trusted positive release floor',
} as const

export function firmwareCommandPolicy(options: { target?: unknown, platform?: unknown, rootSha256?: unknown, minimumReleaseSequence?: unknown }): RuntimeFirmwarePolicy {
  if (typeof options.target !== 'string' || typeof options.rootSha256 !== 'string' || typeof options.minimumReleaseSequence !== 'string' || !/^[1-9]\d{0,15}$/.test(options.minimumReleaseSequence)) throw new Error('Explicit target, root pin and trusted release floor are required')
  if (options.platform !== 'pico2-neutral-bench-v1' && options.platform !== 'host-neutral-bench-v1') throw new Error('Explicit implemented bench platform required')
  return { target: options.target, platform: options.platform, trustedRootSha256: options.rootSha256, minimumReleaseSequence: Number(options.minimumReleaseSequence) }
}
