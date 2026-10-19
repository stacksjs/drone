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
