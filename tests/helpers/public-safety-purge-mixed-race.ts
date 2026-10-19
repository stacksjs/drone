import { expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function qualifyPurgeMixedFreezeRace(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-mixed-race-')), children: ReturnType<typeof Bun.spawn>[] = []
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    function run(mode: string, kind?: string) {
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-mixed-race.ts`, mode, ...(kind ? [kind] : [])], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite'), MANAGED_REUSE_DATABASE: mode === 'create' ? '0' : '1' }, stdout: 'pipe', stderr: 'pipe' }); children.push(child)
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 75000)
      const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).finally(() => clearTimeout(timer))
      return { child, result }
    }
    async function marker(name: string, running: ReturnType<typeof run>) {
      const deadline = Date.now() + 60000
      while (!existsSync(join(root, name)) && running.child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      if (!existsSync(join(root, name))) { if (running.child.exitCode === null) running.child.kill('SIGKILL'); const [code, stdout, stderr] = await running.result; throw new Error(`Actual parallel marker ${name} missing (${code})\n${stdout}\n${stderr}`) }
    }
    const create = run('create')
    const [createCode, createOut, createErrors] = await create.result
    expect(createCode, `${createOut}\n${createErrors}`).toBe(0)
    const writers = []
    for (const kind of ['source', 'observation', 'review', 'member', 'managed', 'hold']) {
      const writer = run('writer', kind)
      writers.push({ ...writer, kind }); await marker(`mixed-ready-${kind}`, writer)
    }
    const accepter = run('accept')
    await marker('mixed-acceptor-paused', accepter)
    let stopped = false
    const deadline = Date.now() + 60000
    while (accepter.child.exitCode === null && Date.now() < deadline) {
      const state = Bun.spawnSync(['ps', '-o', 'state=', '-p', String(accepter.child.pid)], { stdout: 'pipe', stderr: 'pipe' })
      if (state.exitCode === 0 && state.stdout.toString().trim().startsWith('T')) { stopped = true; break }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(stopped, 'Acceptance must hold actual common/scope SQLite write CAS in OS stopped state').toBe(true)
    await writeFile(join(root, 'mixed-acceptor-stopped-confirmed'), 'actual-stopped')
    await Promise.all(writers.map(writer => marker(`mixed-held-result-${writer.kind}`, writer)))
    process.kill(accepter.child.pid, 'SIGCONT')
    const [acceptCode, acceptOut, acceptErrors] = await accepter.result
    expect(acceptCode, `${acceptOut}\n${acceptErrors}`).toBe(0)
    expect(acceptOut).toContain('PASS actual genuinely due C acceptance COMMIT')
    await writeFile(join(root, 'mixed-acceptance-commit-confirmed'), 'actual-commit-resolved')
    const results = await Promise.all(writers.map(async writer => ({ kind: writer.kind, result: await writer.result })))
    for (const { kind, result: [code, stdout, stderr] } of results) {
      expect(code, `${kind}\n${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS actual concurrent ${kind} public writer reaches held C CAS and fresh committed freeze refuses`)
    }
    const verify = run('verify')
    const [verifyCode, verifyOut, verifyErrors] = await verify.result
    expect(verifyCode, `${verifyOut}\n${verifyErrors}`).toBe(0)
    expect(verifyOut).toContain('PASS actual six-process mixed freeze matrix')
  }
  finally { for (const child of children) if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}
