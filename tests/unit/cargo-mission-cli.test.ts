import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

test('native Buddy executes an explicit cargo mission file and reports the configured modeled delivery', async () => {
  const result = await command(['cargo:mission', 'examples/cargo-delivery.json']).withTimeout(30000)
  expect(result.timedOut).toBe(false)
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  const report = JSON.parse(result.stdout)
  expect(report.status).toBe('completed')
  expect(report.delivery).toMatchObject({ outcome: 'received', containerId: 'parcel-150g', siteId: 'declared-site', recipientId: 'declared-recipient' })
  expect(report.configuration.id).toBe('operator-cargo-route')
  expect(report.load.initial.totalMassKg).toBe(1.65)
  expect(report.load.final.totalMassKg).toBe(1.5)
  expect(report.landingContact).toBe(true)
  expect(report.board.actuators).toEqual([0, 0, 0, 0])
  expect(report.physicalFlightEnabled).toBe(false)
  expect(report.identityAuthenticated).toBe(false)
  expect(result.stdout.trim().split('\n')).toHaveLength(1)
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
}, 40000)

test('native configured cargo reports alternate and post-release outcomes with exit2', async () => {
  for (const [scenario, status, custody] of [['site-blocked', 'diverted', 'not-released'], ['after-release-host-loss', 'host-lost', 'uncertain'], ['after-receipt-kill', 'blocked', 'received']]) {
    const result = await command(['cargo:mission', 'examples/cargo-delivery.json', '--scenario', scenario!]).withTimeout(30000)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toBe('')
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe(status)
    expect(report.delivery.outcome).toBe(custody)
    expect(report.demonstrationMatched).toBe(true)
    expect(report.configuration.id).toBe('operator-cargo-route')
    expect(report.board.actuators).toEqual([0, 0, 0, 0])
  }
}, 100000)

test('native configured cargo refuses malformed, oversized and symlink requests without caller details', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-cargo-mission-'))
  try {
    const invalid = join(root, 'invalid.json'), oversized = join(root, 'oversized.json'), unicode = join(root, 'unicode.json'), link = join(root, 'link.json')
    await writeFile(invalid, '{"private-sentinel":"/operator/private"}')
    await writeFile(oversized, ' '.repeat(16385))
    await writeFile(unicode, new Uint8Array([255]))
    await symlink(invalid, link)
    for (const path of [invalid, oversized, unicode, link, root, join(root, 'private-missing')]) {
      const result = await command(['cargo:mission', path]).withTimeout(30000)
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('Cargo mission simulation unavailable: invalid declaration, rejected route or output failure\n')
    }
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 190000)

test('a closed configured cargo stdout retains failure and awaits its fixed diagnostic', async () => {
  const child = spawn(process.execPath, ['bin/drone.ts', 'cargo:mission', 'examples/cargo-delivery.json'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.destroy()
  let stderr = '', timedOut = false
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); if (Buffer.byteLength(stderr) > 8192) child.kill('SIGKILL') })
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30000)
  let code: number | null
  try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
  finally { clearTimeout(guard) }
  expect(timedOut).toBe(false)
  expect(code).toBe(1)
  expect(stderr).toBe('Cargo mission simulation unavailable: invalid declaration, rejected route or output failure\n')
}, 40000)
