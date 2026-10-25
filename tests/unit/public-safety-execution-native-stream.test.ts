import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroadcastResponse } from '@stacksjs/realtime/stream'

test('released stream denies an unauthorized subscriber before opening or crediting a stream', async () => {
  let checks = 0, enqueued = 0, closed = 0
  const response = await createBroadcastResponse({
    channels: ['private-native-stream-denied'],
    authorize() { checks++; return false },
    onEnqueue() { enqueued++ },
    onClose() { closed++ },
  })
  expect(response.status).toBe(401)
  expect(await response.text()).toBe('Unauthorized')
  expect(checks).toBe(1)
  expect(enqueued).toBe(0)
  expect(closed).toBe(0)
})

for (const mode of ['source', 'artifact']) test(`native execution stream compatibility ${mode}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-native-stream-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  let completed = false
  try {
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    const running = child = Bun.spawn([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-native-stream.ts`, mode], {
      cwd: directory, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 45000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      if (code !== 0 || !stdout.includes(`PASS native execution stream compatibility ${mode} same hub and subscriber context`)) {
        const records = await Promise.allSettled([
          writeFile(join(directory, 'fixture.stdout'), stdout),
          writeFile(join(directory, 'fixture.stderr'), stderr),
          writeFile(join(directory, 'lifecycle.json'), JSON.stringify({ mode, code, signal: running.signalCode, bun: Bun.version })),
        ])
        for (const record of records) if (record.status === 'rejected') console.error('Native stream failure evidence could not be written', String(record.reason))
      }
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain(`PASS native execution stream compatibility ${mode} same hub and subscriber context`)
      if (mode === 'artifact') {
        expect(stdout).toContain('PASS portable native Action module fallback denial, authority and close cleanup')
        for (const line of stdout.split('\n')) if (line.startsWith('PASS portable native Action ')) console.log(line)
      }
      completed = true
    }
    finally { if (running.exitCode === null) running.kill('SIGKILL'); await running.exited; clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    if (completed) await rm(directory, { recursive: true })
    else console.error(`NATIVE_STREAM_FIXTURE_RETAINED ${directory}`)
  }
}, 50000)
