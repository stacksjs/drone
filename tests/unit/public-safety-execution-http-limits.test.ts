import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

for (const nativeRoutes of [false, true]) for (const scenario of ['limits', 'preflight', 'middleware', 'chunk', 'admission']) test(`native execution HTTP ${scenario} nativeRoutes=${nativeRoutes}`, async () => {
  const evidence = process.env.EXECUTION_HTTP_EVIDENCE
  if (evidence) await mkdir(resolve(evidence), { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(evidence ? resolve(evidence) : tmpdir(), 'drone-incident-access-execution-http-limits-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let settledExitCode: number | null = null, settledAtMs: number | null = null
  let watchdogFired = false, watchdogKill = false, cleanupKill = false, completed = false
  let stdoutWritten = false, stderrWritten = false
  const began = performance.now()
  const report = (message: string, error = false) => {
    try { if (error) console.error(message); else console.log(message) }
    catch {} // Evidence delivery cannot replace a settled child verdict.
  }
  const retain = async (artifact: 'fixture.stdout' | 'fixture.stderr' | 'lifecycle.json', contents: string) => {
    try { await writeFile(join(directory, artifact), contents, { mode: 0o600, flag: 'wx' }); return true }
    catch {
      report(`HTTP_FIXTURE_EVIDENCE_UNAVAILABLE ${JSON.stringify({ scenario, nativeRoutes, artifact })}`, true)
      return false
    }
  }
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-http-limits.ts`, scenario], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), INCIDENT_NATIVE_ROUTES: String(nativeRoutes) }, stdout: 'pipe', stderr: 'pipe',
    })
    const exited = running.exited.then(code => { settledExitCode = code; settledAtMs = performance.now() - began; return code })
    const timeout = setTimeout(() => {
      watchdogFired = true
      if (settledExitCode !== null) return
      watchdogKill = true
      running.kill('SIGKILL')
      report(JSON.stringify({ oracle: 'execution-http-watchdog', scenario, nativeRoutes, pid: running.pid, timeoutMs: 35000, elapsedMs: performance.now() - began, requestedSignal: 'SIGKILL' }), true)
    }, 35000)
    try {
      report(JSON.stringify({ oracle: 'execution-http-fixture-start', scenario, nativeRoutes, pid: running.pid, parentBunVersion: Bun.version, childExecutable: process.execPath, timeoutMs: 35000 }))
      const [code, stdout, stderr] = await Promise.all([exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('{"oracle":')) report(line)
      stdoutWritten = await retain('fixture.stdout', stdout)
      stderrWritten = await retain('fixture.stderr', stderr)
      expect(code, JSON.stringify({ scenario, nativeRoutes, settledExitCode, signal: running.signalCode, watchdogFired, watchdogKill, elapsedMs: performance.now() - began })).toBe(0)
      expect(stdout.includes(`PASS native execution HTTP ${scenario} nativeRoutes=${nativeRoutes}`), 'HTTP fixture completion sentinel is missing; raw output is retained privately').toBe(true)
      completed = true
    }
    finally { clearTimeout(timeout); if (settledExitCode === null) { cleanupKill = true; running.kill('SIGKILL') }; settledExitCode = await exited }
  }
  finally {
    if (child && settledExitCode === null) {
      if (child.exitCode === null && child.signalCode === null) { cleanupKill = true; child.kill('SIGKILL') }
      settledExitCode = await child.exited
    }
    const lifecycle = { scenario, nativeRoutes, pid: child?.pid ?? null, settledExitCode, exitProperty: child?.exitCode ?? null, signal: child?.signalCode ?? null, timeoutMs: 35000, watchdogFired, watchdogKill, cleanupKill, settledAtMs, elapsedMs: performance.now() - began, stdoutWritten, stderrWritten, completed }
    report(JSON.stringify({ oracle: 'execution-http-fixture-exit', ...lifecycle }))
    const lifecycleWritten = await retain('lifecycle.json', JSON.stringify(lifecycle, null, 2))
    if (completed && stdoutWritten && stderrWritten && lifecycleWritten) await rm(directory, { recursive: true, force: true })
    else report(`HTTP_FIXTURE_RETAINED ${directory}`, true)
  }
}, 40000)
