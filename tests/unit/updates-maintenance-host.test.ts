import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { continueRuntimeTrustMaintenance, createRuntimeTrustStore, inspectRuntimeFirmwareSlots, inspectRuntimeTrustStore, refreshRuntimeTrustStore, reserveRuntimeFirmwareCandidate, trialRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'
import { createHostSourceProject } from '../fixtures/updates/host-project'
import { repository, target } from '../fixtures/updates/repository'

test('format-4 maintenance preserves the known-good image and needs a fresh actual host session for new confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-maintenance-host-'))
  let completed = false
  try {
    const { project, sourceRevision } = await createHostSourceProject(root)
    const built = await buildRuntime({ project }), image = await readFile(built.artifact)
    const source = join(root, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision, releaseSequence: 9 } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
    const reference = { directory: join(root, 'store'), enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-maintenance-host-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const candidate = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const good = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: candidate.candidate!.id })
    const previousImage = join(reference.directory, 'host-slots', good.knownGood!.id, 'image.bin')
    await signed.publish({ image, version: 2, custom: { releaseSequence: 9 }, badTargetsSignature: true })
    await expect(refreshRuntimeTrustStore({ ...reference, repository: source, clock })).rejects.toThrow()
    const failed = await inspectRuntimeTrustStore(reference)
    await signed.publish({ image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
    await continueRuntimeTrustMaintenance({ ...reference, repository: source, clock, previousAttemptId: failed.attempt!.id, acknowledgeUnresolvedInputs: true })
    const maintained = await inspectRuntimeFirmwareSlots(reference)
    expect(maintained.stateFormat).toBe(4)
    expect(maintained.knownGood).toEqual(good.knownGood)
    expect(maintained.installed).toEqual(good.installed)
    expect(await readFile(previousImage)).toEqual(image)
    const next = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const fresh = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: next.candidate!.id })
    expect(fresh.stateFormat).toBe(4)
    expect(fresh.knownGood!.id).not.toBe(good.knownGood!.id)
    expect(fresh.knownGood!.health!.bootId).not.toBe(good.knownGood!.health!.bootId)
    expect(fresh.knownGood!.health!.sessionId).not.toBe(good.knownGood!.health!.sessionId)
    expect(fresh.knownGood!.health!.cleanProcessExit).toBe(true)
    expect(fresh.store.releaseFloor).toBe(9)
    expect(fresh.store.maintenanceHandoffs[0]!.previousAttempt).toEqual(failed.attempt!)
    expect(await readFile(previousImage)).toEqual(image)
    expect(fresh.physicalDeploymentAllowed).toBe(false)
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed maintenance host case retained at ${root}`)
  }
}, 120000)
