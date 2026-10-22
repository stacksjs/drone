import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { captureColdBuild, coldBuildCaptureBytes, coldBuildQualificationTimeout } from '../helpers/runtime-cold-build-supervisor'

const options = { cwd: process.cwd(), env: process.env, timeoutMs: 15000 }
const run = (source: string, timeoutMs = options.timeoutMs) => captureColdBuild([process.execPath, '-e', source], { ...options, timeoutMs })
function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
}

test.skipIf(process.platform === 'win32')('aggregate capture drains both real streams and preserves a native nonzero exit', async () => {
  const result = await run("await Promise.all([Bun.write(Bun.stdout, 'o'.repeat(262144)), Bun.write(Bun.stderr, 'e'.repeat(262144))]); process.exit(7)")
  expect(result.exitCode).toBe(7)
  expect(result.stdout).toBe('o'.repeat(262144))
  expect(result.stderr).toBe('e'.repeat(262144))
  expect(result.failure).toBeUndefined()
  expect(result.stopRequested).toBe(false)
  expect(result.rootCleanupRequired).toBe(false)
  expect(result.rootGroupRemaining).toBe(false)
  expect(groupExists(result.pid)).toBe(false)
}, 25000)

test.skipIf(process.platform === 'win32')('aggregate deadline retains actual child output and settles its owned group', async () => {
  const result = await run("await Bun.write(Bun.stdout, 'ready\\n'); setInterval(() => {}, 1000)", 2000)
  expect(result.stdout).toBe('ready\n')
  expect(result.exitCode).not.toBe(0)
  expect(result.deadlineReached).toBe(true)
  expect(result.stopRequested).toBe(true)
  expect(String(result.failure)).toContain('timed out')
  expect(result.rootGroupRemaining).toBe(false)
  expect(groupExists(result.pid)).toBe(false)
}, 15000)

test.skipIf(process.platform === 'win32')('actual output overflow retains the bounded prefix and terminates the writer', async () => {
  const result = await run("await Bun.write(Bun.stdout, 'x'.repeat(2000001)); setInterval(() => {}, 1000)")
  expect(Buffer.byteLength(result.stdout)).toBe(coldBuildCaptureBytes)
  expect(result.stdout).toBe('x'.repeat(coldBuildCaptureBytes))
  expect(result.exitCode).not.toBe(0)
  expect(String(result.failure)).toContain('stdout exceeds byte limit')
  expect(result.deadlineReached).toBe(false)
  expect(result.rootGroupRemaining).toBe(false)
  expect(groupExists(result.pid)).toBe(false)
}, 25000)

test.skipIf(process.platform === 'win32')('exited parent with an actual inherited pipe is refused and its descendant group settles', async () => {
  const result = await run("const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'inherit', stderr: 'inherit' }); console.log(child.pid); process.exit(0)")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toMatch(/^\d+\n$/)
  expect(result.deadlineReached).toBe(false)
  expect(result.stopRequested).toBe(true)
  expect(String(result.failure)).toContain('inherited output pipes did not settle')
  expect(result.rootGroupRemaining).toBe(false)
  expect(groupExists(result.pid)).toBe(false)
}, 25000)

test('qualification derives its aggregate budget without changing the individual command limit', () => {
  expect(coldBuildQualificationTimeout(120000, 5000)).toBe(390000)
  expect(coldBuildQualificationTimeout(120000, 20000)).toBe(405000)
  expect(() => coldBuildQualificationTimeout(120001, 5000)).toThrow('command budget')
})

test.skipIf(process.platform === 'win32')('external cancellation settles an actual subject and inherited descendant before the deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-qualification-cancel-'))
  const controller = new AbortController()
  const marker = join(root, 'ready.json'), config = join(root, 'bunfig.toml')
  await writeFile(config, 'preload=[]\n')
  const source = `import { writeFileSync } from 'node:fs'; const child = Bun.spawn([process.execPath, '--config=${config}', '--no-env-file', '-e', 'setInterval(() => {}, 1000)'], { stdout: 'inherit', stderr: 'inherit' }); writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, child: child.pid })); setInterval(() => {}, 1000)`
  const captureOptions = { cwd: root, env: process.env, timeoutMs: 4000, signal: controller.signal }
  const pending = captureColdBuild([process.execPath, `--config=${config}`, '--no-env-file', '-e', source], captureOptions)
  try {
    const deadline = performance.now() + 2000
    while (!await Bun.file(marker).exists()) { if (performance.now() > deadline) throw new Error('Actual cancellation subject did not start'); await Bun.sleep(5) }
    const observed = JSON.parse(await readFile(marker, 'utf8')) as { pid: number, child: number }
    process.kill(observed.pid, 0); process.kill(observed.child, 0)
    controller.abort()
    const result = await pending
    expect(result.pid).toBe(observed.pid)
    expect(result.deadlineReached).toBe(false)
    expect(result.stopRequested).toBe(true)
    expect(String(result.failure)).toContain('aborted')
    expect(result.rootGroupRemaining).toBe(false)
    expect(groupExists(result.pid)).toBe(false)
    expect(() => process.kill(observed.child, 0)).toThrow()
  }
  finally { controller.abort(); await pending; await rm(root, { recursive: true }) }
}, 15000)
