import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exported domain functions, actual native Auth/Gate and file SQLite. No physical measurement qualification.
test('native incident source, observation and review records persist atomically under current access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/records.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS native persisted source, explicit observation and append-only review lifecycle')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 180000)

test('native observation migrations preserve existing incident data and constraints', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/records-migration.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS native access data survives generated observation schema upgrade')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 180000)

// One byte-bound stress case exercises the canonical source interface without repeating maximum replay work.
test('canonical source encoding accepts exactly 16 MiB and refuses one additional UTF-8 byte', async () => {
  const { publicSafetyRecordingData } = await import('../../resources/functions/drone/public-safety/evidence')
  // 4093 strings of length4096 plus a final5-byte string encode to exactly16777216 bytes.
  const input = [...Array.from({ length: 4093 }, () => 'a'.repeat(4096)), 'aaaaa']
  expect(new TextEncoder().encode(publicSafetyRecordingData(input)).length).toBe(16777216)
  input[input.length - 1] += 'a'
  expect(() => publicSafetyRecordingData(input)).toThrow('source exceeds 16 MiB')
})
