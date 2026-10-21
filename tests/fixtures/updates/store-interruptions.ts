import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { enrollRuntimeTrust } from '../../../resources/functions/drone/updates/enrollment'
import { createRuntimeTrustStore, inspectRuntimeTrustStore, recoverRuntimeTrustStore, refreshRuntimeTrustStore } from '../../../resources/functions/drone/updates/store'
import { platform, repository, target } from './repository'

type Reference = Parameters<typeof inspectRuntimeTrustStore>[0]
type Cut = 'input-committed' | 'metadata-committed'
interface WorkerInput { reference: Reference, repository: string, cut: Cut }
const clock = { source: 'synthetic-independent-clock', read: () => new Date('2030-01-01T00:00:00Z') }

async function worker(mode: string, file: string) {
  const input = JSON.parse(await readFile(file, 'utf8')) as WorkerInput
  if (mode === 'contend') {
    try { await inspectRuntimeTrustStore(input.reference); process.exitCode = 18 }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      console.log(JSON.stringify({ blocked: code === 'SQLITE_BUSY', code }))
      process.exitCode = code === 'SQLITE_BUSY' ? 17 : 19
    }
    return
  }
  if (mode !== 'hold') throw new Error('Unknown interruption worker mode')
  await refreshRuntimeTrustStore({ ...input.reference, repository: input.repository, clock, async onProgress(event) {
    if (event.phase !== input.cut || event.ordinal !== (input.cut === 'input-committed' ? 1 : 0)) return
    console.log(JSON.stringify({ ready: true, phase: event.phase, ordinal: event.ordinal }))
    await Bun.stdin.text()
  } })
  throw new Error('Interruption worker unexpectedly finished')
}

/** Keep generated signed repositories and actual host process outcomes for inspection. No power-loss claim. */
export async function qualifyStoreInterruptions(directory: string) {
  await mkdir(directory, { mode: 0o700 })
  const results = []
  for (const cut of ['input-committed', 'metadata-committed'] as const) {
    const root = join(directory, cut); await mkdir(root, { mode: 0o700 })
    const source = join(root, 'repo'), fixture = await repository(source, { custom: { releaseSequence: 9 } })
    const enrollmentDirectory = join(root, 'enrollment')
    const enrolled = enrollRuntimeTrust({ target, platform, trustedRootSha256: fixture.rootSha256, minimumReleaseSequence: 7, trustedRoot: fixture.rootPath, output: enrollmentDirectory })
    const created = await createRuntimeTrustStore({ enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, output: join(root, 'store') })
    const reference = { enrollmentDirectory, enrollmentSha256: enrolled.enrollmentSha256, directory: join(root, 'store'), storeSha256: created.storeSha256 }
    const file = join(root, 'worker.json')
    await writeFile(file, JSON.stringify({ reference, repository: source, cut } satisfies WorkerInput), { mode: 0o600 })
    const child = Bun.spawn([process.execPath, import.meta.path, 'hold', file], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000)
    const reader = child.stdout.getReader(), decoder = new TextDecoder()
    let stdout = ''
    try {
      while (!stdout.includes('\n')) {
        const part = await reader.read()
        if (part.done) throw new Error('Interruption worker exited before readiness')
        stdout += decoder.decode(part.value, { stream: true })
        if (stdout.length > 4096) throw new Error('Interruption worker output exceeded its bound')
      }
      const ready = JSON.parse(stdout.trim())
      assert.equal(ready.ready, true); assert.equal(ready.phase, cut)
      const contender = spawnSync(process.execPath, [import.meta.path, 'contend', file], { encoding: 'utf8', timeout: 10000 })
      assert.equal(contender.status, 17)
      assert.equal(JSON.parse(contender.stdout).blocked, true)
      child.kill('SIGKILL')
      const exit = await child.exited, signal = child.signalCode
      assert.equal(signal, 'SIGKILL'); assert.notEqual(exit, 0)
      const interrupted = await inspectRuntimeTrustStore(reference)
      assert.equal(interrupted.attempt?.phase, 'pending')
      assert.equal(interrupted.generation, cut === 'input-committed' ? 0 : 1)
      const recovered = await recoverRuntimeTrustStore(reference)
      assert.equal(recovered.generation, 1); assert.equal(recovered.attempt?.phase, 'recovered')
      assert.equal(recovered.releaseFloor, 7)
      const fresh = await refreshRuntimeTrustStore({ ...reference, repository: source, clock })
      assert.equal(fresh.generation, 3); assert.equal(fresh.releaseFloor, 9)
      assert.equal(fresh.attempt?.phase, 'verified'); assert.equal(fresh.physicalDeploymentAllowed, false)
      results.push({ cut, ready, killedExit: exit, killedSignal: signal, contenderExit: contender.status, contender: contender.stdout, interrupted, recovered, fresh })
    }
    finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited
      reader.releaseLock()
      await writeFile(join(root, 'worker.stdout'), stdout)
      await writeFile(join(root, 'worker.stderr'), await new Response(child.stderr).text())
      await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'host-process-interruption-only', results, physicalDeploymentAllowed: false }, null, 2))
    }
  }
  return { evidence: 'host-process-interruption-only', cuts: results.length, physicalDeploymentAllowed: false }
}

if (import.meta.main) {
  if (process.argv.length === 4) await worker(process.argv[2]!, process.argv[3]!)
  else if (process.argv.length === 3) console.log(JSON.stringify(await qualifyStoreInterruptions(resolve(process.argv[2]!))))
  else throw new Error('Use store-interruptions.ts NEW_DIRECTORY')
}
