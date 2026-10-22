import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildRuntime } from '../../../resources/functions/drone/runtime/build'
import { runBoundedHostProcess } from '../../../resources/functions/host/process'
import { qualifyHostSlotInterruptions } from './host-slot-interruptions'
import { repository, target } from './repository'

async function hash(path: string) { return createHash('sha256').update(await readFile(path)).digest('hex') }

/** Copied CLI, actual signed host bytes, actual process interruption and retained six-cut campaign. */
export async function qualifyPortableHostSlots(directory: string, source: string, project: string, olderBinary?: string) {
  await mkdir(directory, { mode: 0o700 })
  const binary = join(directory, 'drone'), sourceSha256 = await hash(source)
  await copyFile(source, binary, constants.COPYFILE_EXCL); await chmod(binary, 0o700)
  assert.equal(await hash(binary), sourceSha256)
  const olderSha256 = olderBinary ? await hash(olderBinary) : null
  const built = await buildRuntime({ project }), image = new Uint8Array(await Bun.file(built.artifact).arrayBuffer())
  const revision = await runBoundedHostProcess(['git', '-C', project, 'rev-parse', 'HEAD'], { timeoutMs: 10000, stdoutBytes: 1024, stderrBytes: 4096, label: 'Qualification source revision' })
  assert.equal(revision.exitCode, 0)
  const sourceRevision = revision.stdout.trim(), repo = join(directory, 'repository')
  const signed = await repository(repo, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
  const enrollment = join(directory, 'enrollment'), store = join(directory, 'store')
  const results: { command: string, binarySha256: string, exitCode: number, stdout: string, stderr: string }[] = []
  async function run(args: string[], expected = 0, executable = binary) {
    const result = await runBoundedHostProcess([executable, ...args], { cwd: directory, timeoutMs: 30000, stdoutBytes: 2_000_000, stderrBytes: 65536, label: 'Portable host slot command' })
    results.push({ command: args[0]!, binarySha256: executable === binary ? sourceSha256 : olderSha256!, ...result })
    assert.equal(result.exitCode, expected)
    if (expected) { assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Runtime update store unavailable: invalid trust, clock, state or storage failure\n') }
    else assert.equal(result.stderr, '')
    return result.stdout ? JSON.parse(result.stdout) : undefined
  }
  try {
    const enrolled = await run(['updates:enroll', '--trusted-root', signed.rootPath, '--output', enrollment, '--target', target, '--platform', 'host-neutral-bench-v1', '--root-sha256', signed.rootSha256, '--minimum-release-sequence', '7'])
    const flags = ['--enrollment', enrollment, '--enrollment-sha256', enrolled.enrollmentSha256]
    const created = await run(['updates:store-init', ...flags, '--output', store])
    const pinned = [...flags, '--store-sha256', created.storeSha256]
    const current = ['--repository', repo, '--trusted-system-clock-source', 'operator-managed-test-clock']
    const prepared = await run(['updates:reserve', store, ...pinned, ...current])
    const first = await run(['updates:trial', store, ...pinned, ...current, '--project', project, '--candidate', prepared.candidate.id])
    assert.equal(first.stateFormat, 3); assert.equal(first.knownGood.health.cleanProcessExit, true)
    assert.equal(first.knownGood.description.sha256, signed.imageHash); assert.equal(first.knownGood.currentTrustValidated, false)
    assert.equal(first.installed.id, first.knownGood.id); assert.equal(first.physicalDeploymentAllowed, false)
    assert.deepEqual(await run(['updates:slots', store, ...pinned]), first)
    if (olderBinary) {
      const before = [await hash(join(store, 'state.sqlite')), await hash(join(store, 'writer.sqlite'))]
      await run(['updates:store', store, ...pinned], 1, olderBinary)
      assert.deepEqual([await hash(join(store, 'state.sqlite')), await hash(join(store, 'writer.sqlite'))], before)
      assert.equal(await hash(olderBinary), olderSha256)
    }
    const rollback = await run(['updates:rollback', store, ...pinned, ...current, '--project', project])
    assert.notEqual(rollback.knownGood.health.bootId, first.knownGood.health.bootId)
    assert.notEqual(rollback.knownGood.health.sessionId, first.knownGood.health.sessionId)
    assert.equal(rollback.knownGood.candidateId, first.knownGood.candidateId)
    const retainedImage = join(store, 'host-slots', rollback.knownGood.id, 'image.bin'), savedImage = join(directory, 'retained-good-image.bin')
    await rename(retainedImage, savedImage)
    await run(['updates:rollback', store, ...pinned, ...current, '--project', project], 1)
    const missing = await run(['updates:slots', store, ...pinned])
    assert.equal(missing.knownGood.id, rollback.knownGood.id); assert.equal(missing.knownGood.integrity, 'mismatch')
    assert.equal(missing.store.releaseFloor, 7); assert.equal(missing.store.attempt.phase, 'maintenance')
    await run(['updates:recover', store, ...pinned])
    await rename(savedImage, retainedImage)
    const next = await run(['updates:reserve', store, ...pinned, ...current])
    const input = join(directory, 'interruption.json')
    await writeFile(input, JSON.stringify({ reference: { directory: store, enrollmentDirectory: enrollment, enrollmentSha256: enrolled.enrollmentSha256, storeSha256: created.storeSha256 }, source: repo, project, candidateId: next.candidate.id, cut: 'slot-selected', systemClock: true }), { mode: 0o600 })
    // Source-side worker owns the process cut. Every maintenance decision below goes through the copied CLI.
    const worker = Bun.spawn([process.execPath, join(import.meta.dir, 'host-slot-interruptions.ts'), 'hold', input], { cwd: directory, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true })
    const reader = worker.stdout.getReader(), timer = setTimeout(() => worker.kill('SIGKILL'), 15000)
    let output = '', ready = false
    try {
      while (!output.includes('\n')) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false)
        output += new TextDecoder().decode(chunk.value)
        assert.ok(output.length <= 4096)
      }
      const event = JSON.parse(output.trim()); assert.equal(event.ready, true); assert.equal(event.phase, 'slot-selected'); ready = true
      process.kill(-worker.pid, 'SIGKILL'); assert.notEqual(await worker.exited, 0); assert.equal(worker.signalCode, 'SIGKILL')
    }
    finally {
      clearTimeout(timer)
      try { process.kill(-worker.pid, 'SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      await worker.exited; await reader.cancel(); reader.releaseLock()
      await writeFile(join(directory, 'worker.stdout'), output)
      await writeFile(join(directory, 'worker.stderr'), await new Response(worker.stderr).text())
      await writeFile(join(directory, 'worker.json'), JSON.stringify({ ready, exitCode: worker.exitCode, signal: worker.signalCode }))
    }
    const interrupted = await run(['updates:slots', store, ...pinned])
    assert.equal(interrupted.trial.phase, 'selected'); assert.equal(interrupted.store.attempt.phase, 'pending')
    assert.equal(interrupted.knownGood.id, rollback.knownGood.id)
    await run(['updates:abandon', store, ...pinned, '--trial', interrupted.trial.id], 1)
    await run(['updates:recover', store, ...pinned])
    await run(['updates:abandon', store, ...pinned, '--trial', '0'.repeat(32)], 1)
    const abandoned = await run(['updates:abandon', store, ...pinned, '--trial', interrupted.trial.id])
    assert.equal(abandoned.trial.phase, 'abandoned'); assert.deepEqual(abandoned.knownGood, rollback.knownGood)
    const fresh = await run(['updates:trial', store, ...pinned, ...current, '--project', project, '--candidate', next.candidate.id])
    assert.equal(fresh.knownGood.candidateId, next.candidate.id); assert.notEqual(fresh.knownGood.id, abandoned.trial.id)
    assert.notEqual(fresh.knownGood.health.bootId, rollback.knownGood.health.bootId)
    assert.notEqual(fresh.knownGood.health.sessionId, rollback.knownGood.health.sessionId)
    assert.deepEqual(await readFile(retainedImage), Buffer.from(image))
    const cuts = await qualifyHostSlotInterruptions(join(directory, 'six-cuts'), project)
    assert.equal(cuts.length, 6)
    assert.equal(await hash(source), sourceSha256); assert.equal(await hash(binary), sourceSha256)
    return { evidence: 'copied-standalone-host-slots-v1', sourceRevision, sourceSha256, olderSha256, operations: results.length, actualProcessCuts: 7, physicalDeploymentAllowed: false }
  }
  finally { await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'copied-standalone-host-slots-v1', sourceRevision, sourceSha256, olderSha256, results, physicalDeploymentAllowed: false }, null, 2)) }
}
if (import.meta.main) {
  if (process.argv.length !== 5 && process.argv.length !== 6) throw new Error('Use qualify-host-slots.ts NEW_DIRECTORY COMPILED_BINARY SOURCE_PROJECT [OLDER_BINARY]')
  console.log(JSON.stringify(await qualifyPortableHostSlots(resolve(process.argv[2]!), resolve(process.argv[3]!), resolve(process.argv[4]!), process.argv[5] ? resolve(process.argv[5]) : undefined)))
}
