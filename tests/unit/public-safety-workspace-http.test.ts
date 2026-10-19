import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real native loopback routes catch request context, Auth/Gates, SQL and final release.
// They do not establish production identity-provider or physical evidence.
for (const nativeRoutes of [false, true]) for (const fixture of ['workspace-http', 'workspace-stream-limits']) test(`native ${fixture} nativeRoutes=${nativeRoutes}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const current = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${fixture}.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), INCIDENT_NATIVE_ROUTES: String(nativeRoutes) }, stdout: 'pipe', stderr: 'pipe',
    })
    child = current
    const timeout = setTimeout(() => current.kill('SIGKILL'), 55000)
    try {
      const [code, stdout, stderr] = await Promise.all([current.exited, new Response(current.stdout).text(), new Response(current.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native workspace ${fixture === 'workspace-http' ? 'HTTP' : 'stream limits'} nativeRoutes=${nativeRoutes}`)
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)
