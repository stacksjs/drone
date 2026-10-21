import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { planFarmingObservation } from '../../resources/functions/drone/agriculture/farming-plan'

const failure = 'Farming planning preview unavailable: invalid declaration, rejected plan or output failure\n'
const example = resolve('examples/farming-plan.json')

async function command(args: string[], entry: 'source' | 'buddy' = 'source', output: 'normal' | 'delayed' | 'closed' | 'both-closed' = 'normal') {
  const path = process.execPath.slice(0, process.execPath.lastIndexOf('/')) + ':' + (process.env.PATH ?? '')
  const child = spawn(entry === 'source' ? process.execPath : './buddy', entry === 'source' ? ['--no-install', 'bin/drone.ts', 'farming:plan', ...args] : ['farming:plan', ...args], {
    cwd: process.cwd(), env: { ...process.env, PATH: path }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = [], stderr: Buffer[] = []
  let stdoutBytes = 0, stderrBytes = 0, overflow = false, timedOut = false
  if (output === 'closed' || output === 'both-closed') child.stdout.destroy()
  if (output === 'both-closed') child.stderr.destroy()
  if (output === 'delayed') child.stdout.pause()
  child.stdout.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, 524289 - stdoutBytes)
    stdoutBytes += chunk.length
    if (remaining) stdout.push(chunk.subarray(0, remaining))
    if (stdoutBytes > 524288) { overflow = true; child.kill('SIGKILL') }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const remaining = Math.max(0, 4097 - stderrBytes)
    stderrBytes += chunk.length
    if (remaining) stderr.push(chunk.subarray(0, remaining))
    if (stderrBytes > 4096) { overflow = true; child.kill('SIGKILL') }
  })
  const resume = output === 'delayed' ? setTimeout(() => child.stdout.resume(), 200) : null
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60000)
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, overflow, timedOut }
  }
  finally {
    clearTimeout(guard)
    if (resume !== null) clearTimeout(resume)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

test('source and native Buddy planning return the complete public JSON through EOF', async () => {
  const expected = JSON.stringify(await planFarmingObservation(readFileSync(example, 'utf8'))) + '\n'
  for (const entry of ['source', 'buddy'] as const) {
    const result = await command([example], entry)
    expect(result.timedOut).toBe(false)
    expect(result.overflow).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(expected)
    expect(result.stdout.split('\n').length).toBe(2)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(524288)
  }
}, 140000)

test('native file admission refuses missing, directory, final symlink, invalid UTF8, BOM and oversized input privately', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'drone-farming-input-'))
  try {
    const invalid = join(directory, 'private-invalid.json'), bom = join(directory, 'bom.json')
    const malformed = join(directory, 'malformed.json'), large = join(directory, 'large.json'), link = join(directory, 'link.json')
    writeFileSync(invalid, new Uint8Array([0xc0, 0xaf]))
    writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(example)]))
    writeFileSync(malformed, '{private-input-sentinel')
    writeFileSync(large, ' '.repeat(262145))
    symlinkSync(example, link)
    for (const input of [join(directory, 'private-missing.json'), directory, link, invalid, bom, malformed, large]) {
      const result = await command([input])
      expect(result.timedOut).toBe(false)
      expect(result.overflow).toBe(false)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(failure)
      expect(result.stderr).not.toContain(directory)
      expect(result.stderr).not.toContain('private-input-sentinel')
    }
  }
  finally { rmSync(directory, { recursive: true, force: true }) }
}, 140000)

test('native planning keeps explicit file usage and rejects invented configuration flags', async () => {
  for (const args of [[], [example, '--scenario', 'nominal'], [example, '--output', 'unused'], [example, '--format', 'json']]) {
    const result = await command(args)
    expect(result.timedOut).toBe(false)
    expect(result.overflow).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toBe('')
  }
  const help = await command(['--help'])
  expect(help.timedOut).toBe(false)
  expect(help.overflow).toBe(false)
  expect(help.exitCode).toBe(0)
  expect(help.stdout).toContain('farming:plan')
  expect(help.stdout).toContain('<request>')
}, 140000)

test('planning awaits delayed stdout and consumes both primary and diagnostic pipe failures', async () => {
  const expected = JSON.stringify(await planFarmingObservation(readFileSync(example, 'utf8'))) + '\n'
  const delayed = await command([example], 'source', 'delayed')
  expect(delayed.timedOut).toBe(false)
  expect(delayed.overflow).toBe(false)
  expect(delayed.exitCode).toBe(0)
  expect(delayed.stderr).toBe('')
  expect(delayed.stdout).toBe(expected)
  const closed = await command([example], 'source', 'closed')
  expect(closed.timedOut).toBe(false)
  expect(closed.overflow).toBe(false)
  expect(closed.exitCode).toBe(1)
  expect(closed.stderr).toBe(failure)
  const both = await command([example], 'source', 'both-closed')
  expect(both.timedOut).toBe(false)
  expect(both.overflow).toBe(false)
  expect(both.exitCode).toBe(1)
}, 200000)
