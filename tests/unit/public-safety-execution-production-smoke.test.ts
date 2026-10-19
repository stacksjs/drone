import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Separate real production-controller cases, native Auth/Gates/SQLite and actual Worker.
// No helper substitute, shortened requested duration, raised budget, HTTP or OS-join claim.
for (const seconds of [100, 120] as const) {
  test(`native production nominal ${seconds} completes and explicitly admits with natural heartbeat checks`, async () => {
    const root = await mkdtemp(join(tmpdir(), `drone-incident-access-execution-production-${seconds}-`))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const config = join(root, 'bunfig.toml')
      await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
      const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-production-smoke.ts`, String(seconds)], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 180000)
      try {
        const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
        // eslint-disable-next-line no-console
        for (const line of stdout.split('\n')) if (line.startsWith('EXECUTION_SMOKE ')) console.log(line)
        expect(code, `${stdout}\n${stderr}`).toBe(0)
        expect(stdout).toContain(`PASS native production nominal ${seconds} actual completion and explicit admission`)
      }
      finally { clearTimeout(timeout) }
    }
    finally {
      if (child?.exitCode === null) {
        child.kill('SIGKILL')
        await child.exited
      }
      await rm(root, { recursive: true, force: true })
    }
  }, 190000)
}
