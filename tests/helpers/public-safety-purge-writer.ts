import { expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function qualifyPurgeStoppedWriter(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-writer-')), children: ReturnType<typeof Bun.spawn>[] = []
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    function run(mode: string, reuse: boolean) {
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-writer.ts`, mode], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite'), MANAGED_REUSE_DATABASE: reuse ? '1' : '0' }, stdout: 'pipe', stderr: 'pipe' }); children.push(child)
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 75000)
      const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer))
      return { child, result }
    }
    const writer = run('writer', false), deadline = Date.now() + 45000
    while (!existsSync(join(root, 'purge-writer-paused.json')) && writer.child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (!existsSync(join(root, 'purge-writer-paused.json'))) { if (writer.child.exitCode === null) writer.child.kill('SIGKILL'); const [code, stdout, stderr] = await writer.result; throw new Error(`Actual B writer barrier missing (${code})\n${stdout}\n${stderr}`) }
    expect(execFileSync('ps', ['-o', 'stat=', '-p', String(writer.child.pid)], { encoding: 'utf8' }).trim()).toContain('T')
    const accepter = run('accept', true)
    const [acceptCode, acceptOut, acceptErrors] = await accepter.result
    expect(acceptCode, `${acceptOut}\n${acceptErrors}`).toBe(0)
    writer.child.kill('SIGCONT')
    const [writerCode, writerOut, writerErrors] = await writer.result
    expect(writerCode, `${writerOut}\n${writerErrors}`).toBe(0)
    expect(writerOut).toContain('PASS actual stopped B live writer refuses payload')
    const finish = run('finish', true)
    const [finishCode, finishOut, finishErrors] = await finish.result
    expect(finishCode, `${finishOut}\n${finishErrors}`).toBe(0)
    expect(finishOut).toContain('PASS actual accepted prepared B purge converges')
  }
  finally { for (const child of children) if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}
