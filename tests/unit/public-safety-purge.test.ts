import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualifyPurgeProcessRecovery } from '../helpers/public-safety-purge-process'
// Actual native function/Job/Auth/SQLite/FS seam catches durable opt-in and independent DB progress; shared-host refusal is not positive Linux removal evidence.
test('accepted purge enforces native disabled guard and preserves unknown filesystem references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 165000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0); expect(stdout).toContain('PASS actual native')
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
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

test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge reserves counter capacity before irreversible effects', async () => {
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-capacity', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['item-version', 'item-generation', 'purge-version', 'common-version']) expect(stdout).toContain(`PASS controlled historical ${kind} reserves`)
}, 180000)

test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge keeps DB and filesystem arms independent through actual SQL rollback', async () => {
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-sql', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain('PASS actual DB source-result rollback preserves payload while independent accepted filesystem arm completes')
  for (const kind of ['arm', 'result']) expect(stdout).toContain(`PASS actual ${kind} event SQL rollback`)
}, 180000)

// Controlled invalid self-FK metadata remains subject to native FK enforcement and conservative scope validation.
test('accepted purge refuses foreign parent, foreign child and self-parent review chains', async () => {
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-relations', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['foreign-parent', 'foreign-child', 'self-parent', 'review-owner', 'observation-owner']) expect(stdout).toContain(`PASS actual controlled ${kind} review relation`)
}, 180000)

for (const stage of ['aliases-before-result-commit', 'directory-before-result-commit'] as const) {
  test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')(`accepted purge resumes genuine process death at ${stage}`, async () => {
    await qualifyPurgeProcessRecovery(stage)
  }, 180000)
}

for (const stage of ['held-claim', 'stale-read'] as const) {
  test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')(`accepted purge serializes actual independent executors at ${stage}`, async () => {
    const { qualifyPurgeExecutorRace } = await import('../helpers/public-safety-purge-race')
    await qualifyPurgeExecutorRace(stage)
  }, 180000)
}

test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge validates sealed totals before metadata retirement', async () => {
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-seal', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain('PASS actual minimized seal mismatch blocks metadata retirement')
}, 180000)

test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge freezes an actual stopped live B writer across clock rollback', async () => {
  const { qualifyPurgeStoppedWriter } = await import('../helpers/public-safety-purge-writer')
  await qualifyPurgeStoppedWriter()
}, 180000)

for (const stage of ['held-prepare', 'held-publish'] as const) {
  test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')(`accepted purge refuses freeze during actual stopped B ${stage} write authority`, async () => {
    const { qualifyPurgeStoppedWriter } = await import('../helpers/public-safety-purge-writer')
    await qualifyPurgeStoppedWriter(stage)
  }, 180000)
}

test.skipIf(process.platform !== 'darwin' && process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge independently bounds private item UTF8 metadata at write seams', async () => {
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-bounds', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['ordinary', 'artifact', 'arm']) expect(stdout).toContain(`PASS controlled UTF8 oversized ${kind} metadata`)
}, 180000)
