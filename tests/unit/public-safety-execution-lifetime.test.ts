import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const mode of ['completed', 'canceled', 'quarantine']) test(`native execution lifetime ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-lifetime-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  const began = performance.now()
  let deadlineFired = false, cleanupKill = false, completed = false
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-lifetime.ts`, mode], { cwd: root, env: { APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => {
      if (running.exitCode !== null) return
      deadlineFired = true
      running.kill('SIGKILL')
      console.error('LIFETIME_FIXTURE_DEADLINE', JSON.stringify({ mode, pid: running.pid, timeoutMs: 90000, elapsedMs: performance.now() - began, requestedSignal: 'SIGKILL' }))
    }, 90000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      await writeFile(join(root, 'fixture.stdout'), stdout, { mode: 0o600 })
      await writeFile(join(root, 'fixture.stderr'), stderr, { mode: 0o600 })
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('{"oracle":')) console.log(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native execution lifetime ${mode}`)
      completed = true
    }
    finally { clearTimeout(timeout); if (running.exitCode === null) { cleanupKill = true; running.kill('SIGKILL') }; await running.exited }
  }
  finally {
    if (child?.exitCode === null) { cleanupKill = true; child.kill('SIGKILL'); await child.exited }
    const lifecycle = { mode, pid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null, timeoutMs: 90000, deadlineFired, cleanupKill, elapsedMs: performance.now() - began, completed }
    console.log(JSON.stringify({ oracle: 'lifetime-fixture-exit', ...lifecycle }))
    try { await writeFile(join(root, 'lifecycle.json'), JSON.stringify(lifecycle, null, 2), { mode: 0o600 }) }
    catch { console.error('LIFETIME_FIXTURE_EVIDENCE_UNAVAILABLE', JSON.stringify({ mode })) }
    if (completed) await rm(root, { recursive: true, force: true })
    else console.error('LIFETIME_FIXTURE_RETAINED', root)
  }
}, 100000)
