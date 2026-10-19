import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Explicit desktop QA opt-in: CI hosts need not have a Chromium application installed.
test.skipIf(process.env.WORKSPACE_BROWSER_QA !== 'true')('actual rendered workspace with native credentials and routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/workspace-browser.ts`], { cwd: directory, env: { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), STX_DIR: join(directory, 'stx') }, stdout: 'pipe', stderr: 'pipe' })
    const current = child, timeout = setTimeout(() => current.kill('SIGKILL'), 100000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS actual compiled workspace browser')
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    await rm(directory, { recursive: true, force: true })
  }
}, 110000)

test('rendered workspace fixture rejects an unguarded working directory before database or app writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-workspace-browser-guard-'))
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/workspace-browser.ts`], { cwd: directory, env: { ...process.env, DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr as ReadableStream).text(), new Response(child.stdout as ReadableStream).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain('AssertionError')
    expect(await Bun.file(join(directory, 'access.sqlite')).exists()).toBe(false)
    expect(await Bun.file(join(directory, 'app/Models/User.ts')).exists()).toBe(false)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
