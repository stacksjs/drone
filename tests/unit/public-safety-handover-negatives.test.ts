import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const focus of ['semantic', 'source-config', 'offer-protocol', 'terminal-protocol', 'byte-guard', 'terminal-null-step', 'incident-retention']) test(`native handover ${focus} qualification`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const fixture = focus === 'incident-retention' ? 'handover-offer-retention.ts' : 'handover-negatives.ts'
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${fixture}`], {
      cwd: directory, env: { ...process.env, HANDOVER_NEGATIVE_CASE: focus, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS ')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 180000)
