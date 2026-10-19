import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Actual Buddy, native persisted account, RBAC and minted token. This does not
// establish a production identity provider or a physical incident operation.
test('local administrators provision existing incident operators without printing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(root, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/provision.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS native Buddy incident provisioning')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 120000)
