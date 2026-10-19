import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Real AFTER UPDATE OF operation_nonce triggers target the final captured fence, later than the transition-trigger qualification.
test('managed final captured nonce fence observes post-trigger phase and generation before filesystem effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-final-fence-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed-final-fence.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' }); child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 105000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    for (const phase of ['prepared', 'complete']) for (const fault of ['nonce', 'generation', 'state']) expect(stdout).toContain(`PASS actual B final nonce UPDATE AFTER trigger ${phase} ${fault}`)
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 120000)
