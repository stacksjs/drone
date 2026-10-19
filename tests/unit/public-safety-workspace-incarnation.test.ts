import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Genuine Auth/SQL through separate native app bundles catches split incarnation
// state. It does not qualify complete server/Docker packaging or Worker lifecycle.
test('native workspace scope survives independent application bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-scope-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/workspace-incarnation.ts`], {
      cwd: root,
      env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', APP_DEBUG: 'false', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 110000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native workspace scope across independently bundled application entries')
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
