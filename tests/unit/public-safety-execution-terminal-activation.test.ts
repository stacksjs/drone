import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Actual core/Auth/Gates/SQL/Worker; terminal consumer ownership, not HTTP leak proof.
test('native terminal activation refuses thrown, rejected, timed out and denied consumers without retaining ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-terminal-activation-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-terminal-activation.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 90000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('TERMINAL_ACTIVATION ')) console.log(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native terminal activation refuses failure and releases only its observer')
    }
    finally { clearTimeout(timer) }
  }
  finally {
    if (child?.exitCode === null) {
      child.kill('SIGKILL')
      await child.exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 100000)
