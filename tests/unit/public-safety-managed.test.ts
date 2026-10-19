import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Public functions with native Auth/SQLite/files catch lifecycle/byte regressions, not hardware power loss.
test('native managed dataset commits ownership before source-derived bytes and reconciles read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-managed-'))
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/managed.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS actual native managed source-derived dataset publication')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)
