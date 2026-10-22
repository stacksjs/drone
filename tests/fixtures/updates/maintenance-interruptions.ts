import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { continueRuntimeTrustMaintenance, inspectRuntimeTrustStore, recoverRuntimeTrustStore, refreshRuntimeTrustStore, reserveRuntimeFirmwareCandidate } from '../../../resources/functions/drone/updates/store'
import { runBoundedHostProcess } from '../../../resources/functions/host/process'
import { maintenanceScenario } from './maintenance-scenario'

const cuts = ['maintenance-handoff-committed', 'input-committed', 'metadata-committed'] as const
const clock = { source: 'synthetic-independent-maintenance-clock', read: () => new Date('2030-01-01T00:00:00Z') }

function object(value: unknown) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown> }
function text(value: unknown) { assert.equal(typeof value, 'string'); return value as string }
function hex(value: unknown, length: 32 | 64) { const result = text(value); assert.match(result, new RegExp(`^[a-f0-9]{${length}}$`)); return result }
async function input(path: string) {
  const root = dirname(resolve(path)); assert.equal(basename(path), 'worker.json')
  assert.ok(Bun.file(path).size < 16384)
  const value = object(JSON.parse(await readFile(path, 'utf8'))), marker = object(await Bun.file(join(root, 'fixture.json')).json())
  assert.equal(marker.kind, 'maintenance-process-cut-v1'); assert.equal(value.nonce, marker.nonce); hex(value.nonce, 32)
  assert.equal(value.repository, join(root, 'repository')); assert.ok(cuts.some(cut => cut === value.cut))
  const reference = object(value.reference)
  assert.equal(reference.directory, join(root, 'store')); assert.equal(reference.enrollmentDirectory, join(root, 'enrollment'))
  return { cut: value.cut, repository: text(value.repository), previousAttemptId: hex(value.previousAttemptId, 32), reference: { directory: text(reference.directory), enrollmentDirectory: text(reference.enrollmentDirectory), enrollmentSha256: hex(reference.enrollmentSha256, 64), storeSha256: hex(reference.storeSha256, 64) } }
}

async function worker(mode: string, path: string) {
  const value = await input(path)
  if (mode === 'contend') {
    try { await inspectRuntimeTrustStore(value.reference); process.exitCode = 18 }
    catch (error) {
      const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      console.log(JSON.stringify({ blocked: code === 'SQLITE_BUSY', code })); process.exitCode = code === 'SQLITE_BUSY' ? 17 : 19
    }
  }
  else if (mode === 'recover') console.log(JSON.stringify(await recoverRuntimeTrustStore(value.reference)))
  else {
    assert.equal(mode, 'hold')
    await continueRuntimeTrustMaintenance({ ...value.reference, repository: value.repository, previousAttemptId: value.previousAttemptId, acknowledgeUnresolvedInputs: true, clock, async onProgress(event) {
      if (event.phase !== value.cut || event.ordinal !== 0) return
      console.log(JSON.stringify({ ready: true, phase: event.phase, ordinal: event.ordinal }))
      await Bun.stdin.text()
    } })
    throw new Error('Held maintenance worker unexpectedly completed')
  }
}

/** Real SIGKILL, competing writer and fresh-process active-successor recovery. */
export async function qualifyMaintenanceInterruptions(directory: string) {
  directory = resolve(directory); await mkdir(directory, { mode: 0o700 })
  const results = []
  for (const cut of cuts) {
    const root = join(directory, cut); await mkdir(root, { mode: 0o700 })
    const scenario = await maintenanceScenario(root)
    await scenario.signed.publish({ image: scenario.signed.image, version: 3, custom: { releaseSequence: 9 }, rotateTargets: true })
    const path = join(root, 'worker.json'), config = join(root, 'worker.bunfig.toml'), nonce = randomBytes(16).toString('hex')
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ kind: 'maintenance-process-cut-v1', nonce }), { mode: 0o600 })
    await writeFile(path, JSON.stringify({ nonce, cut, reference: scenario.reference, repository: scenario.source, previousAttemptId: scenario.failed.attempt!.id }), { mode: 0o600 })
    await writeFile(config, 'preload=[]\n', { mode: 0o600 })
    const argv = [process.execPath, '--no-env-file', `--config=${config}`, import.meta.path]
    const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }
    const child = Bun.spawn([...argv, 'hold', path], { cwd: root, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    let deadlineFired = false
    const timer = setTimeout(() => { deadlineFired = true; child.kill('SIGKILL') }, 15000)
    const reader = child.stdout.getReader(), decoder = new TextDecoder()
    let stdout = '', stderr: string | undefined
    try {
      while (!stdout.includes('\n')) {
        const part = await reader.read()
        if (part.done) throw new Error('Maintenance worker exited before its requested cut')
        stdout += decoder.decode(part.value, { stream: true }); assert.ok(stdout.length <= 4096)
      }
      assert.deepEqual(JSON.parse(stdout.trim()), { ready: true, phase: cut, ordinal: 0 })
      const contender = await runBoundedHostProcess([...argv, 'contend', path], { cwd: root, env, timeoutMs: 10000, stdoutBytes: 4096, stderrBytes: 4096, label: 'Competing maintenance writer' })
      await writeFile(join(root, 'contender.json'), JSON.stringify(contender, null, 2))
      assert.equal(contender.exitCode, 17); assert.equal(contender.stderr, '')
      assert.deepEqual(JSON.parse(contender.stdout), { blocked: true, code: 'SQLITE_BUSY' })
      child.kill('SIGKILL'); const exitCode = await child.exited
      clearTimeout(timer)
      assert.equal(child.signalCode, 'SIGKILL'); assert.notEqual(exitCode, 0); assert.equal(deadlineFired, false)
      stderr = await new Response(child.stderr).text(); assert.ok(stderr.length <= 65536); assert.equal(stderr, '')
      const interrupted = await inspectRuntimeTrustStore(scenario.reference)
      assert.equal(interrupted.attempt!.phase, 'pending')
      assert.equal(interrupted.maintenanceHandoffs.length, 1)
      assert.deepEqual(interrupted.maintenanceHandoffs[0]!.previousAttempt, scenario.failed.attempt)
      assert.equal(interrupted.maintenanceHandoffs[0]!.nextAttemptId, interrupted.attempt!.id)
      assert.equal(interrupted.releaseFloor, 9)
      await writeFile(join(root, 'interrupted.json'), JSON.stringify(interrupted, null, 2))
      const recoveredProcess = await runBoundedHostProcess([...argv, 'recover', path], { cwd: root, env, timeoutMs: 15000, stdoutBytes: 65536, stderrBytes: 4096, label: 'Fresh maintenance recovery process' })
      await writeFile(join(root, 'recovery-process.json'), JSON.stringify(recoveredProcess, null, 2))
      assert.equal(recoveredProcess.exitCode, 0); assert.equal(recoveredProcess.stderr, '')
      const recovered = await inspectRuntimeTrustStore(scenario.reference)
      assert.deepEqual(JSON.parse(recoveredProcess.stdout), recovered)
      assert.equal(recovered.attempt!.phase, 'recovered'); assert.equal(recovered.attempt!.id, interrupted.attempt!.id)
      assert.deepEqual(recovered.maintenanceHandoffs[0]!.previousAttempt, scenario.failed.attempt)
      assert.equal(recovered.metadata.find(row => row.role === 'root')!.version, cut === 'maintenance-handoff-committed' ? 1 : 2)
      assert.equal(recovered.releaseFloor, 9)
      const fresh = await refreshRuntimeTrustStore({ ...scenario.reference, repository: scenario.source, clock })
      assert.equal(fresh.attempt!.phase, 'verified'); assert.equal(fresh.releaseFloor, 9)
      assert.deepEqual(fresh.maintenanceHandoffs[0]!.previousAttempt, scenario.failed.attempt)
      const prepared = await reserveRuntimeFirmwareCandidate({ ...scenario.reference, repository: scenario.source, clock })
      assert.equal(prepared.stateFormat, 4); assert.equal(prepared.candidate!.phase, 'prepared')
      assert.equal(prepared.candidate!.integrity, 'recorded-bytes-match'); assert.equal(prepared.candidate!.currentTrustValidated, false)
      results.push({ cut, pid: child.pid, exitCode, signal: child.signalCode, deadlineFired, contenderExit: contender.exitCode, previous: scenario.failed, interrupted, recovered, fresh, prepared })
      await writeFile(join(directory, 'qualification.json'), JSON.stringify({ evidence: 'maintenance-host-process-cuts-v1', results, physicalDeploymentAllowed: false }, null, 2))
    }
    finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGKILL')
      await child.exited; reader.releaseLock()
      await writeFile(join(root, 'worker.stdout'), stdout)
      if (stderr === undefined) stderr = await new Response(child.stderr).text()
      await writeFile(join(root, 'worker.stderr'), stderr)
    }
  }
  return { evidence: 'maintenance-host-process-cuts-v1', cuts: results.length, physicalDeploymentAllowed: false }
}

if (import.meta.main) {
  if (process.argv.length === 4) await worker(process.argv[2]!, process.argv[3]!)
  else if (process.argv.length === 3) console.log(JSON.stringify(await qualifyMaintenanceInterruptions(process.argv[2]!)))
  else throw new Error('Use maintenance-interruptions.ts NEW_DIRECTORY')
}
