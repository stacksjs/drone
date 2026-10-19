import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const [phase, marker] of [
  ['credit', 'PASS native enrolled freeze blocks genuine post-observer producer credit'],
  ['result', 'PASS native enrolled freeze refuses canonical result before completed acceptance'],
  ['admit', 'PASS native enrolled freeze refuses actual source admission before checked execution guard'],
] as const) test(`native enrolled freeze at ${phase} refuses execution with future retention`, async () => {
  const root = await mkdtemp(join(tmpdir(), `drone-incident-access-execution-freeze-${phase}-`))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-freeze-${phase}.ts`], { cwd: root, env: { APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 90000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      // eslint-disable-next-line no-console
      for (const line of stdout.split('\n')) if (line.startsWith('FREEZE_AUTHORITY ') || line.startsWith('FREEZE_ADMISSION_NATIVE_ORDER ')) console.log(line)
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(marker)
    }
    finally { if (running.exitCode === null) running.kill('SIGKILL'); await running.exited; clearTimeout(timer) }
  }
  finally { if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 100000)
