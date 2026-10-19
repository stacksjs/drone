import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Public workspace reads use genuine native Auth/Gates and disposable file SQLite.
// They do not qualify wire streaming, browser rendering or physical observation.
test('native workspace composes one current bounded incident view under real authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-workspace-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/workspace.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 90000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native workspace coherent bounded selected-source and viewer projection')
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 120000)

for (const [fixture, title, marker] of [
  ['workspace-context', 'native workspace preserves independent sources, cutoffs, roster and current staging authority', 'PASS native workspace context, source staging, authority and byte bounds'],
  ['workspace-updates', 'native workspace refresh hints follow actual commit and never rollback or replay', 'PASS native workspace after-COMMIT hints, rollback, exact replay and replay-buffer refusal'],
  ['workspace-deadline', 'native workspace checks actual post-COMMIT token, incident and pending-offer deadlines', 'PASS native workspace actual token, incident and offer COMMIT expiry'],
] as const) {
  test(title, async () => {
    const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-workspace-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
      const running = child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/${fixture}.ts`], { cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
      const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 90000)
      try {
        const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
        expect(code, `${stdout}\n${stderr}`).toBe(0)
        expect(stdout).toContain(marker)
      }
      finally { clearTimeout(timeout) }
    }
    finally {
      if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
      await rm(root, { recursive: true, force: true })
    }
  }, 120000)
}
