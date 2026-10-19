import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnWorkspaceFixture } from '../helpers/workspace-process'

// Explicit desktop QA opt-in: CI hosts need not have a Chromium application installed.
test.skipIf(process.env.WORKSPACE_BROWSER_QA !== 'true')('actual rendered workspace with native credentials and routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  let owned: ReturnType<typeof spawnWorkspaceFixture> | undefined
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    owned = spawnWorkspaceFixture([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/workspace-browser.ts`], directory, { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), STX_DIR: join(directory, 'stx') })
    const child = owned.child
    const current = owned, timeout = setTimeout(() => { void current.stop().catch(() => {}) }, 100000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS actual compiled workspace browser')
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    await owned?.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 110000)

test('actual native browser fixture controls verify committed records without Chrome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  let owned: ReturnType<typeof spawnWorkspaceFixture> | undefined
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    owned = spawnWorkspaceFixture([process.execPath, `--config=${config}`, '--no-env-file', `${import.meta.dir}/../fixtures/public-safety-access/workspace-browser.ts`], directory, { ...process.env, APP_ENV: 'test', APP_DEBUG: 'false', NODE_ENV: 'test', DB_CONNECTION: 'sqlite', DB_DATABASE_PATH: join(directory, 'access.sqlite'), STX_DIR: join(directory, 'stx'), WORKSPACE_BROWSER_CONTROL_ONLY: 'true' })
    const child = owned.child
    const current = owned, timeout = setTimeout(() => { void current.stop().catch(() => {}) }, 25000)
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('PASS native workspace browser verify control')
    }
    finally { clearTimeout(timeout) }
  }
  finally {
    await owned?.stop()
    await rm(directory, { recursive: true, force: true })
  }
}, 35000)

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

test('fixture timeout cleanup terminates an owned descendant and resistant parent before removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-incident-access-'))
  let owned: ReturnType<typeof spawnWorkspaceFixture> | undefined
  try {
    const config = join(directory, 'bunfig.toml'); await writeFile(config, 'preload=[]\n')
    await writeFile(join(directory, 'descendant.ts'), `import { writeFileSync } from 'node:fs'; process.on('SIGTERM', () => { writeFileSync('descendant-stopped', 'stopped'); process.exit(0) }); writeFileSync('descendant-ready', 'ready'); setInterval(() => {}, 1000)`)
    await writeFile(join(directory, 'parent.ts'), `import { writeFileSync } from 'node:fs'; const child = Bun.spawn([process.execPath, '--config=${config}', '--no-env-file', 'descendant.ts'], { stdout: 'ignore', stderr: 'ignore' }); process.on('SIGTERM', () => {}); writeFileSync('descendant.pid', String(child.pid)); setInterval(() => {}, 1000)`)
    owned = spawnWorkspaceFixture([process.execPath, `--config=${config}`, '--no-env-file', 'parent.ts'], directory, process.env)
    for (let attempt = 0; attempt < 100 && !await Bun.file(join(directory, 'descendant.pid')).exists(); attempt++) await Bun.sleep(25)
    const descendant = Number(await Bun.file(join(directory, 'descendant.pid')).text())
    for (let attempt = 0; attempt < 100 && !await Bun.file(join(directory, 'descendant-ready')).exists(); attempt++) await Bun.sleep(25)
    expect(await Bun.file(join(directory, 'descendant-ready')).exists()).toBe(true)
    await owned.stop()
    expect(await Bun.file(join(directory, 'descendant-stopped')).exists()).toBe(true)
    expect(() => process.kill(descendant, 0)).toThrow()
    expect(await owned.child.exited).toBeGreaterThan(0)
  }
  finally { await owned?.stop(); await rm(directory, { recursive: true, force: true }) }
}, 10000)
