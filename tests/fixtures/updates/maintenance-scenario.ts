import assert from 'node:assert/strict'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeTrustStore, refreshRuntimeTrustStore } from '../../../resources/functions/drone/updates/store'
import { platform, repository, target } from './repository'

/** Real signed release 9 followed by a deliberately wrong-key targets signature. */
export async function maintenanceScenario(root: string, clock = { source: 'independent-maintenance-clock', read: () => new Date('2030-01-01T00:00:00Z') }) {
  const source = join(root, 'repository'), signed = await repository(source, { custom: { releaseSequence: 9 } })
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
  const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
  const reference = { directory: join(root, 'store'), enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }
  const good = await refreshRuntimeTrustStore({ ...reference, repository: source, clock })
  await signed.publish({ image: signed.image, version: 2, custom: { releaseSequence: 9 }, badTargetsSignature: true })
  await assert.rejects(refreshRuntimeTrustStore({ ...reference, repository: source, clock }))
  const failed = await inspectRuntimeTrustStore(reference)
  return { source, signed, reference, clock, good, failed }
}
