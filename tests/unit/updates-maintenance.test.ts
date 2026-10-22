import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { continueRuntimeTrustMaintenance, createRuntimeTrustStore, inspectRuntimeFirmwareCandidates, inspectRuntimeFirmwareSlots, inspectRuntimeTrustStore, recoverRuntimeTrustStore, refreshRuntimeTrustStore, reserveRuntimeFirmwareCandidate, retireRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'
import { platform, repository, target } from '../fixtures/updates/repository'
import { maintenanceScenario } from '../fixtures/updates/maintenance-scenario'

// Existing public coordinator seam: retain an unresolved rejection while a fully
// authenticated fresh successor succeeds. This does not repair a lost trust root.
test('explicit maintenance retains rejected input and security floors while fresh signed key rotation completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-update-maintenance-'))
  let completed = false
  try {
    const source = join(root, 'repository'), signed = await repository(source, { custom: { releaseSequence: 9 } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
    const reference = { directory: join(root, 'store'), enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-maintenance-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const good = await refreshRuntimeTrustStore({ ...reference, repository: source, clock })
    expect(good.releaseFloor).toBe(9)
    await signed.publish({ image: signed.image, version: 2, custom: { releaseSequence: 9 }, badTargetsSignature: true })
    await expect(refreshRuntimeTrustStore({ ...reference, repository: source, clock })).rejects.toThrow()
    const failed = await inspectRuntimeTrustStore(reference)
    expect(failed.attempt!.phase).toBe('maintenance')
    expect(failed.attempt!.inputRecords).toBeGreaterThan(0)
    await expect(recoverRuntimeTrustStore(reference)).rejects.toThrow()
    expect(await inspectRuntimeTrustStore(reference)).toEqual(failed)
    await signed.publish({ image: signed.image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
    const fresh = await continueRuntimeTrustMaintenance({ ...reference, repository: source, clock, previousAttemptId: failed.attempt!.id, acknowledgeUnresolvedInputs: true })
    expect(fresh.attempt!.phase).toBe('verified')
    expect(fresh.attempt!.id).not.toBe(failed.attempt!.id)
    expect(fresh.maintenanceHandoffs).toEqual([{ previousAttempt: failed.attempt!, nextAttemptId: fresh.attempt!.id, generation: failed.generation }])
    expect(fresh.releaseFloor).toBe(9)
    expect(fresh.storeSha256).toBe(reference.storeSha256)
    expect(fresh.enrollmentSha256).toBe(reference.enrollmentSha256)
    expect(fresh.clockFloorMs).toBe(failed.clockFloorMs)
    expect(fresh.retainedMetadataRecords).toBeGreaterThan(failed.retainedMetadataRecords)
    expect(fresh.metadata.map(row => [row.role, row.version])).toEqual([['root', 2], ['snapshot', 3], ['targets', 3], ['timestamp', 3]])
    expect(fresh.physicalDeploymentAllowed).toBe(false)
    const slots = await inspectRuntimeFirmwareSlots(reference)
    expect(slots.stateFormat).toBe(4)
    expect(slots.knownGood).toBeNull()
    expect(slots.installed).toBeNull()
    expect(await inspectRuntimeTrustStore(reference)).toEqual(fresh)
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed maintenance case retained at ${root}`)
  }
}, 30000)

test('format-2 maintenance preserves the prepared candidate until explicit retirement and a new reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-maintenance-candidate-'))
  let completed = false
  try {
    const source = join(root, 'repository'), signed = await repository(source, { custom: { releaseSequence: 9 } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
    const reference = { directory: join(root, 'store'), enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-candidate-maintenance-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const prepared = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    expect(prepared.stateFormat).toBe(2)
    await signed.publish({ image: signed.image, version: 2, custom: { releaseSequence: 9 }, badTargetsSignature: true })
    await expect(refreshRuntimeTrustStore({ ...reference, repository: source, clock })).rejects.toThrow()
    const failed = await inspectRuntimeTrustStore(reference)
    await signed.publish({ image: signed.image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
    await continueRuntimeTrustMaintenance({ ...reference, repository: source, clock, previousAttemptId: failed.attempt!.id, acknowledgeUnresolvedInputs: true })
    const retained = await inspectRuntimeFirmwareCandidates(reference)
    expect(retained.stateFormat).toBe(4)
    expect(retained.candidate).toEqual(prepared.candidate)
    expect(retained.store.storeSha256).toBe(reference.storeSha256)
    expect(retained.store.enrollmentSha256).toBe(reference.enrollmentSha256)
    expect((await inspectRuntimeFirmwareSlots(reference)).knownGood).toBeNull()
    await expect(reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })).rejects.toThrow('active candidate')
    await retireRuntimeFirmwareCandidate({ ...reference, candidateId: prepared.candidate!.id })
    const next = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    expect(next.candidate!.id).not.toBe(prepared.candidate!.id)
    expect(next.candidate!.description.rootVersion).toBe(2)
    expect(next.store.releaseFloor).toBe(9)
    expect(await readFile(join(prepared.candidate!.directory, 'image.bin'))).toEqual(signed.image)
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed format-2 maintenance case retained at ${root}`)
  }
}, 30000)

test('a rejected maintenance successor keeps the original history and blocks ordinary refresh until explicit recovery or continuation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-maintenance-rejection-'))
  let completed = false
  try {
    const item = await maintenanceScenario(root)
    const options = { ...item.reference, repository: item.source, clock: item.clock, previousAttemptId: item.failed.attempt!.id, acknowledgeUnresolvedInputs: true as const }
    await item.signed.publish({ image: item.signed.image, version: 3, custom: { releaseSequence: 8 }, rotateTargets: true })
    await expect(continueRuntimeTrustMaintenance(options)).rejects.toThrow('below the trusted minimum')
    const rejected = await inspectRuntimeTrustStore(item.reference)
    expect(rejected.releaseFloor).toBe(9)
    expect(rejected.attempt!.phase).toBe('maintenance')
    expect(rejected.attempt!.id).not.toBe(item.failed.attempt!.id)
    expect(rejected.maintenanceHandoffs[0]!.previousAttempt).toEqual(item.failed.attempt!)
    await expect(refreshRuntimeTrustStore({ ...item.reference, repository: item.source, clock: item.clock })).rejects.toThrow('requires recovery')
    await expect(continueRuntimeTrustMaintenance(options)).rejects.toThrow('Exact unresolved')
    await expect(continueRuntimeTrustMaintenance({ ...options, previousAttemptId: rejected.attempt!.id, clock: { source: 'reversed-maintenance-clock', read: () => new Date('2029-01-01T00:00:00Z') } })).rejects.toThrow('reversed')
    expect(await inspectRuntimeTrustStore(item.reference)).toEqual(rejected)
    await item.signed.publish({ image: item.signed.image, version: 4, custom: { releaseSequence: 9 } })
    const verified = await continueRuntimeTrustMaintenance({ ...options, previousAttemptId: rejected.attempt!.id })
    expect(verified.maintenanceHandoffs).toHaveLength(2)
    expect(verified.maintenanceHandoffs[0]!.previousAttempt).toEqual(item.failed.attempt!)
    expect(verified.maintenanceHandoffs[1]!.previousAttempt).toEqual(rejected.attempt!)
    expect(verified.maintenanceHandoffs[1]!.nextAttemptId).toBe(verified.attempt!.id)
    expect(verified.attempt!.phase).toBe('verified')
    expect(verified.releaseFloor).toBe(9)
    expect(verified.physicalDeploymentAllowed).toBe(false)
    expect((await refreshRuntimeTrustStore({ ...item.reference, repository: item.source, clock: item.clock })).attempt!.phase).toBe('verified')
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed maintenance rejection retained at ${root}`)
  }
}, 30000)
