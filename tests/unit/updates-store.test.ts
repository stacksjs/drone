import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { DownloadHTTPError, MetadataVerificationError } from 'tuf-js'
import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeTrustStore, recoverRuntimeTrustStore, refreshRuntimeTrustStore } from '../../resources/functions/drone/updates/store'
import { platform, repository, target } from '../fixtures/updates/repository'
import { qualifyStoreInterruptions } from '../fixtures/updates/store-interruptions'
import { epochRepository } from '../fixtures/updates/epochs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup(options: Parameters<typeof repository>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'drone-update-store-')); roots.push(root)
  const source = join(root, 'repository'), fixture = await repository(source, options)
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  return { root, source, fixture, enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') }
}

test('a new protocol store binds the independently pinned enrollment and retains its initial floors', async () => {
  const item = await setup(), created = await createRuntimeTrustStore(item)
  expect(created.enrollmentSha256).toBe(item.enrollmentSha256)
  expect(created.releaseFloor).toBe(7)
  expect(created.clockFloorMs).toBe(0)
  expect(created.generation).toBe(0)
  expect(created.epoch).toBe(0)
  expect(created.metadata).toEqual([{ role: 'root', version: 1, sha256: item.fixture.rootSha256 }])
  expect(created.attempt).toBeNull()
  expect(created.physicalDeploymentAllowed).toBe(false)
  expect(await inspectRuntimeTrustStore({ ...item, directory: item.output, storeSha256: created.storeSha256 })).toEqual(created)
  expect((await stat(item.output)).mode & 0o777).toBe(0o700)
  for (const file of ['store.json', 'writer.sqlite', 'state.sqlite']) expect((await stat(join(item.output, file))).mode & 0o777).toBe(0o600)
  await expect(createRuntimeTrustStore(item)).rejects.toThrow()
})

test('signed refresh commits metadata and release floors that independent readback retains', async () => {
  const item = await setup({ custom: { releaseSequence: 9 } }), created = await createRuntimeTrustStore(item)
  const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
  const time = new Date('2030-01-01T00:00:00Z')
  const result = await refreshRuntimeTrustStore({ ...reference, repository: item.source, clock: { source: 'test-independent-clock', read: () => time } })
  expect(result.generation).toBe(3)
  expect(result.releaseFloor).toBe(9)
  expect(result.clockFloorMs).toBe(time.getTime())
  expect(result.metadata.map(row => [row.role, row.version])).toEqual([['root', 1], ['snapshot', 1], ['targets', 1], ['timestamp', 1]])
  expect(result.attempt?.phase).toBe('verified')
  expect(result.physicalDeploymentAllowed).toBe(false)
  expect(await inspectRuntimeTrustStore(reference)).toEqual(result)
})

test('a later signature failure preserves the accepted prefix and blocks a fresh attempt', async () => {
  const item = await setup({ badTargetsSignature: true }), created = await createRuntimeTrustStore(item)
  const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
  const clock = { source: 'test-independent-clock', read: () => new Date('2030-01-01T00:00:00Z') }
  await expect(refreshRuntimeTrustStore({ ...reference, repository: item.source, clock })).rejects.toThrow()
  const result = await inspectRuntimeTrustStore(reference)
  expect(result.generation).toBe(2)
  expect(result.metadata.map(row => row.role)).toEqual(['root', 'snapshot', 'timestamp'])
  expect(result.releaseFloor).toBe(7)
  expect(result.attempt?.phase).toBe('maintenance')
  await expect(refreshRuntimeTrustStore({ ...reference, repository: item.source, clock })).rejects.toThrow('requires recovery')
  await expect(recoverRuntimeTrustStore(reference)).rejects.toThrow()
  expect(await inspectRuntimeTrustStore(reference)).toEqual(result)
})

test('reversed clock and a wrong independent store pin cannot mutate an accepted state', async () => {
  const item = await setup(), created = await createRuntimeTrustStore(item)
  const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
  const result = await refreshRuntimeTrustStore({ ...reference, repository: item.source, clock: { source: 'test-clock', read: () => new Date('2030-01-01T00:00:00Z') } })
  await expect(refreshRuntimeTrustStore({ ...reference, repository: item.source, clock: { source: 'test-clock', read: () => new Date('2029-01-01T00:00:00Z') } })).rejects.toThrow('reversed')
  await expect(inspectRuntimeTrustStore({ ...reference, storeSha256: '0'.repeat(64) })).rejects.toThrow('pin mismatch')
  expect(await inspectRuntimeTrustStore(reference)).toEqual(result)
})

test('missing or corrupt protocol state is preserved and never recreated from the marker', async () => {
  for (const missing of [false, true]) {
    const item = await setup(), created = await createRuntimeTrustStore(item)
    const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
    const path = join(item.output, 'state.sqlite'), original = await readFile(path)
    if (missing) await unlink(path)
    else await writeFile(path, Buffer.from('corrupt protocol state'))
    await expect(inspectRuntimeTrustStore(reference)).rejects.toThrow()
    await expect(createRuntimeTrustStore(item)).rejects.toThrow()
    if (missing) expect(await Bun.file(path).exists()).toBe(false)
    else expect(await readFile(path)).toEqual(Buffer.from('corrupt protocol state'))
    await writeFile(path, original, { mode: 0o600 })
    expect(await inspectRuntimeTrustStore(reference)).toEqual(created)
  }
})

test('recovery verifies a journaled input that was never delivered, without consulting the repository', async () => {
  const item = await setup({ custom: { releaseSequence: 9 } }), created = await createRuntimeTrustStore(item)
  const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
  const clock = { source: 'test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
  await expect(refreshRuntimeTrustStore({ ...reference, repository: item.source, clock, onProgress(event) {
    if (event.phase === 'input-committed' && event.ordinal === 1) throw new Error('Interrupted before timestamp delivery')
  } })).rejects.toThrow('Update input progress observer rejected')
  expect((await inspectRuntimeTrustStore(reference)).generation).toBe(0)
  await rename(item.source, join(item.root, 'offline'))
  const recovered = await recoverRuntimeTrustStore(reference)
  expect(recovered.attempt?.phase).toBe('recovered')
  expect(recovered.generation).toBe(1)
  expect(recovered.metadata.map(row => row.role)).toEqual(['root', 'timestamp'])
  expect(recovered.clockFloorMs).toBe(clock.read().getTime())
  expect(recovered.releaseFloor).toBe(7)
  expect(recovered.physicalDeploymentAllowed).toBe(false)
  await rename(join(item.root, 'offline'), item.source)
  const fresh = await refreshRuntimeTrustStore({ ...reference, repository: item.source, clock })
  expect(fresh.generation).toBe(3)
  expect(fresh.releaseFloor).toBe(9)
  expect(fresh.attempt?.phase).toBe('verified')
})

test('real killed writers retain durable inputs and prefixes while contenders stay excluded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-store-host-cuts-')); roots.push(root)
  const result = await qualifyStoreInterruptions(join(root, 'campaign'))
  expect(result.cuts).toBe(2)
  expect(result.physicalDeploymentAllowed).toBe(false)
}, 45000)

test('a signed target rejected by release policy can finish recovery without lowering any floor', async () => {
  const item = await setup({ custom: { releaseSequence: 6 } }), created = await createRuntimeTrustStore(item)
  const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
  await expect(refreshRuntimeTrustStore({ ...reference, repository: item.source, clock: { source: 'test-clock', read: () => new Date('2030-01-01T00:00:00Z') } })).rejects.toThrow('below the trusted minimum')
  expect((await inspectRuntimeTrustStore(reference)).generation).toBe(3)
  const result = await recoverRuntimeTrustStore(reference)
  expect(result.attempt?.phase).toBe('recovered')
  expect(result.generation).toBe(3)
  expect(result.releaseFloor).toBe(7)
  expect(result.physicalDeploymentAllowed).toBe(false)
})

test('a foreign database is rejected without changing its journal format or bytes', async () => {
  const item = await setup(), created = await createRuntimeTrustStore(item)
  const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
  const foreign = join(item.root, 'foreign.sqlite'), db = new Database(foreign)
  try { db.exec('PRAGMA journal_mode=WAL; CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES(\'preserve me\')') }
  finally { db.close() }
  const before = await readFile(foreign), path = join(item.output, 'state.sqlite')
  await writeFile(path, before)
  await expect(inspectRuntimeTrustStore(reference)).rejects.toThrow()
  expect((await readFile(path)).equals(before)).toBe(true)
})

test('authenticated snapshot-key rotation permits a new metadata epoch while retaining the global release floor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-store-epochs-')); roots.push(root)
  const source = join(root, 'repo'), fixture = await epochRepository(source)
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory: join(root, 'store'), storeSha256: '' }
  reference.storeSha256 = (await createRuntimeTrustStore({ ...reference, output: reference.directory })).storeSha256
  const clock = { source: 'test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
  await fixture.publish(1, 100, 9)
  const before = await refreshRuntimeTrustStore({ ...reference, repository: source, clock })
  expect(before.releaseFloor).toBe(9); expect(before.epoch).toBe(0)
  await fixture.publish(2, 1, 8)
  await expect(refreshRuntimeTrustStore({ ...reference, repository: source, clock })).rejects.toThrow('below the trusted minimum')
  const after = await inspectRuntimeTrustStore(reference)
  expect(after.epoch).toBe(1)
  expect(after.metadata.map(row => [row.role, row.version])).toEqual([['root', 2], ['snapshot', 1], ['targets', 1], ['timestamp', 1]])
  expect(after.releaseFloor).toBe(9)
  expect(after.generation).toBe(7)
  expect(after.retainedMetadataRecords).toBe(8)
  const recovered = await recoverRuntimeTrustStore(reference)
  expect(recovered.attempt?.phase).toBe('recovered'); expect(recovered.releaseFloor).toBe(9)
  await fixture.publish(2, 2, 10)
  const fresh = await refreshRuntimeTrustStore({ ...reference, repository: source, clock })
  expect(fresh.epoch).toBe(1); expect(fresh.releaseFloor).toBe(10); expect(fresh.generation).toBe(10)
  expect(fresh.retainedMetadataRecords).toBe(11)
})

test('a clock adapter can be a class instance and is read exactly once', async () => {
  const item = await setup(), created = await createRuntimeTrustStore(item)
  class Clock {
    source = 'test-owned-clock'
    calls = 0
    read() { this.calls++; return new Date('2030-01-01T00:00:00Z') }
  }
  const clock = new Clock()
  const result = await refreshRuntimeTrustStore({ ...item, directory: item.output, storeSha256: created.storeSha256, repository: item.source, clock })
  expect(clock.calls).toBe(1)
  expect(result.clockFloorMs).toBe(Date.parse('2030-01-01T00:00:00Z'))
})

test('duplicate role key IDs are rejected before a root can reset metadata floors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-store-same-authority-')); roots.push(root)
  const source = join(root, 'repo'), fixture = await epochRepository(source, true)
  const enrollmentDirectory = join(root, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
  const initial = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
  const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory: join(root, 'store'), storeSha256: initial.storeSha256 }
  const clock = { source: 'test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
  await fixture.publish(1, 100, 9)
  await refreshRuntimeTrustStore({ ...reference, repository: source, clock })
  await fixture.publish(2, 1, 9)
  const failure = await refreshRuntimeTrustStore({ ...reference, repository: source, clock }).then(() => undefined, error => error)
  expect(failure).toBeInstanceOf(MetadataVerificationError)
  expect(failure.role).toBe('root')
  expect(failure.cause.message).toBe('duplicate key IDs found')
  const result = await inspectRuntimeTrustStore(reference)
  expect(result.epoch).toBe(0)
  expect(result.generation).toBe(3)
  expect(result.releaseFloor).toBe(9)
  expect(result.metadata.map(row => [row.role, row.version])).toEqual([['root', 1], ['snapshot', 100], ['targets', 100], ['timestamp', 100]])
})

for (const status of [404, 403]) {
  test(`input progress HTTP ${status} rejection cannot masquerade as an absent rotated root`, async () => {
    const item = await setup({ rotate: true }), created = await createRuntimeTrustStore(item)
    const reference = { ...item, directory: item.output, storeSha256: created.storeSha256 }
    const sentinel = new DownloadHTTPError('Progress observer interrupted', status), events: string[] = []
    const failure = await refreshRuntimeTrustStore({ ...reference, repository: item.source, clock: { source: 'test-clock', read: () => new Date('2030-01-01T00:00:00Z') }, onProgress(event) {
      events.push(`${event.phase}:${event.ordinal}`)
      if (event.phase === 'input-committed' && event.ordinal === 0) throw sentinel
    } }).then(() => undefined, error => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(DownloadHTTPError)
    expect(failure.cause).toBe(sentinel)
    expect(events).toEqual(['input-committed:0'])
    const stopped = await inspectRuntimeTrustStore(reference)
    expect(stopped.generation).toBe(0)
    expect(stopped.metadata).toEqual(created.metadata)
    expect(stopped.releaseFloor).toBe(7)
    expect(stopped.attempt?.phase).toBe('maintenance')
    await rename(item.source, join(item.root, 'offline'))
    const recovered = await recoverRuntimeTrustStore(reference)
    expect(recovered.generation).toBe(1)
    expect(recovered.metadata.map(row => [row.role, row.version])).toEqual([['root', 2]])
    expect(recovered.attempt?.phase).toBe('recovered')
    expect(recovered.releaseFloor).toBe(7)
    expect(recovered.physicalDeploymentAllowed).toBe(false)
  })
}
