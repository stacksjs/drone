import { expect } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function qualifyPurgeProcessRecovery(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-process-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const args = [process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-process.ts`]
    const options = { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe' as const, stderr: 'pipe' as const }
    const running = Bun.spawn([...args, 'create'], options); child = running
    const output = new Response(running.stdout).text(), errors = new Response(running.stderr).text()
    const deadline = Date.now() + 90000
    while (!await Bun.file(join(root, 'purge-process-paused.json')).exists() && running.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (!await Bun.file(join(root, 'purge-process-paused.json')).exists()) { running.kill('SIGKILL'); await running.exited; throw new Error(`Actual unlink/result COMMIT barrier was not observed\n${await output}\n${await errors}`) }
    running.kill('SIGKILL'); await running.exited; await Promise.all([output, errors])
    const recovered = Bun.spawn([...args, 'recover'], { ...options, env: { ...options.env, MANAGED_REUSE_DATABASE: '1' } }); child = recovered
    const timer = setTimeout(() => { if (recovered.exitCode === null) recovered.kill('SIGKILL') }, 75000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([recovered.exited, new Response(recovered.stdout).text(), new Response(recovered.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS genuine SIGKILL after unlink before result COMMIT')
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}
