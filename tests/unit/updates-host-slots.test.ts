import { beforeAll, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeFirmwareSlots, recoverRuntimeTrustStore, reserveRuntimeFirmwareCandidate, rollbackRuntimeFirmwareSlot, trialRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'
import { repository, target } from '../fixtures/updates/repository'
import { qualifyHostSlotInterruptions } from '../fixtures/updates/host-slot-interruptions'
import { createHostSourceProject } from '../fixtures/updates/host-project'

let image: Uint8Array, sourceRevision: string
beforeAll(async () => {
  const build = await buildRuntime()
  image = new Uint8Array(await Bun.file(build.artifact).arrayBuffer())
  const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  sourceRevision = (await new Response(git.stdout).text()).trim()
  expect(await git.exited).toBe(0)
}, 20000)

test('an owned signed host image becomes known-good only through its actual fresh runtime and clean process close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-slot-'))
  try {
    const source = join(root, 'repository')
    const signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const reserved = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    expect((await inspectRuntimeFirmwareSlots(reference)).knownGood).toBeNull()
    const result = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, candidateId: reserved.candidate!.id, project: process.cwd() })
    expect(result.schema).toBe('drone-runtime-host-slots-v1')
    expect(result.stateFormat).toBe(3)
    expect(result.knownGood?.candidateId).toBe(reserved.candidate!.id)
    expect(result.knownGood?.description.sha256).toBe(signed.imageHash)
    expect(result.installed?.id).toBe(result.knownGood?.id)
    expect(result.knownGood?.phase).toBe('confirmed')
    expect(result.knownGood?.health?.bootId).toMatch(/^[1-9][0-9]{0,19}$/)
    expect(result.knownGood?.health?.sessionId).toMatch(/^[1-9][0-9]{0,19}$/)
    expect(result.knownGood?.health?.ticks).toBe(100)
    expect(result.knownGood?.health?.cleanProcessExit).toBe(true)
    expect(result.knownGood?.health?.transcriptItems).toBeGreaterThan(200)
    expect(result.physicalDeploymentAllowed).toBe(false)
    expect(await inspectRuntimeFirmwareSlots(reference)).toEqual(result)
    const next = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const interruption = new Error('Owned observer stops before the second runtime launch')
    await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, candidateId: next.candidate!.id, project: process.cwd(), onProgress(event) {
      if (event.phase === 'runtime-started') throw interruption
    } })).rejects.toBe(interruption)
    const failed = await inspectRuntimeFirmwareSlots(reference)
    expect(failed.knownGood).toEqual(result.knownGood)
    expect(failed.installed?.phase).toBe('failed')
    expect(failed.installed?.id).not.toBe(result.knownGood!.id)
    expect(failed.store.releaseFloor).toBe(7)
    expect(failed.store.attempt?.phase).toBe('maintenance')
    expect(await readFile(join(directory, 'host-slots', result.knownGood!.id, 'image.bin'))).toEqual(Buffer.from(image))
    await recoverRuntimeTrustStore(reference)
    const recovered = await inspectRuntimeFirmwareSlots(reference)
    expect(recovered.knownGood).toEqual(result.knownGood)
    expect(recovered.installed?.phase).toBe('failed')
    expect(recovered.store.attempt?.phase).toBe('recovered')
    const rollback = await rollbackRuntimeFirmwareSlot({ ...reference, repository: source, clock, project: process.cwd() })
    expect(rollback.knownGood?.candidateId).toBe(result.knownGood!.candidateId)
    expect(rollback.knownGood?.id).not.toBe(result.knownGood!.id)
    expect(rollback.knownGood?.health?.bootId).not.toBe(result.knownGood!.health!.bootId)
    expect(rollback.knownGood?.health?.sessionId).not.toBe(result.knownGood!.health!.sessionId)
    expect(rollback.installed?.id).toBe(rollback.knownGood!.id)
    expect(rollback.retainedSlots).toBe(3)
    expect(rollback.physicalDeploymentAllowed).toBe(false)
    const goodImage = join(directory, 'host-slots', rollback.knownGood!.id, 'image.bin')
    await writeFile(goodImage, Buffer.alloc(image.length, 0xff))
    await expect(rollbackRuntimeFirmwareSlot({ ...reference, repository: source, clock, project: process.cwd() })).rejects.toThrow('known-good integrity')
    expect((await inspectRuntimeFirmwareSlots(reference)).knownGood!.id).toBe(rollback.knownGood!.id)
    expect(await readFile(goodImage)).toEqual(Buffer.alloc(image.length, 0xff))
    await writeFile(goodImage, image)
    await recoverRuntimeTrustStore(reference)
    // Deliberately corrupt retained state through the real file, without using it as a success oracle.
    const db = new Database(join(directory, 'state.sqlite'), { create: false, readwrite: true })
    try {
      const corrupted = { ...rollback.knownGood!.health!, bootId: rollback.knownGood!.health!.bootId === '1' ? '2' : '1' }
      db.query('UPDATE host_slots SET health = ? WHERE id = ?').run(Buffer.from(JSON.stringify(corrupted)), rollback.knownGood!.id)
    }
    finally { db.close() }
    await expect(inspectRuntimeFirmwareSlots(reference)).rejects.toThrow('transcript')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('actual host trial process cuts retain prior good and need explicit recovery without inventing confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-slot-cuts-'))
  let completed = false
  try {
    const result = await qualifyHostSlotInterruptions(join(root, 'campaign'), process.cwd())
    expect(result).toHaveLength(6)
    expect(result.every(item => item.signal === 'SIGKILL' && item.contender === 17 && item.recoveredWithoutPromotion && item.freshRollback)).toBe(true)
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed host slot campaign retained at ${root}`)
  }
}, 90000)

test('a real signed neutral kernel with a wrong-session stop reply cannot confirm a host slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-stop-session-'))
  try {
    const { project, sourceRevision: revision } = await createHostSourceProject(root, { fault: 'stop-session' })
    const build = await buildRuntime({ project })
    const source = join(root, 'repository'), bytes = new Uint8Array(await Bun.file(build.artifact).arrayBuffer())
    const signed = await repository(source, { image: bytes, custom: { platform: 'host-neutral-bench-v1', sourceRevision: revision } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const reserved = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, candidateId: reserved.candidate!.id, project })).rejects.toThrow('stop')
    expect((await inspectRuntimeFirmwareSlots(reference)).knownGood).toBeNull()
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
