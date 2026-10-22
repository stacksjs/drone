import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildRuntime } from '../../../resources/functions/drone/runtime/build'
import { enrollRuntimeTrust } from '../../../resources/functions/drone/updates/enrollment'
import { abandonRuntimeFirmwareTrial, createRuntimeTrustStore, inspectRuntimeFirmwareSlots, inspectRuntimeTrustStore, recoverRuntimeTrustStore, reserveRuntimeFirmwareCandidate, rollbackRuntimeFirmwareSlot, trialRuntimeFirmwareCandidate } from '../../../resources/functions/drone/updates/store'
import { repository, target } from './repository'

type Reference = Parameters<typeof inspectRuntimeTrustStore>[0]
const clock = { source: 'independent-fixture-clock', read: () => new Date('2030-01-01T00:00:00Z') }
interface Input { reference: Reference, source: string, project: string, candidateId: string, cut: string, systemClock?: boolean }
async function worker(mode: string, file: string) {
  const input = JSON.parse(await readFile(file, 'utf8')) as Input
  if (mode === 'contend') {
    try { await inspectRuntimeTrustStore(input.reference); process.exitCode = 18 }
    catch (error) { process.exitCode = (error as NodeJS.ErrnoException).code === 'SQLITE_BUSY' ? 17 : 19 }
    return
  }
  if (mode !== 'hold') throw new Error('Unknown host trial worker mode')
  await trialRuntimeFirmwareCandidate({ ...input.reference, repository: input.source, project: input.project, candidateId: input.candidateId, clock: input.systemClock ? { source: 'fixture-system-clock', read: () => new Date() } : clock, async onProgress(event) {
    if (event.phase !== input.cut || event.ordinal !== (input.cut === 'runtime-input-committed' ? 51 : 0)) return
    console.log(JSON.stringify({ ready: true, phase: event.phase, ordinal: event.ordinal }))
    await Bun.stdin.text()
  } })
  throw new Error('Host trial interruption worker unexpectedly completed')
}

/** Actual process cuts and exclusive writers. Retains generated repositories/state when the caller retains directory. */
export async function qualifyHostSlotInterruptions(directory: string, project: string) {
  await mkdir(directory, { mode: 0o700 })
  const build = await buildRuntime({ project }), image = new Uint8Array(await Bun.file(build.artifact).arrayBuffer())
  const git = spawnSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(git.status, 0)
  const sourceRevision = git.stdout.trim(), results = []
  for (const cut of ['slot-selected', 'slot-image-written', 'runtime-started', 'runtime-input-committed', 'final-clock-committed', 'runtime-confirmed']) {
    const root = join(directory, cut); await mkdir(root, { mode: 0o700 })
    const source = join(root, 'repository'), signed = await repository(source, { image, custom: { platform: 'host-neutral-bench-v1', sourceRevision } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform: 'host-neutral-bench-v1', trustedRootSha256: signed.rootSha256, minimumReleaseSequence: 7, trustedRoot: signed.rootPath, output: enrollmentDirectory })
    const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory: join(root, 'store'), storeSha256: created.storeSha256 }
    const first = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock })
    const good = await trialRuntimeFirmwareCandidate({ ...reference, repository: source, clock, project, candidateId: first.candidate!.id })
    const next = await reserveRuntimeFirmwareCandidate({ ...reference, repository: source, clock }), file = join(root, 'worker.json')
    await writeFile(file, JSON.stringify({ reference, source, project, cut, candidateId: next.candidate!.id } satisfies Input), { mode: 0o600 })
    // These are library-process workers, not Buddy boot tests. Keep application preloads out.
    const child = Bun.spawn([process.execPath, import.meta.path, 'hold', file], { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000), reader = child.stdout.getReader()
    let stdout = ''
    try {
      while (!stdout.includes('\n')) {
        const chunk = await reader.read()
        if (chunk.done) throw new Error('Host trial worker exited before readiness')
        stdout += new TextDecoder().decode(chunk.value)
        if (stdout.length > 4096) throw new Error('Host trial worker output exceeded bounds')
      }
      const ready = JSON.parse(stdout.trim()); assert.equal(ready.ready, true); assert.equal(ready.phase, cut)
      const contender = spawnSync(process.execPath, [import.meta.path, 'contend', file], { cwd: root, encoding: 'utf8', timeout: 10000 })
      await writeFile(join(root, 'contender.stdout'), contender.stdout ?? '')
      await writeFile(join(root, 'contender.stderr'), contender.stderr ?? '')
      await writeFile(join(root, 'contender.json'), JSON.stringify({ status: contender.status, signal: contender.signal, error: contender.error?.message }))
      assert.equal(contender.status, 17)
      child.kill('SIGKILL'); const exit = await child.exited
      assert.equal(child.signalCode, 'SIGKILL'); assert.notEqual(exit, 0)
      const stopped = await inspectRuntimeFirmwareSlots(reference), confirmed = cut === 'runtime-confirmed'
      assert.equal(stopped.store.attempt!.phase, 'pending')
      assert.equal(stopped.knownGood!.id, confirmed ? stopped.trial!.id : good.knownGood!.id)
      assert.equal(stopped.store.releaseFloor, 7)
      assert.deepEqual(await readFile(join(reference.directory, 'host-slots', good.knownGood!.id, 'image.bin')), Buffer.from(image))
      await recoverRuntimeTrustStore(reference)
      const recovered = await inspectRuntimeFirmwareSlots(reference)
      assert.deepEqual(recovered.knownGood, stopped.knownGood)
      assert.equal(recovered.trial!.phase, stopped.trial!.phase)
      if (!confirmed) {
        await assert.rejects(rollbackRuntimeFirmwareSlot({ ...reference, repository: source, clock, project }), /explicit recovery/)
        await assert.rejects(abandonRuntimeFirmwareTrial({ ...reference, trialId: '0'.repeat(32) }), /Exact interrupted/)
        const abandoned = await abandonRuntimeFirmwareTrial({ ...reference, trialId: stopped.trial!.id })
        assert.equal(abandoned.trial!.phase, 'abandoned')
        assert.deepEqual(abandoned.knownGood, good.knownGood)
      }
      const rollback = await rollbackRuntimeFirmwareSlot({ ...reference, repository: source, clock, project })
      assert.equal(rollback.knownGood!.candidateId, stopped.knownGood!.candidateId)
      assert.notEqual(rollback.knownGood!.health!.bootId, stopped.knownGood!.health!.bootId)
      assert.notEqual(rollback.knownGood!.health!.sessionId, stopped.knownGood!.health!.sessionId)
      assert.equal(rollback.installed!.id, rollback.knownGood!.id)
      assert.equal(rollback.physicalDeploymentAllowed, false)
      results.push({ cut, exit, signal: child.signalCode, contender: contender.status, stoppedPhase: stopped.trial!.phase, confirmedBeforeCut: confirmed, recoveredWithoutPromotion: true, freshRollback: true })
    }
    finally {
      clearTimeout(timer); child.kill('SIGKILL'); await child.exited
      await writeFile(join(root, 'worker.stdout'), stdout)
      await writeFile(join(root, 'worker.stderr'), await new Response(child.stderr).text())
      await reader.cancel(); reader.releaseLock()
    }
  }
  await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2))
  return results
}

if (import.meta.main) await worker(Bun.argv[2]!, Bun.argv[3]!)
