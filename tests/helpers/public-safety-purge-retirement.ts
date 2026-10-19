import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function qualifyPurgeConnectionRetirement(): Promise<void> {
  for (const method of ['close', 'reset']) {
    const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-retirement-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
      const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-retirement.ts`, method], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' }); child = running
      const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 75000)
      let code: number, stdout: string, stderr: string
      try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
      finally { clearTimeout(timer) }
      expect(code, `${method}\n${stdout}\n${stderr}`).toBe(0); expect(stdout).toContain(`PASS actual C native ${method} after arm COMMIT refuses`)
    }
    finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
  }
}
