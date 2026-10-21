import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeFirmwareCandidates, inspectRuntimeTrustStore, recoverRuntimeTrustStore, refreshRuntimeTrustStore, reserveRuntimeFirmwareCandidate, retireRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'
import { platform, repository, target } from '../fixtures/updates/repository'
import { qualifyCandidateInterruptions } from '../fixtures/updates/store-interruptions'
import { epochRepository } from '../fixtures/updates/epochs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'drone-owned-candidate-')); roots.push(root)
  const source = join(root, 'repository'), fixture = await repository(source, { custom: { releaseSequence: 9 } })
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
  return { root, source, fixture, reference: { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 } }
}

test('the pinned store exclusively owns a prepared candidate and retains its authenticated identity across reopening', async () => {
  const item = await setup(), before = await inspectRuntimeTrustStore(item.reference)
  expect((await inspectRuntimeFirmwareCandidates(item.reference)).candidate).toBeNull()
  const result = await reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock })
  expect(result.schema).toBe('drone-runtime-candidates-v1')
  expect(result.stateFormat).toBe(2)
  expect(result.store.storeId).toBe(before.storeId)
  expect(result.store.releaseFloor).toBe(9)
  expect(result.store.generation).toBe(3)
  expect(result.store.attempt?.phase).toBe('verified')
  expect(result.retainedCandidates).toBe(1)
  expect(result.candidate?.phase).toBe('prepared')
  expect(result.candidate?.integrity).toBe('recorded-bytes-match')
  expect(result.candidate?.description.sha256).toBe(item.fixture.imageHash)
  expect(result.candidate?.description.releaseSequence).toBe(9)
  expect(result.candidate?.currentTrustValidated).toBe(false)
  expect(result.physicalDeploymentAllowed).toBe(false)
  expect(await readFile(join(result.candidate!.directory, 'image.bin'))).toEqual(item.fixture.image)
  expect(await inspectRuntimeFirmwareCandidates(item.reference)).toEqual(result)
  await expect(reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock })).rejects.toThrow('active candidate')
  expect(await inspectRuntimeFirmwareCandidates(item.reference)).toEqual(result)
})

test('explicit retirement retains old bytes and floors while allowing a distinct new candidate identity', async () => {
  const item = await setup()
  const first = await reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock })
  const candidate = first.candidate!, original = await readFile(join(candidate.directory, 'stage.json'))
  await expect(retireRuntimeFirmwareCandidate({ ...item.reference, candidateId: '0'.repeat(32) })).rejects.toThrow('active candidate')
  expect(await inspectRuntimeFirmwareCandidates(item.reference)).toEqual(first)
  const retired = await retireRuntimeFirmwareCandidate({ ...item.reference, candidateId: candidate.id })
  expect(retired.candidate).toBeNull()
  expect(retired.retainedCandidates).toBe(1)
  expect(retired.history.map(row => ({ id: row.id, phase: row.phase, sha256: row.description.sha256 }))).toEqual([{ id: candidate.id, phase: 'retired', sha256: item.fixture.imageHash }])
  expect(retired.store.releaseFloor).toBe(9)
  expect(await readFile(join(candidate.directory, 'stage.json'))).toEqual(original)
  expect(await readFile(join(candidate.directory, 'image.bin'))).toEqual(item.fixture.image)
  const next = await reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock })
  expect(next.candidate?.id).not.toBe(candidate.id)
  expect(next.candidate?.integrity).toBe('recorded-bytes-match')
  expect(next.retainedCandidates).toBe(2)
  expect(next.store.releaseFloor).toBe(9)
  expect(await readFile(join(candidate.directory, 'stage.json'))).toEqual(original)
  await expect(retireRuntimeFirmwareCandidate({ ...item.reference, candidateId: candidate.id })).rejects.toThrow('active candidate')
  expect(await inspectRuntimeFirmwareCandidates(item.reference)).toEqual(next)
})

test('a completed stage marker after an interrupted reservation cannot promote itself during metadata recovery', async () => {
  const item = await setup(), interruption = new Error('Stop after durable candidate files')
  await expect(reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock, onProgress(event) {
    if (event.phase === 'candidate-completed') throw interruption
  } })).rejects.toBe(interruption)
  const stopped = await inspectRuntimeFirmwareCandidates(item.reference), candidate = stopped.candidate!
  expect(candidate.phase).toBe('reserved')
  expect(candidate.integrity).toBe('incomplete')
  expect(JSON.parse(await readFile(join(candidate.directory, 'stage.json'), 'utf8')).sha256).toBe(item.fixture.imageHash)
  expect(stopped.store.releaseFloor).toBe(9)
  expect(stopped.store.attempt?.phase).toBe('maintenance')
  await expect(retireRuntimeFirmwareCandidate({ ...item.reference, candidateId: candidate.id })).rejects.toThrow('Resolve the metadata attempt')
  await recoverRuntimeTrustStore(item.reference)
  const recovered = await inspectRuntimeFirmwareCandidates(item.reference)
  expect(recovered.candidate).toEqual(candidate)
  expect(recovered.store.attempt?.phase).toBe('recovered')
  expect(recovered.store.releaseFloor).toBe(9)
  expect(recovered.physicalDeploymentAllowed).toBe(false)
  const original = await readFile(join(candidate.directory, 'stage.json'))
  const retired = await retireRuntimeFirmwareCandidate({ ...item.reference, candidateId: candidate.id })
  expect(retired.candidate).toBeNull()
  expect(await readFile(join(candidate.directory, 'stage.json'))).toEqual(original)
})

test('a rejected actual image retains the reserved identity and accepted floors without creating a prepared artifact', async () => {
  const item = await setup()
  await writeFile(item.fixture.imagePath, Buffer.alloc(item.fixture.image.length, 0xff))
  await expect(reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock })).rejects.toThrow()
  const stopped = await inspectRuntimeFirmwareCandidates(item.reference)
  expect(stopped.candidate?.phase).toBe('reserved')
  expect(stopped.candidate?.integrity).toBe('incomplete')
  expect(stopped.store.releaseFloor).toBe(9)
  expect(stopped.store.attempt?.phase).toBe('maintenance')
  expect(await Bun.file(join(stopped.candidate!.directory, 'stage.json')).exists()).toBe(false)
  await recoverRuntimeTrustStore(item.reference)
  expect((await inspectRuntimeFirmwareCandidates(item.reference)).candidate?.phase).toBe('reserved')
})

test('missing or corrupt owned bytes produce actionable integrity status and never current-trust authorization', async () => {
  const item = await setup(), prepared = await reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock })
  const candidate = prepared.candidate!, image = join(candidate.directory, 'image.bin')
  await writeFile(image, Buffer.alloc(item.fixture.image.length, 0xff))
  expect((await inspectRuntimeFirmwareCandidates(item.reference)).candidate?.integrity).toBe('mismatch')
  await rm(image)
  const missing = await inspectRuntimeFirmwareCandidates(item.reference)
  expect(missing.candidate?.integrity).toBe('unavailable')
  expect(missing.candidate?.phase).toBe('prepared')
  expect(missing.candidate?.currentTrustValidated).toBe(false)
  expect(missing.store.releaseFloor).toBe(9)
  expect(missing.physicalDeploymentAllowed).toBe(false)
  await writeFile(image, item.fixture.image, { mode: 0o600 })
  await writeFile(join(candidate.directory, 'repository/metadata/1.targets.json'), '{}\n')
  expect((await inspectRuntimeFirmwareCandidates(item.reference)).candidate?.integrity).not.toBe('recorded-bytes-match')
})

test('actual killed candidate writers preserve reserved, prepared and retired states with concurrent writers excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-owned-candidate-cuts-')); roots.push(root)
  const result = await qualifyCandidateInterruptions(join(root, 'campaign'))
  expect(result.cuts).toBe(5)
  expect(result.physicalDeploymentAllowed).toBe(false)
}, 90000)

test('managed candidates reject repository overlap before advancing state and preserve a foreign state format unchanged', async () => {
  const item = await setup(), initial = await inspectRuntimeTrustStore(item.reference)
  for (const repository of [item.root, item.reference.directory]) {
    await expect(reserveRuntimeFirmwareCandidate({ ...item.reference, repository, clock })).rejects.toThrow('separate')
    expect(await inspectRuntimeTrustStore(item.reference)).toEqual(initial)
  }
  await reserveRuntimeFirmwareCandidate({ ...item.reference, repository: item.source, clock })
  const file = join(item.reference.directory, 'state.sqlite'), db = new Database(file, { create: false, readwrite: true })
  try { db.exec('PRAGMA user_version=99') }
  finally { db.close() }
  const original = await readFile(file)
  await expect(inspectRuntimeFirmwareCandidates(item.reference)).rejects.toThrow('schema')
  expect(await readFile(file)).toEqual(original)
})

test('migration retains a prior rotated-root epoch, metadata history and clock/release floors across later rejections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-owned-candidate-migration-')); roots.push(root)
  const source = join(root, 'repository'), fixture = await epochRepository(source)
  const enrollmentDirectory = join(root, 'enrollment'), directory = join(root, 'store')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
  const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
  await fixture.publish(1, 100, 12)
  await refreshRuntimeTrustStore({ ...reference, repository: source, clock })
  const nextClock = { source: clock.source, read: () => new Date('2030-01-02T00:00:00Z') }
  const image = await fixture.publish(2, 1, 12)
  const before = await refreshRuntimeTrustStore({ ...reference, repository: source, clock: nextClock })
  expect(before.epoch).toBe(1)
  expect(before.generation).toBe(7)
  expect(before.releaseFloor).toBe(12)
  expect((await inspectRuntimeFirmwareCandidates(reference)).stateFormat).toBe(1)
  const candidateClock = { source: clock.source, read: () => new Date('2030-01-03T00:00:00Z') }
  const prepared = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock: candidateClock })
  expect(prepared.stateFormat).toBe(2)
  expect(prepared.store.storeId).toBe(before.storeId)
  expect(prepared.store.storeSha256).toBe(before.storeSha256)
  expect(prepared.store.enrollmentSha256).toBe(before.enrollmentSha256)
  expect(prepared.store.metadata).toEqual(before.metadata)
  expect(prepared.store.retainedMetadataRecords).toBe(before.retainedMetadataRecords)
  expect(prepared.store.epoch).toBe(1)
  expect(prepared.store.releaseFloor).toBe(12)
  expect(prepared.store.clockFloorMs).toBe(Date.parse('2030-01-03T00:00:00Z'))
  expect(prepared.candidate?.description.rootVersion).toBe(2)
  const retired = await retireRuntimeFirmwareCandidate({ ...reference, candidateId: prepared.candidate!.id })
  await expect(reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })).rejects.toThrow('clock')
  expect(await inspectRuntimeFirmwareCandidates(reference)).toEqual(retired)
  await fixture.publish(2, 2, 11)
  await expect(reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock: candidateClock })).rejects.toThrow('below the trusted minimum')
  await recoverRuntimeTrustStore(reference)
  const recovered = await inspectRuntimeFirmwareCandidates(reference)
  expect(recovered.store.releaseFloor).toBe(12)
  expect(recovered.store.epoch).toBe(1)
  expect(recovered.store.attempt?.phase).toBe('recovered')
  expect(recovered.candidate).toBeNull()
  expect(recovered.history[0]?.description.releaseSequence).toBe(12)
  expect(await readFile(join(prepared.candidate!.directory, 'image.bin'))).toEqual(image.image)
})
