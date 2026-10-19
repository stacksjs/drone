import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

// Real loopback routes catch middleware, CSRF, body ownership, native identity and JSON wire regressions.
// Disposable file SQLite does not qualify production providers, physical operations or binary purge.
for (const nativeRoutes of [false, true]) for (const scenario of ['lifecycle', 'deadline']) {
  test(`native managed dataset HTTP ${scenario} with nativeRoutes=${nativeRoutes}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
    try {
      const config = join(directory, 'bunfig.toml')
      await writeFile(config, 'preload=[]\n')
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-http.ts`], {
        cwd: directory, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), INCIDENT_NATIVE_ROUTES: String(nativeRoutes), INCIDENT_MANAGED_DEADLINE_ONLY: String(scenario === 'deadline') }, stdout: 'pipe', stderr: 'pipe',
      })
      let timedOut = false
      const started = Date.now()
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 55000)
      let result: [number, string, string]
      try { result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]) }
      finally { clearTimeout(timer) }
      const [code, stdout, stderr] = result
      expect(code, `timedOut=${timedOut}, elapsedMs=${Date.now() - started}, hostLoad=${loadavg().join(',')}\n${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native managed dataset HTTP nativeRoutes=${nativeRoutes} scenario=${scenario}`)
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }, 60000)
}
