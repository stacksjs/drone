import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { spawn } from 'node:child_process'

test('native Buddy delivery prints bounded modeled custody, landing and reserve facts', async () => {
  const result = await command(['cargo:deliver']).withTimeout(30000)
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  const report = JSON.parse(result.stdout)
  expect(report.evidence).toBe('owned-cargo-delivery-simulation')
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.delivery.outcome).toBe('received')
  expect(report.landingContact).toBe(true)
  expect(report.load.final.totalMassKg).toBe(1.5)
  expect(report.board.actuators).toEqual([0, 0, 0, 0])
  expect(report.energy.evidence).toBe('declared-mission-power-budget')
  expect(report.energy.worstCaseMs).toBe(81520)
  expect(report.physicalFlightEnabled).toBe(false)
  expect(report.identityAuthenticated).toBe(false)
  expect(result.stdout.trim().split('\n')).toHaveLength(1)
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
}, 40000)


test('native delivery keeps refused and uncertain custody distinct from its completed alternate', async () => {
  for (const scenario of ['recipient-absent', 'site-blocked', 'mechanism-jam', 'receipt-loss', 'foreign-receipt']) {
    const result = await command(['cargo:deliver', '--scenario', scenario]).withTimeout(30000)
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('diverted')
    expect(report.demonstrationMatched).toBe(true)
    expect(report.landingContact).toBe(true)
    expect(report.delivery.outcome).toBe(scenario.includes('receipt') ? 'uncertain' : 'not-released')
    expect(report.mission.payloadFailure.landingTaskId).toBe('alternate-land')
    expect(report.board.actuators).toEqual([0, 0, 0, 0])
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
  }
}, 170000)

test('native delivery reports backup continuity and the actual authority failure outcomes', async () => {
  const cases = [
    ['primary-link-loss', 'completed'], ['both-links-loss', 'blocked'], ['position-loss', 'blocked'], ['imu-loss', 'blocked'], ['vehicle-sensor-loss', 'blocked'],
    ['rc-override', 'blocked'], ['kill', 'blocked'], ['host-loss', 'host-lost'], ['authority-containment', 'blocked'], ['diversion-position-loss', 'blocked'], ['diversion-kill', 'blocked'],
  ]
  for (const [scenario, status] of cases) {
    const result = await command(['cargo:deliver', '--scenario', scenario!]).withTimeout(30000)
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe(status)
    expect(report.demonstrationMatched).toBe(true)
    expect(report.delivery.outcome).toBe(scenario === 'primary-link-loss' ? 'received' : 'not-released')
    expect(report.landingContact).toBe(scenario === 'primary-link-loss')
    expect(report.board.actuators).toEqual([0, 0, 0, 0])
    expect(report.board.expiresAtMs).toBeNull()
    expect(report.authority.hostAvailable).toBe(scenario !== 'host-loss')
    if (scenario === 'host-loss') {
      expect(report.authority.state).toBe('autonomous')
      expect(report.board.fault).toBe('output-lease-expired')
    }
    expect(report.links.scope).toEqual({ vehicleId: 'carrier-a', bootId: 55, sessionId: 123 })
    expect(report.physicalFlightEnabled).toBe(false)
    expect(report.identityAuthenticated).toBe(false)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384)
  }
}, 340000)

test('native delivery final options reject coercion without echoing caller details', async () => {
  for (const flags of [['--scenario', '/private-delivery-sentinel'], ['--scenario', ''], ['--scenario=false'], ['--scenario', 'nominal', '--scenario', 'nominal']]) {
    const result = await command(['cargo:deliver', ...flags]).withTimeout(30000)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Cargo delivery simulation failed: invalid input, unavailable result or output failure\n')
    expect(result.timedOut).toBe(false)
  }
}, 130000)

test('a closed delivery stdout exits with an awaited fixed error and no success payload', async () => {
  const child = spawn(process.execPath, ['bin/drone.ts', 'cargo:deliver'], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.destroy()
  let stderr = '', timedOut = false
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
    if (Buffer.byteLength(stderr) > 8192) child.kill('SIGKILL')
  })
  const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30000)
  let code: number | null
  try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }) }
  finally { clearTimeout(guard) }
  expect(timedOut).toBe(false)
  expect(code).toBe(1)
  expect(stderr).toBe('Cargo delivery simulation failed: invalid input, unavailable result or output failure\n')
}, 40000)
