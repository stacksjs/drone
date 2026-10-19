import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('native stream compatibility preserves reviewed source pin', async () => {
  const copy = await readFile(join(import.meta.dir, '../../resources/functions/drone/http/native-realtime/stream.ts'), 'utf8')
  const source = copy.slice(copy.indexOf("import { AsyncResource }"))
    .replace("import { getServer } from '@stacksjs/realtime/server-instance'", "import { getServer } from './server-instance'")
  expect(createHash('sha256').update(source).digest('hex')).toBe('85ba655c7a6ec3090bd02da7b747c9cceafbdbcf51987d982f51f2b370b0e8b9')
})

for (const mode of ['source', 'artifact']) test(`native execution stream compatibility ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-native-stream-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-native-stream.ts`, mode], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 45000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native execution stream compatibility ${mode} same hub and subscriber context`)
    }
    finally { if (running.exitCode === null) running.kill('SIGKILL'); await running.exited; clearTimeout(timeout) }
  }
  finally { if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }; await rm(directory, { recursive: true, force: true }) }
}, 50000)
