import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'

test('CI runs every standalone VTOL qualification outside the checkout', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text()) as {
    jobs: { check: { steps: { run?: string, 'working-directory'?: string }[] } }
  }
  const steps = workflow.jobs.check.steps.filter(step => step.run?.startsWith('$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:hover'))
  expect(steps.map(step => ({ command: step.run, directory: step['working-directory'] }))).toEqual([
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:hover', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:hover --scenario host-loss', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:hover --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:hover --scenario host-loss --electrical', directory: '${{ runner.temp }}' },
  ])
})

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

test('native VTOL electrical option preserves hover and host-loss scope with measured battery evidence', async () => {
  for (const scenario of ['hover', 'host-loss']) {
    const result = await command(['vtol:hover', '--scenario', scenario, '--electrical']).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.demonstrationMatched).toBe(true)
    expect(report.energy.evidence).toBe('modeled-vehicle-battery-v1')
    expect(report.energy.model).toEqual({ evidence: 'modeled-vehicle-battery-v1', capacityWh: 50, maximumSourceW: 1061 })
    expect(report.energy.lastObservation.energyUsedWh).toBeGreaterThan(0)
    expect(report.energy.lastObservation.capturedAtMs).toBeLessThan(report.energy.lastObservation.observedAtMs)
    expect(report.scope).toBe('development-hover-only')
    expect(report.physicalFlightEnabled).toBe(false)
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    if (scenario === 'host-loss') {
      expect(report.energy.lastObservation.observedAtMs).toBe(2980)
      expect(report.board.fault).toBe('output-lease-expired')
    }
  }
}, 180000)
