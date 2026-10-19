import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Actual archived C acceptance, native generated migration and awaited Job are the agreed seam.
// This does not qualify physical media erasure, power-loss recovery or managed-file namespace deletion.
test('a genuine accepted C purge survives the native handover audit migration unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-handover-upgrade-'))
  let active: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    for (const phase of ['stage', 'seed', 'upgrade']) {
      const child = active = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/handover-migration.ts`, phase], {
        cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
      })
      const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 60000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        expect(code, `${phase}\n${stdout}\n${stderr}`).toBe(0)
        if (phase === 'upgrade') {
          expect(stdout).toContain('PASS actual archived accepted C purge survives native handover migration')
          expect(stdout).toContain('PASS resumed awaited native purge Job removes accepted DB payload')
        }
      }
      finally { clearTimeout(timeout) }
    }
  }
  finally {
    if (active?.exitCode === null) { active.kill('SIGKILL'); await active.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 180000)

test('accepted v1 purge removes real new handover protocol rows without per-offer copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-incident-access-handover-purge-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(root, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const running = child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/handover-purge.ts`], {
      cwd: root, env: { ...process.env, APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(root, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe',
    })
    const timeout = setTimeout(() => { if (running.exitCode === null) running.kill('SIGKILL') }, 60000)
    try {
      const [code, stdout, stderr] = await Promise.all([running.exited, new Response(running.stdout).text(), new Response(running.stderr).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native offer and recipient acceptance enter fixed v1 audit inventory')
      expect(stdout).toContain('PASS DB-only handover purge makes no positive registered-filesystem or media-erasure claim')
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
