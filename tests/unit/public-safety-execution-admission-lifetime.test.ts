import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const mode of ['close-first', 'admit-first', 'ttl']) test(`native execution admission lifetime ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-admission-lifetime-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-admission-lifetime.ts`, mode], { cwd: root, env: { APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 90000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('ADMISSION_LIFETIME ')) console.log(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native execution admission lifetime ${mode}`)
    }
    finally { if (running.exitCode === null) running.kill('SIGKILL'); await running.exited; clearTimeout(timer) }
  }
  finally { if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 100000)
