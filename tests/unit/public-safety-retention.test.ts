import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Public custody functions with real native Auth/Gates and isolated file SQLite; no deletion qualification.
test('native custody enrollment and human hold decisions bind current inventory and membership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/retention.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS native custody enrollment and human hold lifecycle')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 180000)


test('native custody inventory and private history enforce roles retries expiry and revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/retention-matrix.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS native custody inventory roles retries rollback races expiry revocation and durability')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 180000)


test('native custody migrations preserve existing records and require explicit enrollment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-custody-upgrade-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const active = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/retention-migration.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    child = active
    timeout = setTimeout(() => { if (active.exitCode === null) { try { process.kill(active.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error } } }, 150000)
    const [code, stdout, stderr] = await Promise.all([active.exited, new Response(active.stdout).text(), new Response(active.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS archived B native APIs seed genuine pre-custody')
    expect(stdout).toContain('PASS actual pending migration ledger applied')
    expect(stdout).toContain('PASS fresh current custody upgrade preserves projections')
    expect(stdout).toContain('PASS native custody upgrade preserves old content without automatic enrollment')
  }
  finally {
    clearTimeout(timeout)
    if (child?.exitCode === null) {
      try { process.kill(child.pid, 'SIGKILL') } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
      await child.exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 180000)
