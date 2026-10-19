import { expect, test } from 'bun:test'
import { readFileSync, readlinkSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qualifyPurgeProcessRecovery } from '../helpers/public-safety-purge-process'
// Run explicitly in the real privileged PID/proc/mount namespace. An ordinary-suite skip is unqualified, never positive removal evidence.
test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies real process references, mounts and positive namespace removal', async () => {
  requireQualifiedNamespace()
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-purge-namespace-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/purge.ts`, '--require-positive'], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    child = running
    const timer = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 165000)
    let code: number, stdout: string, stderr: string
    try { [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()]) }
    finally { clearTimeout(timer) }
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS actual namespace process reference and bind mount')
    expect(stdout).toContain('PASS actual native Job purge removes accepted files')
  }
  finally { if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(root, { recursive: true, force: true }) }
}, 180000)

function requireQualifiedNamespace(): void {
  expect(process.platform).toBe('linux')
  expect(process.pid).toBe(1)
  expect(readlinkSync('/proc/self/ns/pid')).toBe(readlinkSync('/proc/1/ns/pid'))
  expect(/^NSpid:\s+1\s*$/m.test(readFileSync('/proc/self/status', 'utf8'))).toBe(true)
}

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge retires expired metadata before permitting incident key reuse', async () => {
  requireQualifiedNamespace()
  const { qualifyPurgeMetadata } = await import('../helpers/public-safety-purge-metadata')
  const result = await qualifyPurgeMetadata({ requirePositive: true })
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0)
  expect(result.positiveQualified).toBe(true)
  expect(result.stdout).toContain('FK-safe units before public key reuse')
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge freezes actual mixed public writes and canonical retries', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-mixed', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain('PASS actual mixed public source records member hold managed changes require fresh purge consent and freeze defeats controlled clock rollback')
  expect(stdout).toContain('PASS actual canonical reordered duplicate retry replays one committed human event and stale new operation refuses')
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge recovers genuine SIGKILL after namespace unlink', async () => {
  requireQualifiedNamespace()
  await qualifyPurgeProcessRecovery()
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies actual registered inode faults and manifest transitions', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-faults', 225000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['missing', 'replacement', 'extra', 'symlink', 'hardlink', 'permission', 'partial', 'pending-only', 'two-aliases']) expect(stdout).toContain(`PASS actual controlled registered namespace ${kind}`)
}, 240000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies captured nonce authority against real SQLite triggers', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-critical', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const fault of ['nonce', 'generation', 'phase', 'id']) expect(stdout).toContain(`PASS actual SQLite AFTER UPDATE ${fault} drift`)
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge reserves cumulative planned bytes before each filesystem unit', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-budget', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain('PASS controlled owned partial plans enforce cumulative32MiB reservation')
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge refuses effects when result counter capacity is exhausted', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-capacity', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['item-version', 'item-generation', 'purge-version', 'common-version']) expect(stdout).toContain(`PASS controlled historical ${kind} reserves`)
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies independent filesystem and DB arms through real SQL rollback', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-sql', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain('PASS actual DB source-result rollback preserves payload while independent accepted filesystem arm completes')
  for (const kind of ['arm', 'result']) expect(stdout).toContain(`PASS actual ${kind} event SQL rollback`)
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies captured connection close and reset refusal', async () => {
  requireQualifiedNamespace()
  const { qualifyPurgeConnectionRetirement } = await import('../helpers/public-safety-purge-retirement')
  await qualifyPurgeConnectionRetirement()
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge preserves foreign and changed review ownership chains', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-relations', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['foreign-parent', 'foreign-child', 'self-parent', 'review-owner', 'observation-owner']) expect(stdout).toContain(`PASS actual controlled ${kind} review relation`)
}, 180000)

for (const stage of ['aliases-before-result-commit', 'directory-before-result-commit'] as const) {
  test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')(`accepted purge qualifies real namespace death at ${stage}`, async () => {
    requireQualifiedNamespace()
    await qualifyPurgeProcessRecovery(stage)
  }, 180000)
}

for (const stage of ['held-claim', 'stale-read'] as const) {
  test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')(`accepted purge qualifies independent namespace executors at ${stage}`, async () => {
    requireQualifiedNamespace()
    const { qualifyPurgeExecutorRace } = await import('../helpers/public-safety-purge-race')
    await qualifyPurgeExecutorRace(stage)
  }, 180000)
}

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies sealed totals before namespace metadata retirement', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-seal', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  expect(stdout).toContain('PASS actual minimized seal mismatch blocks metadata retirement')
}, 180000)

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies frozen stopped B writer in real namespace', async () => {
  requireQualifiedNamespace()
  const { qualifyPurgeStoppedWriter } = await import('../helpers/public-safety-purge-writer')
  await qualifyPurgeStoppedWriter()
}, 180000)

for (const stage of ['held-prepare', 'held-publish'] as const) {
  test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')(`accepted purge refuses namespace freeze during actual stopped B ${stage}`, async () => {
    requireQualifiedNamespace()
    const { qualifyPurgeStoppedWriter } = await import('../helpers/public-safety-purge-writer')
    await qualifyPurgeStoppedWriter(stage)
  }, 180000)
}

test.skipIf(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST !== '1')('accepted purge qualifies independent private UTF8 item write bounds', async () => {
  requireQualifiedNamespace()
  const { runPurgeQualificationFixture } = await import('../helpers/public-safety-purge-fixture')
  const { code, stdout, stderr } = await runPurgeQualificationFixture('purge-bounds', 165000)
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  for (const kind of ['ordinary', 'artifact', 'arm']) expect(stdout).toContain(`PASS controlled UTF8 oversized ${kind} metadata`)
}, 180000)
