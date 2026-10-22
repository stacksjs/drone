import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnWorkspaceFixture } from '../helpers/workspace-process'

test.skipIf(process.env.EXECUTION_BROWSER_QA !== 'true')('compiled execution panel uses real native routes and a genuine Worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  let owned: ReturnType<typeof spawnWorkspaceFixture> | undefined
  let passed = false
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    owned = spawnWorkspaceFixture([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-browser.ts`], directory, { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), STX_DIR: join(directory, 'stx') })
    const child = owned.child, current = owned
    const timeout = setTimeout(() => { void current.stop().catch(() => {}) }, 100000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS actual execution browser: native live-before-return')
      passed = true
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    await owned?.stop()
    if (passed) await rm(directory, { recursive: true, force: true })
    else console.log(JSON.stringify({ evidence: 'retained-private-browser-fixture', directory }))
  }
}, 110000)

test('execution browser fixture refuses an unguarded directory before database or application writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-execution-browser-guard-'))
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    const child = Bun.spawn([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/execution-browser.ts`], { cwd: directory, env: { ...process.env, DB_DATABASE_PATH: join(directory, 'access.sqlite') }, stdout: 'pipe', stderr: 'pipe' })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr as ReadableStream).text(), new Response(child.stdout as ReadableStream).text()])
    expect(code).not.toBe(0)
    expect(stderr).toContain('AssertionError')
    expect(await Bun.file(join(directory, 'access.sqlite')).exists()).toBe(false)
    expect(await Bun.file(join(directory, 'app/Models/User.ts')).exists()).toBe(false)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
