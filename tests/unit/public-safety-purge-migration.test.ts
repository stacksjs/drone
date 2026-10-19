import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Every old state is produced with immutable published B services and actual SQLite/filesystem.
// Interrupted/blocked states use fresh-process public reconciliation after genuine SIGKILL barriers.
for (const state of ['complete', 'intent', 'prepared', 'interrupted', 'blocked']) test(`native purge migrations preserve actual published B ${state} evidence`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-migration-'))
  const config = join(root, 'bunfig.toml')
  await writeFile(config, 'preload=[]\n')
  const fixture = `${import.meta.dir}/../fixtures/public-safety-access/purge-migration.ts`
  const env = { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }
  let active: ReturnType<typeof Bun.spawn> | undefined
  const spawn = (mode: string) => Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', fixture, mode, state], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  async function run(mode: string) {
    const child = active = spawn(mode)
    const timeout = setTimeout(() => { if (child.exitCode === null) { try { process.kill(child.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error } } }, 120000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, `${mode} ${state}\n${stdout}\n${stderr}`).toBe(0)
      return stdout
    }
    finally { clearTimeout(timeout); active = undefined }
  }
  try {
    await run('stage')
    if (state === 'complete') await run('seed')
    else {
      const child = active = spawn('seed'), output = new Response(child.stdout).text(), errors = new Response(child.stderr).text()
      const deadline = Date.now() + 120000
      while (!existsSync(join(root, 'kill-ready')) && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      expect(existsSync(join(root, 'kill-ready')), `${state}\n${child.exitCode === null ? 'Native barrier not reached' : `${await output}\n${await errors}`}`).toBe(true)
      process.kill(child.pid, 'SIGKILL')
      await child.exited
      expect(child.signalCode).toBe('SIGKILL')
      await Promise.all([output, errors])
      active = undefined
      if (state === 'interrupted' || state === 'blocked') await run('reconcile')
    }
    await run('capture')
    expect(await run('upgrade')).toContain(`PASS actual published B ${state} schema/data upgrade is lossless`)
  }
  finally {
    if (active?.exitCode === null) {
      try { process.kill(active.pid, 'SIGKILL') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
      await active.exited
    }
    await rm(root, { recursive: true, force: true })
  }
}, 240000)
