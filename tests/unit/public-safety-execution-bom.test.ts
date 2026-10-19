import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('supplemental BOM-prefixed genuine result is refused without admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-execution-bom-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-protocol-bom.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 90000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('EXECUTION_BOM ')) console.log(line)
      // eslint-disable-next-line no-console
      for (const line of stderr.split('\n')) if (line.startsWith('EXECUTION_PROTOCOL_WORKER_ERROR ')) console.error(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS supplemental BOM-prefixed genuine result is refused without admission')
    }
    finally { clearTimeout(timer) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 100000)
