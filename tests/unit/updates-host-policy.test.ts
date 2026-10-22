import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeFirmwareSlots, recoverRuntimeTrustStore, reserveRuntimeFirmwareCandidate, rollbackRuntimeFirmwareSlot, trialRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'
import { repository, target } from '../fixtures/updates/repository'
import { createHostSourceProject } from '../fixtures/updates/host-project'

test('replacement policy rejects old rollback bytes and a signed neutral label cannot execute a mismatched build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-policy-'))
  try {
    const project = process.cwd(), build = await buildRuntime({ project }), image = new Uint8Array(await Bun.file(build.artifact).arrayBuffer())
    const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const sourceRevision = (await new Response(git.stdout).text()).trim()
    expect(await git.exited).toBe(0)
    const source = join(root, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const first = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const good = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: first.candidate!.id })
    const replacement = await signed.publish({ image: Buffer.from('signed text only, never execute\n'), version: 2, custom: { releaseSequence: 9 }, rotateTargets: true })
    await expect(rollbackRuntimeFirmwareSlot({ ...reference, repository: source, clock, project })).rejects.toThrow('currently authorized')
    const denied = await inspectRuntimeFirmwareSlots(reference)
    expect(denied.knownGood).toEqual(good.knownGood)
    expect(denied.store.releaseFloor).toBe(9)
    expect(denied.store.metadata.find(item => item.role === 'root')?.version).toBe(2)
    expect(denied.store.attempt?.phase).toBe('maintenance')
    expect(await readFile(join(directory, 'host-slots', good.knownGood!.id, 'image.bin'))).toEqual(Buffer.from(image))
    await recoverRuntimeTrustStore(reference)
    const next = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    expect(next.candidate!.description.sha256).toBe(replacement.imageHash)
    await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: next.candidate!.id })).rejects.toThrow('does not match the actual owned neutral build')
    const failed = await inspectRuntimeFirmwareSlots(reference)
    expect(failed.knownGood).toEqual(good.knownGood)
    expect(failed.trial?.phase).toBe('failed')
    expect(failed.trial?.health).toBeNull()
    expect(failed.installed?.id).toBe(good.installed!.id)
    expect(failed.store.releaseFloor).toBe(9)
    expect(failed.physicalDeploymentAllowed).toBe(false)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('signed revision mismatch and dirty firmware cannot start a host trial or discard accepted policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-source-policy-'))
  let completed = false
  try {
    for (const mode of ['revision', 'dirty'] as const) {
      const scope = join(root, mode); await mkdir(scope, { mode: 0o700 })
      const { project, sourceRevision } = await createHostSourceProject(scope)
      const built = await buildRuntime({ project }), image = new Uint8Array(await Bun.file(built.artifact).arrayBuffer())
      const source = join(scope, 'repository')
      const signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision: mode === 'revision' ? 'f'.repeat(40) : sourceRevision, releaseSequence: 9 } })
      if (mode === 'dirty') {
        const path = join(project, 'firmware/runtime/src/host.cpp')
        await writeFile(path, `${await readFile(path, 'utf8')}\n// Deliberate uncommitted fixture change.\n`)
      }
      const enrollmentDirectory = join(scope, 'enrollment')
      const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
      const directory = join(scope, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
      const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
      const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
      const prepared = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
      const phases: string[] = []
      await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, project, clock, candidateId: prepared.candidate!.id, onProgress(event) { phases.push(event.phase) } })).rejects.toThrow('signed clean firmware source revision')
      expect(phases).not.toContain('runtime-started'); expect(phases).not.toContain('runtime-input-committed')
      const failed = await inspectRuntimeFirmwareSlots(reference)
      expect(failed.installed).toBeNull(); expect(failed.knownGood).toBeNull()
      expect(failed.trial?.phase).toBe('failed'); expect(failed.trial?.health).toBeNull()
      expect(failed.store.releaseFloor).toBe(9)
      await recoverRuntimeTrustStore(reference)
      const recovered = await inspectRuntimeFirmwareSlots(reference)
      expect(recovered.trial).toEqual(failed.trial)
      expect(recovered.knownGood).toBeNull(); expect(recovered.store.releaseFloor).toBe(9)
    }
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed host source-policy fixture retained at ${root}`)
  }
}, 40000)

test('actual CMake output overflow retains accepted policy and needs fresh execution after recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-build-output-'))
  let completed = false
  try {
    const { project, sourceRevision } = await createHostSourceProject(root, { fault: 'configure-output' })
    const built = await buildRuntime({ project }), image = new Uint8Array(await Bun.file(built.artifact).arrayBuffer())
    const source = join(root, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision, releaseSequence: 9 } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const candidate = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const flag = join(built.directory, 'drone-output-overflow-fixture'); await writeFile(flag, 'explicit private output fault\n')
    const phases: string[] = []
    await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, project, clock, candidateId: candidate.candidate!.id, onProgress(event) { phases.push(event.phase) } })).rejects.toThrow('stdout exceeds byte limit')
    expect(phases).not.toContain('runtime-started')
    const failed = await inspectRuntimeFirmwareSlots(reference)
    expect(failed.knownGood).toBeNull(); expect(failed.installed).toBeNull()
    expect(failed.trial?.phase).toBe('failed'); expect(failed.trial?.health).toBeNull()
    expect(failed.store.releaseFloor).toBe(9)
    await recoverRuntimeTrustStore(reference)
    expect((await inspectRuntimeFirmwareSlots(reference)).store.releaseFloor).toBe(9)
    await unlink(flag)
    const fresh = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, project, clock, candidateId: candidate.candidate!.id })
    expect(fresh.knownGood?.candidateId).toBe(candidate.candidate!.id)
    expect(fresh.knownGood?.id).not.toBe(failed.trial?.id)
    expect(fresh.knownGood?.health?.cleanProcessExit).toBe(true)
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed bounded-build fixture retained at ${root}`)
  }
}, 40000)

test('phase and reservation changes cannot promote a slot even after actual healthy execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-transition-policy-'))
  let completed = false
  try {
    const project = process.cwd(), built = await buildRuntime({ project }), image = new Uint8Array(await Bun.file(built.artifact).arrayBuffer())
    const revision = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const sourceRevision = (await new Response(revision.stdout).text()).trim()
    expect(await revision.exited).toBe(0)
    const source = join(root, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const first = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const good = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: first.candidate!.id })
    await signed.publish({ image, version: 2, custom: { releaseSequence: 9 } })
    const next = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    for (const mode of ['selected', 'running', 'reservation'] as const) {
      const phases: string[] = []
      let changed = false
      await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, project, clock, candidateId: next.candidate!.id, onProgress(event) {
        phases.push(event.phase)
        if (event.phase !== (mode === 'selected' ? 'slot-image-written' : 'final-clock-committed')) return
        // Actual private SQLite fault between committed phases, not a mocked transition result.
        const db = new Database(join(directory, 'state.sqlite'), { readwrite: true, create: false })
        try {
          const result = mode === 'reservation'
            ? db.query("UPDATE candidates SET phase = 'retired' WHERE id = ? AND phase = 'prepared'").run(next.candidate!.id)
            : db.query("UPDATE host_slots SET phase = 'failed' WHERE phase = ?").run(mode)
          expect(result.changes).toBe(1); changed = true
        }
        finally { db.close() }
      } })).rejects.toThrow(mode === 'selected' ? 'Selected host slot changed' : mode === 'running' ? 'Running host slot changed' : 'Owned candidate reservation changed')
      expect(changed).toBe(true)
      if (mode === 'selected') expect(phases).not.toContain('runtime-input-committed')
      else expect(phases).toContain('final-clock-committed')
      const failed = await inspectRuntimeFirmwareSlots(reference)
      expect(failed.knownGood).toEqual(good.knownGood)
      expect(failed.trial?.phase).toBe('failed'); expect(failed.trial?.health).toBeNull()
      expect(failed.store.releaseFloor).toBe(9)
      await recoverRuntimeTrustStore(reference)
      const recovered = await inspectRuntimeFirmwareSlots(reference)
      expect(recovered.knownGood).toEqual(good.knownGood)
      expect(recovered.trial).toEqual(failed.trial); expect(recovered.store.releaseFloor).toBe(9)
    }
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed host transition fixture retained at ${root}`)
  }
}, 40000)

test('a final trusted clock advance survives rejected confirmation and historical recovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-clock-floor-'))
  try {
    const project = process.cwd(), build = await buildRuntime({ project }), image = new Uint8Array(await Bun.file(build.artifact).arrayBuffer())
    const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const sourceRevision = (await new Response(git.stdout).text()).trim()
    expect(await git.exited).toBe(0)
    const source = join(root, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const directory = join(root, 'store'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const prepared = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    let readings = 0
    const advancing = { source: clock.source, read: () => new Date(++readings === 1 ? '2030-01-01T00:00:00Z' : '2036-01-01T00:00:00Z') }
    await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, project, candidateId: prepared.candidate!.id, clock: advancing })).rejects.toThrow('expired before confirmation')
    const failed = await inspectRuntimeFirmwareSlots(reference)
    expect(failed.knownGood).toBeNull()
    expect(failed.store.clockFloorMs).toBe(Date.parse('2036-01-01T00:00:00Z'))
    expect(failed.trial?.clockCheckedMs).toBe(failed.store.clockFloorMs)
    expect(failed.trial?.confirmedClockMs).toBeNull()
    expect(failed.trial?.phase).toBe('failed')
    await recoverRuntimeTrustStore(reference)
    expect((await inspectRuntimeFirmwareSlots(reference)).store.clockFloorMs).toBe(failed.store.clockFloorMs)
    await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, project, candidateId: prepared.candidate!.id, clock })).rejects.toThrow('reversed update clock')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 30000)

test('a trusted build output cannot overlap protected state or change it before rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-host-build-collision-'))
  let completed = false
  try {
    const built = await buildRuntime(), image = new Uint8Array(await Bun.file(built.artifact).arrayBuffer())
    const { project, sourceRevision } = await createHostSourceProject(root)
    const source = join(root, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const buildParent = join(project, 'storage/runtime-build')
    await mkdir(buildParent, { recursive: true, mode: 0o700 })
    const directory = join(buildParent, 'host'), created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: directory })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory, storeSha256: created.storeSha256 }
    const clock = { source: 'independent-test-clock', read: () => new Date('2030-01-01T00:00:00Z') }
    const candidate = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const before = await readFile(join(directory, 'state.sqlite')), writer = await readFile(join(directory, 'writer.sqlite')), names = await readdir(directory)
    await expect(trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: candidate.candidate!.id })).rejects.toThrow('build output')
    expect(await readFile(join(directory, 'state.sqlite'))).toEqual(before)
    expect(await readFile(join(directory, 'writer.sqlite'))).toEqual(writer)
    expect(await readdir(directory)).toEqual(names)
    expect(await Bun.file(join(directory, 'CMakeCache.txt')).exists()).toBe(false)
    completed = true
  }
  finally {
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error(`Failed build collision fixture retained at ${root}`)
  }
}, 30000)
