import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { inspectStagedRuntimeFirmware } from '../../resources/functions/drone/updates/staging'
import { createRuntimeTrustStore, inspectRuntimeTrustStore, prepareRuntimeFirmwareUpdate, recoverRuntimeTrustStore, refreshRuntimeTrustStore } from '../../resources/functions/drone/updates/store'
import { platform, repository, target } from '../fixtures/updates/repository'
import { qualifyPreparationInterruptions } from '../fixtures/updates/store-interruptions'
import { epochRepository } from '../fixtures/updates/epochs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const clock = { source: 'test-independent-clock', read: () => new Date('2030-01-01T00:00:00Z') }
async function setup(options: Parameters<typeof repository>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drone-prepare-update-')); roots.push(root)
  const source = join(root, 'repo'), fixture = await repository(source, { ...options, custom: { releaseSequence: 9, ...options.custom } })
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
  return { root, source, fixture, reference: { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory: join(root, 'store'), storeSha256: created.storeSha256 }, output: join(root, 'candidate') }
}

test('protected preparation authenticates actual image bytes and writes an independently verifiable signed candidate', async () => {
  const item = await setup()
  const result = await prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: item.output, clock })
  expect(result.schema).toBe('drone-runtime-prepared-image-v1')
  expect(result.store.generation).toBe(3)
  expect(result.store.releaseFloor).toBe(9)
  expect(result.store.attempt?.phase).toBe('verified')
  expect(result.candidate.sha256).toBe(item.fixture.imageHash)
  expect(result.candidate.length).toBe(item.fixture.image.length)
  expect(result.trustStatePersisted).toBe(true)
  expect(result.physicalDeploymentAllowed).toBe(false)
  expect(result.candidate.trustStatePersisted).toBe(false)
  expect(await inspectStagedRuntimeFirmware({ directory: item.output, target, platform, trustedRootSha256: item.fixture.rootSha256, minimumReleaseSequence: 9 })).toEqual(result.candidate)
  expect(await inspectRuntimeTrustStore(item.reference)).toEqual(result.store)
})

test('a rotated protected root and cached metadata produce a candidate without depending on the initial root chain', async () => {
  const item = await setup({ rotate: true })
  const current = await refreshRuntimeTrustStore({ ...item.reference, repository: item.source, clock })
  const protectedRoot = current.metadata.find(row => row.role === 'root')!
  expect(protectedRoot.version).toBe(2)
  const result = await prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: item.output, clock })
  expect(result.candidate.trustedRootSha256).toBe(protectedRoot.sha256)
  expect(result.candidate.rootVersion).toBe(2)
  expect(result.store.releaseFloor).toBe(9)
  await rename(item.source, join(item.root, 'offline'))
  expect(await inspectStagedRuntimeFirmware({ directory: item.output, target, platform, trustedRootSha256: protectedRoot.sha256, minimumReleaseSequence: 9 })).toEqual(result.candidate)
  await expect(inspectStagedRuntimeFirmware({ directory: item.output, target, platform, trustedRootSha256: item.fixture.rootSha256, minimumReleaseSequence: 9 })).rejects.toThrow('independent pin')
})

test('an actual output collision after metadata acceptance preserves the release floor and the competing files', async () => {
  const item = await setup()
  const failure = await prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: item.output, clock, async onProgress(event) {
    if (event.phase === 'metadata-committed' && event.ordinal === 2) {
      await mkdir(item.output)
      await writeFile(join(item.output, 'contender.txt'), 'Preserve the competing output\n')
    }
  } }).then(() => undefined, error => error)
  expect(failure.code).toBe('EEXIST')
  expect(await readFile(join(item.output, 'contender.txt'), 'utf8')).toBe('Preserve the competing output\n')
  await expect(stat(join(item.output, 'stage.json'))).rejects.toHaveProperty('code', 'ENOENT')
  const stopped = await inspectRuntimeTrustStore(item.reference)
  expect(stopped.generation).toBe(3)
  expect(stopped.releaseFloor).toBe(9)
  expect(stopped.attempt?.phase).toBe('maintenance')
  const recovered = await recoverRuntimeTrustStore(item.reference)
  expect(recovered.releaseFloor).toBe(9)
  expect(recovered.attempt?.phase).toBe('recovered')
  expect(recovered.physicalDeploymentAllowed).toBe(false)
})

test('candidate paths cannot overlap the repository, enrollment or protocol store', async () => {
  const item = await setup(), initial = await inspectRuntimeTrustStore(item.reference)
  for (const source of [item.source, item.reference.enrollmentDirectory, item.reference.directory]) {
    await expect(prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: join(source, 'candidate'), clock })).rejects.toThrow('separate')
    expect(await inspectRuntimeTrustStore(item.reference)).toEqual(initial)
  }
})

test('newer signed metadata cannot prepare a release below the protected floor or overwrite an earlier candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-prepare-floor-')); roots.push(root)
  const source = join(root, 'repo'), fixture = await epochRepository(source)
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  const store = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
  const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory: join(root, 'store'), storeSha256: store.storeSha256 }
  const original = await fixture.publish(1, 1, 9), output = join(root, 'candidate')
  await prepareRuntimeFirmwareUpdate({ ...reference, repository: source, output, clock })
  const receipt = await readFile(join(output, 'stage.json'))
  await fixture.publish(1, 2, 8)
  await expect(prepareRuntimeFirmwareUpdate({ ...reference, repository: source, output: join(root, 'downgrade'), clock })).rejects.toThrow('below the trusted minimum')
  const stopped = await inspectRuntimeTrustStore(reference)
  expect(stopped.releaseFloor).toBe(9)
  expect(stopped.metadata.find(row => row.role === 'targets')?.version).toBe(2)
  expect(stopped.attempt?.phase).toBe('maintenance')
  expect(await readFile(join(output, 'image.bin'))).toEqual(original.image)
  expect(await readFile(join(output, 'stage.json'))).toEqual(receipt)
  const recovered = await recoverRuntimeTrustStore(reference)
  expect(recovered.releaseFloor).toBe(9)
  expect(recovered.attempt?.phase).toBe('recovered')
  expect(recovered.physicalDeploymentAllowed).toBe(false)
})

test('bad image bytes cannot discard accepted metadata or release floors, including after offline recovery', async () => {
  const item = await setup()
  await writeFile(item.fixture.imagePath, Buffer.alloc(item.fixture.image.length, 0xff))
  await expect(prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: item.output, clock })).rejects.toThrow()
  const stopped = await inspectRuntimeTrustStore(item.reference)
  expect(stopped.generation).toBe(3)
  expect(stopped.releaseFloor).toBe(9)
  expect(stopped.attempt?.phase).toBe('maintenance')
  await expect(stat(item.output)).rejects.toHaveProperty('code', 'ENOENT')
  await rename(item.source, join(item.root, 'offline'))
  const recovered = await recoverRuntimeTrustStore(item.reference)
  expect(recovered.generation).toBe(3)
  expect(recovered.releaseFloor).toBe(9)
  expect(recovered.attempt?.phase).toBe('recovered')
  expect(recovered.physicalDeploymentAllowed).toBe(false)
  await rename(join(item.root, 'offline'), item.source)
  await writeFile(item.fixture.imagePath, item.fixture.image)
  const fresh = await prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: item.output, clock })
  expect(fresh.store.releaseFloor).toBe(9)
  expect(fresh.candidate.sha256).toBe(item.fixture.imageHash)
  expect(fresh.physicalDeploymentAllowed).toBe(false)
})

test('real preparation process cuts retain accepted floors and never turn recovery into candidate authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-prepare-host-cuts-')); roots.push(root)
  const result = await qualifyPreparationInterruptions(join(root, 'campaign'))
  expect(result.cuts).toBe(2)
  expect(result.physicalDeploymentAllowed).toBe(false)
}, 45000)

test('protected preparation also archives repositories without consistent-snapshot filename prefixes', async () => {
  const item = await setup({ rotate: true, consistentSnapshot: false })
  const result = await prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: item.output, clock })
  const current = await inspectRuntimeTrustStore(item.reference), root = current.metadata.find(row => row.role === 'root')!
  expect(root.version).toBe(2)
  expect(result.candidate.sha256).toBe(item.fixture.imageHash)
  expect(await inspectStagedRuntimeFirmware({ directory: item.output, target, platform, trustedRootSha256: root.sha256, minimumReleaseSequence: current.releaseFloor })).toEqual(result.candidate)
  expect(result.physicalDeploymentAllowed).toBe(false)
})

test('actual candidate-image corruption after file sync is rejected by readback before a completion marker', async () => {
  const item = await setup(), damaged = Buffer.alloc(item.fixture.image.length, 0xff)
  let changedAfterWrite = false
  await expect(prepareRuntimeFirmwareUpdate({ ...item.reference, repository: item.source, output: item.output, clock, async onProgress(event) {
    if (event.phase === 'image-written') {
      await writeFile(join(item.output, 'image.bin'), damaged)
      changedAfterWrite = true
    }
  } })).rejects.toThrow()
  expect(changedAfterWrite).toBe(true)
  expect(await readFile(join(item.output, 'image.bin'))).toEqual(damaged)
  expect(await Bun.file(join(item.output, 'stage.json')).exists()).toBe(false)
  const stopped = await inspectRuntimeTrustStore(item.reference)
  expect(stopped.releaseFloor).toBe(9)
  expect(stopped.attempt?.phase).toBe('maintenance')
  expect(stopped.physicalDeploymentAllowed).toBe(false)
})
