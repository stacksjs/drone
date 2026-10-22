import type { RuntimeFirmwarePolicy } from './staging'
import { printErrorAsync } from '../../cli/output'

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

export const storeEnrollmentFlags = {
  '--enrollment <path>': 'Immutable independently authenticated initial trust enrollment',
  '--enrollment-sha256 <hex>': 'Independently retained enrollment record SHA-256',
} as const
export const storeReferenceFlags = { ...storeEnrollmentFlags, '--store-sha256 <hex>': 'Independently retained update-store identity SHA-256' } as const
export const hostTrialFlags = {
  ...storeReferenceFlags,
  '--repository <path>': 'Bounded offline signed-image repository',
  '--trusted-system-clock-source <name>': 'Audit label for the independently managed system clock, not an attestation',
  '--project <path>': 'Explicit trusted clean local firmware source checkout matching the signed revision',
} as const

export function storeCommandEnrollment(options: { enrollment?: unknown, enrollmentSha256?: unknown }) {
  if (typeof options.enrollment !== 'string' || typeof options.enrollmentSha256 !== 'string') throw new Error('Explicit enrollment and independent enrollment pin required')
  return { enrollmentDirectory: options.enrollment, enrollmentSha256: options.enrollmentSha256 }
}
export function storeCommandReference(options: { enrollment?: unknown, enrollmentSha256?: unknown, storeSha256?: unknown }, directory: string) {
  if (typeof options.storeSha256 !== 'string') throw new Error('Explicit independent store pin required')
  return { ...storeCommandEnrollment(options), directory, storeSha256: options.storeSha256 }
}
export function hostTrialCommandOptions(options: { enrollment?: unknown, enrollmentSha256?: unknown, storeSha256?: unknown, repository?: unknown, trustedSystemClockSource?: unknown, project?: unknown }, directory: string) {
  if (typeof options.repository !== 'string' || typeof options.trustedSystemClockSource !== 'string' || typeof options.project !== 'string') throw new Error('Explicit repository, independent system-clock source and trusted project required')
  return { ...storeCommandReference(options, directory), repository: options.repository, project: options.project, clock: { source: options.trustedSystemClockSource, read: () => new Date() } }
}
export async function storeCommandFailure() {
  process.exitCode = 1
  try { await printErrorAsync('Runtime update store unavailable: invalid trust, clock, state or storage failure') }
  catch { /* Keep exit 1 if the diagnostic pipe also fails. */ }
}
