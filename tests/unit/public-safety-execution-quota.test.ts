import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Public core operations with genuine current native tokens, Gates and SQLite.
// Capacity responses expose no other owner, intent or execution locator.
test('native execution capacity distinguishes retained owner conflicts from other eligible owners', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-quota-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-quota.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 60000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native two-owner finite execution quota and private refusal semantics')
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 70000)
