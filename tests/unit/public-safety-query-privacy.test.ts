import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Native query-logger persistence and error logging are the privacy seam, not a config flag.
test('private incident material is excluded from native successful and failed query diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/query-privacy.ts`], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), DB_QUERY_LOGGING_ENABLED: 'true', DB_QUERY_LOGGING_CAPTURE_BINDINGS: 'true' }, stdout: 'pipe', stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 55000)
    let result: [number, string, string]
    try { result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]) }
    finally { clearTimeout(timer) }
    const [code, stdout, stderr] = result
    expect(code, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain('PASS native private query diagnostics excluded while public bound diagnostics persist')
    expect(stdout + stderr).not.toContain('Private diagnostic ')
    expect(stderr).toContain('Query failed:')
    expect(stderr).toContain('diagnostic_public_probe')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
