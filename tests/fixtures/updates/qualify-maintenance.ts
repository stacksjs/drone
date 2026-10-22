import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildRuntime } from '../../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeTrustStore, refreshRuntimeTrustStore, reserveRuntimeFirmwareCandidate, trialRuntimeFirmwareCandidate } from '../../../resources/functions/drone/updates/store'
import { runBoundedHostProcess } from '../../../resources/functions/host/process'
import { createHostSourceProject } from './host-project'
import { digest, repository, target } from './repository'

/** Copied real executable outside the checkout, signed owned host image and format-4 health. */
export async function qualifyMaintenanceCommands(directory: string, executable: string, olderExecutable?: string) {
  directory = resolve(directory); executable = resolve(executable)
  await mkdir(directory, { mode: 0o700 })
  const binary = join(directory, 'drone'), binaryHash = digest(await readFile(executable))
  await copyFile(executable, binary); await chmod(binary, 0o700)
  assert.equal(digest(await readFile(binary)), binaryHash)
  const { project, sourceRevision } = await createHostSourceProject(directory)
  const built = await buildRuntime({ project }), image = await readFile(built.artifact)
  const source = join(directory, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision, releaseSequence: 9 } })
  const enrollmentDirectory = join(directory, 'enrollment')
  const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
  const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(directory, 'store') })
  const reference = { directory: join(directory, 'store'), enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }
  const clock = { source: 'operator-managed-command-fixture-clock', read: () => new Date() }
  const candidate = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
  const good = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: candidate.candidate!.id })
  await signed.publish({ image, version: 2, custom: { releaseSequence: 9 }, badTargetsSignature: true })
  await assert.rejects(refreshRuntimeTrustStore({ ...reference, repository: source, clock }))
  const failed = await inspectRuntimeTrustStore(reference)
  await signed.publish({ image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
  const flags = ['--enrollment', enrollmentDirectory, '--enrollment-sha256', enrolled.enrollmentSha256, '--store-sha256', created.storeSha256]
  const freshFlags = [...flags, '--repository', source, '--trusted-system-clock-source', clock.source]
  const operations: { args: string[], exitCode: number }[] = []
  async function command(args: string[], expected = 0, artifact = binary) {
    const result = await runBoundedHostProcess([artifact, ...args], { cwd: directory, timeoutMs: 30000, stdoutBytes: 262144, stderrBytes: 65536, label: 'Copied maintenance CLI qualification' })
    const ordinal = operations.length
    await writeFile(join(directory, `command-${ordinal}.stdout`), result.stdout)
    await writeFile(join(directory, `command-${ordinal}.stderr`), result.stderr)
    operations.push({ args, exitCode: result.exitCode })
    await writeFile(join(directory, 'operations.json'), JSON.stringify(operations, null, 2))
    assert.equal(result.exitCode, expected, result.stderr)
    if (expected === 0) { assert.equal(result.stderr, ''); return JSON.parse(result.stdout) }
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Runtime update store unavailable: invalid trust, clock, state or storage failure\n')
    return null
  }
  const maintain = ['updates:maintain', reference.directory, ...freshFlags, '--attempt', failed.attempt!.id]
  await command(maintain, 1)
  assert.deepEqual(await inspectRuntimeTrustStore(reference), failed)
  const verified = await command([...maintain, '--acknowledge-unresolved-inputs'])
  assert.equal(verified.attempt.phase, 'verified'); assert.equal(verified.releaseFloor, 9)
  assert.deepEqual(verified.maintenanceHandoffs[0].previousAttempt, failed.attempt)
  assert.deepEqual(await command(['updates:store', reference.directory, ...flags]), verified)
  const maintained = await command(['updates:slots', reference.directory, ...flags])
  assert.equal(maintained.stateFormat, 4); assert.deepEqual(maintained.knownGood, good.knownGood)
  assert.deepEqual(maintained.installed, good.installed)
  await command([...maintain, '--acknowledge-unresolved-inputs'], 1)
  await command(['updates:recover', reference.directory, ...flags], 1)
  const prepared = await command(['updates:reserve', reference.directory, ...freshFlags])
  assert.equal(prepared.stateFormat, 4); assert.equal(prepared.candidate.phase, 'prepared')
  const fresh = await command(['updates:trial', reference.directory, ...freshFlags, '--candidate', prepared.candidate.id, '--project', project])
  assert.equal(fresh.stateFormat, 4); assert.equal(fresh.knownGood.health.cleanProcessExit, true)
  assert.notEqual(fresh.knownGood.id, good.knownGood!.id)
  assert.notEqual(fresh.knownGood.health.bootId, good.knownGood!.health!.bootId)
  assert.notEqual(fresh.knownGood.health.sessionId, good.knownGood!.health!.sessionId)
  const rollback = await command(['updates:rollback', reference.directory, ...freshFlags, '--project', project])
  assert.notEqual(rollback.knownGood.health.bootId, fresh.knownGood.health.bootId)
  assert.equal(rollback.knownGood.health.cleanProcessExit, true)
  assert.equal(rollback.physicalDeploymentAllowed, false)
  const oldImage = join(reference.directory, 'host-slots', good.knownGood!.id, 'image.bin')
  assert.deepEqual(await readFile(oldImage), image)
  let oldReader: { qualified: false } | { qualified: true, executableSha256: string, databasesUnchanged: true } = { qualified: false }
  if (olderExecutable) {
    olderExecutable = resolve(olderExecutable)
    const oldHash = digest(await readFile(olderExecutable)), paths = ['state.sqlite', 'writer.sqlite'].map(name => join(reference.directory, name))
    const before = await Promise.all(paths.map(async path => digest(await readFile(path))))
    await command(['updates:store', reference.directory, ...flags], 1, olderExecutable)
    assert.deepEqual(await Promise.all(paths.map(async path => digest(await readFile(path)))), before)
    assert.equal(digest(await readFile(olderExecutable)), oldHash)
    oldReader = { qualified: true, executableSha256: oldHash, databasesUnchanged: true }
  }
  assert.equal(digest(await readFile(binary)), binaryHash)
  const result = { evidence: 'copied-maintenance-command-v1', sourceRevision, executableSha256: binaryHash, operations: operations.length, retainedAttempt: failed.attempt, maintenanceHandoffs: rollback.store.maintenanceHandoffs, previousBootId: good.knownGood!.health!.bootId, freshBootId: fresh.knownGood.health.bootId, rollbackBootId: rollback.knownGood.health.bootId, releaseFloor: rollback.store.releaseFloor, oldReader, physicalDeploymentAllowed: rollback.physicalDeploymentAllowed }
  await writeFile(join(directory, 'qualification.json'), JSON.stringify(result, null, 2))
  return result
}

if (import.meta.main) {
  assert.ok(process.argv.length === 4 || process.argv.length === 5)
  console.log(JSON.stringify(await qualifyMaintenanceCommands(process.argv[2]!, process.argv[3]!, process.argv[4])))
}
