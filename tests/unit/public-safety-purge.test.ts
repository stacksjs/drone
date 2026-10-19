import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualifyPurgeProcessRecovery } from '../helpers/public-safety-purge-process'
// Actual native function/Job/Auth/SQLite/FS seam catches durable opt-in and independent DB progress; shared-host refusal is not positive Linux removal evidence.
test('accepted purge enforces native disabled guard and preserves unknown filesystem references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0); expect(stdout).toContain('PASS actual native')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

// Real process death observes an actual acknowledged syscall before a rolled-back result, not a reconstructed inode fixture.
test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge resumes genuine process death after unlink before result commit', async () => {
  await qualifyPurgeProcessRecovery()
}, 180000)

// Controlled actual registered inode changes exercise preservation and alias semantics, not observed hardware or crash faults.
test('accepted purge preserves namespace drift and accounts for partial owned files and manifest aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-faults-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-faults.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' }); child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 225000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    for (const kind of ['missing', 'replacement', 'extra', 'symlink', 'hardlink', 'permission']) expect(stdout).toContain(`PASS actual controlled registered namespace ${kind}`)
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 240000)

// Actual SQLite triggers mutate the captured nonce/phase/generation between the write CAS and final synchronous observation.
test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge captured synchronous fence refuses actual SQLite authority drift', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-critical-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-critical.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' }); child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 165000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    for (const fault of ['nonce', 'generation', 'phase', 'id']) expect(stdout).toContain(`PASS actual SQLite AFTER UPDATE ${fault} drift`)
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 180000)

// Real review leaves cross keyset and SQL batch boundaries; it does not disable or replace FK enforcement.
test('accepted purge removes more than one hundred review leaves and audits in bounded native batches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-history-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge-history.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' }); child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 165000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0); expect(stdout).toContain('PASS actual137review FK leaves')
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 180000)
