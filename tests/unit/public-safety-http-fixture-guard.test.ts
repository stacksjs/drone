import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Direct execution must reject an unowned project before writing its Session model or opening a database.
for (const fixture of ['http.ts', 'records-http.ts', 'retention-http.ts', 'managed-http.ts', 'purge-http.ts', 'handover-http.ts']) {
  test(`${fixture} rejects a non-fixture working directory without writes`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drone-http-guard-'))
    try {
      const cwd = join(directory, 'non-fixture-project')
      const models = join(cwd, 'app/Models')
      await mkdir(models, { recursive: true })
      const sentinel = '// owned guard regression sentinel: do not replace\n'
      await writeFile(join(models, 'Session.ts'), sentinel)
      const config = join(directory, 'bunfig.toml')
      await writeFile(config, 'preload=[]\n')
      const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${fixture}`], {
        cwd,
        env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(cwd, 'fake.sqlite') },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
      let result: [number, string, string]
      try { result = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]) }
      finally { clearTimeout(timer) }
      const [code, stdout, stderr] = result
      expect(code, `${stdout}\n${stderr}`).not.toBe(0)
      expect(stderr).toContain('AssertionError')
      expect(stderr).toContain('setupIncidentDatabase')
      expect(stderr).toContain('drone-incident-access-')
      expect(await readFile(join(models, 'Session.ts'), 'utf8')).toBe(sentinel)
      expect((await readdir(cwd, { recursive: true })).sort()).toEqual(['app', 'app/Models', 'app/Models/Session.ts'])
      expect((await readdir(directory)).sort()).toEqual(['bunfig.toml', 'non-fixture-project'])
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  }, 15000)
}
