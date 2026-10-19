import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const nativeRoutes of [false, true]) for (const crossing of ['snapshot-commit', 'snapshot-middleware', 'stream-pull', 'mutation-commit']) test(`actual workspace ${crossing} expiry nativeRoutes=${nativeRoutes}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const current = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/workspace-deadline-http.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), INCIDENT_NATIVE_ROUTES: String(nativeRoutes), WORKSPACE_DEADLINE_CASE: crossing }, stdout: 'pipe', stderr: 'pipe',
    })
    child = current
    const timeout = setTimeout(() => current.kill('SIGKILL'), 30000)
    try {
      const [code, stdout, stderr] = await Promise.all([current.exited, new Response(current.stdout).text(), new Response(current.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS actual workspace ${crossing} expiry nativeRoutes=${nativeRoutes}`)
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(directory, { recursive: true, force: true })
  }
}, 35000)
