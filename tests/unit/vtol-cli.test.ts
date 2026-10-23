import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'

test('native VTOL hover command preserves nominal and lost-host outcomes with explicit development scope', async () => {
  for (const [scenario, status] of [['hover', 'completed'], ['host-loss', 'host-lost']]) {
    const result = await command(['vtol:hover', '--scenario', scenario!]).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe(status)
    expect(report.scope).toBe('development-hover-only')
    expect(report.transitionsImplemented).toBe(false)
    expect(report.physicalFlightEnabled).toBe(false)
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(report.recordedMissionRows).toBeGreaterThan(100)
    if (scenario === 'host-loss') expect(report.board.fault).toBe('output-lease-expired')
    else expect(report.mission.reason).toBe('landed')
  }
}, 180000)

test('native VTOL command rejects unknown scenarios and preserves insufficient-duration failure', async () => {
  const invalid = await command(['vtol:hover', '--scenario', 'cruise']).withTimeout(60000)
  expect(invalid.exitCode).toBe(1)
  expect(invalid.stdout).toBe('')
  const short = await command(['vtol:hover', '--seconds', '2']).withTimeout(60000)
  expect(short.exitCode).toBe(1)
  const report = JSON.parse(short.stdout)
  expect(report.status).toBe('duration-exhausted')
  expect(report.demonstrationMatched).toBe(false)
  expect(report.mission.state).toBe('running')
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
}, 180000)
