import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const nativeRoutes of [false, true]) test(`native execution HTTP nativeRoutes=${nativeRoutes}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-http-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-http.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), INCIDENT_NATIVE_ROUTES: String(nativeRoutes) }, stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 115000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native execution HTTP nativeRoutes=${nativeRoutes}`)
    }
    finally {
      if (running.exitCode === null) running.kill('SIGKILL')
      await running.exited
      clearTimeout(timeout)
    }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(directory, { recursive: true, force: true })
  }
}, 120000)
