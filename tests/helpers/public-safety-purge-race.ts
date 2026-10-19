import { expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function qualifyPurgeExecutorRace(stage: 'held-claim' | 'stale-read'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-race-')), children: ReturnType<typeof Bun.spawn>[] = []
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    async function run(mode: string, reuse: boolean) {
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-race.ts`, mode, stage], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite'), MANAGED_REUSE_DATABASE: reuse ? '1' : '0' }, stdout: 'pipe', stderr: 'pipe' }); children.push(child)
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 75000)
      const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer))
      return { child, result }
    }
    const setup = await run('create', false)
    const [setupCode, setupOutput, setupErrors] = await setup.result
    expect(setupCode, `${setupOutput}\n${setupErrors}`).toBe(0)
    const first = await run('first', true), deadline = Date.now() + 45000
    while (!existsSync(join(root, 'purge-race-paused.json')) && first.child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    if (!existsSync(join(root, 'purge-race-paused.json'))) { if (first.child.exitCode === null) first.child.kill('SIGKILL'); const [code, stdout, stderr] = await first.result; throw new Error(`Actual ${stage} barrier not observed (${code})\n${stdout}\n${stderr}`) }
    let stopped = false
    while (first.child.exitCode === null && Date.now() < deadline) {
      const state = Bun.spawnSync(['ps', '-o', 'state=', '-p', String(first.child.pid)], { stdout: 'pipe', stderr: 'pipe' })
      if (state.exitCode === 0 && state.stdout.toString().trim().startsWith('T')) { stopped = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(stopped, 'Marker must be followed by actual OS stopped state before the competing operation').toBe(true)
    const second = await run('second', true)
    const [secondCode, secondOutput, secondErrors] = await second.result
    expect(secondCode, `${secondOutput}\n${secondErrors}`).toBe(0)
    process.kill(first.child.pid, 'SIGCONT')
    const [firstCode, firstOutput, firstErrors] = await first.result
    expect(firstCode, `${firstOutput}\n${firstErrors}`).toBe(0)
    const finish = await run('finish', true)
    const [finishCode, finishOutput, finishErrors] = await finish.result
    expect(finishCode, `${finishOutput}\n${finishErrors}`).toBe(0)
    expect(finishOutput).toContain(`PASS actual competing ${stage} executors converge`)
  }
  finally { for (const child of children) if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}
