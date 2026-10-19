import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Controlled actual native Gate scheduling plus genuine production messages/replay.
// This does not claim normal-host timing, HTTP delivery, hard interruption or OS join.
test('native pending owner heartbeat settles before genuine final ACK after real replay deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-heartbeat-owner-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-heartbeat-owner.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 180000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('OWNER_HEARTBEAT ')) console.log(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native pending owner heartbeat refuses real nominal replay after elapsed deadline')
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
}, 190000)
