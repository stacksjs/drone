import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real loopback routes catch middleware, CSRF, body ownership, native identity and JSON wire regressions.
// Disposable file SQLite does not qualify production providers, physical operations or binary purge.
for (const nativeRoutes of [false, true]) {
  test(`native incident HTTP lifecycle with nativeRoutes=${nativeRoutes}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
    try {
      const config = join(directory, 'bunfig.toml')
      await writeFile(config, 'preload=[]\n')
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/http.ts`], {
        cwd: directory, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), INCIDENT_NATIVE_ROUTES: String(nativeRoutes) }, stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native incident HTTP lifecycle nativeRoutes=${nativeRoutes}`)
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }, 60000)
}
