import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const mode of ['completed', 'canceled', 'quarantine']) test(`native execution lifetime ${mode}`, async () => {
  const evidence = process.env.EXECUTION_LIFETIME_EVIDENCE
  if (evidence) await mkdir(resolve(evidence), { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(evidence ? resolve(evidence) : tmpdir(), 'drone-incident-access-execution-lifetime-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let settledExitCode: number | null = null
  const began = performance.now()
  let deadlineFired = false, cleanupKill = false, completed = false
  let stdoutWritten = false, stderrWritten = false
  const retain = async (artifact: 'fixture.stdout' | 'fixture.stderr' | 'lifecycle.json', value: string) => {
    try { await writeFile(join(root, artifact), value, { mode: 0o600, flag: 'wx' }); return true }
    catch { console.error('LIFETIME_FIXTURE_EVIDENCE_UNAVAILABLE', JSON.stringify({ mode, artifact })); return false }
  }
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-lifetime.ts`, mode], { cwd: root, env: { APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const exited = running.exited.then(code => { settledExitCode = code; return code })
    const timeout = setTimeout(() => {
      if (settledExitCode !== null) return
      deadlineFired = true
      running.kill('SIGKILL')
      console.error('LIFETIME_FIXTURE_DEADLINE', JSON.stringify({ mode, pid: running.pid, timeoutMs: 90000, elapsedMs: performance.now() - began, requestedSignal: 'SIGKILL' }))
    }, 90000)
    try {
      console.log(JSON.stringify({ oracle: 'lifetime-fixture-start', mode, pid: running.pid, timeoutMs: 90000, parentBunVersion: Bun.version, childExecutable: process.execPath }))
      const [code, stdout, stderr] = await Promise.all([exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('{"oracle":')) console.log(line)
      stdoutWritten = await retain('fixture.stdout', stdout)
      stderrWritten = await retain('fixture.stderr', stderr)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native execution lifetime ${mode}`)
      completed = true
    }
    finally { clearTimeout(timeout); if (settledExitCode === null) { cleanupKill = true; running.kill('SIGKILL') }; settledExitCode = await exited }
  }
  finally {
    if (child && settledExitCode === null) {
      if (child.exitCode === null && !child.signalCode) { cleanupKill = true; child.kill('SIGKILL') }
      settledExitCode = await child.exited
    }
    const lifecycle = { mode, pid: child?.pid ?? null, exitCode: settledExitCode, exitProperty: child?.exitCode ?? null, signal: child?.signalCode ?? null, timeoutMs: 90000, deadlineFired, cleanupKill, elapsedMs: performance.now() - began, stdoutWritten, stderrWritten, completed }
    console.log(JSON.stringify({ oracle: 'lifetime-fixture-exit', ...lifecycle }))
    const lifecycleWritten = await retain('lifecycle.json', JSON.stringify(lifecycle, null, 2))
    if (completed && stdoutWritten && stderrWritten && lifecycleWritten) await rm(root, { recursive: true, force: true })
    else console.error('LIFETIME_FIXTURE_RETAINED', root)
  }
}, 100000)
