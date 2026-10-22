import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
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
