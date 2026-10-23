import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'

test('CI qualifies both full-route commands outside the checkout', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text()) as {
    jobs: { check: { steps: { run?: string, 'working-directory'?: string }[] } }
  }
  expect(workflow.jobs.check.steps.filter(step => step.run?.startsWith('$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate')).map(step => ({ command: step.run, directory: step['working-directory'] }))).toEqual([
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --electrical', directory: '${{ runner.temp }}' },
  ])
})

test('native VTOL full-route command reports qualified initial hover, cruise, back hover and landing', async () => {
  const result = await command(['vtol:simulate']).withTimeout(60000)
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.status).toBe('completed')
  expect(report.scope).toBe('development-lift-and-cruise')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.transitionEvidence.map((row: { taskId: string, phase: string }) => [row.taskId, row.phase])).toEqual([
    ['initial-hover', 'hover'], ['front', 'cruise'], ['back', 'hover'],
  ])
  for (const row of report.transitionEvidence) {
    expect(row.eventId).toBeString()
    expect(row.reference).toBeString()
    expect(row.outcome).toBe('confirmed')
    expect(row.measurementCapturedAtMs).toBeLessThanOrEqual(row.capturedAtMs)
  }
  expect(report.observedFlight).toBe(true)
  expect(report.landingContact).toBe(true)
  expect(report.mission.state).toBe('completed')
  expect(report.mission.taskId).toBe('land')
  expect(report.mission.reason).toBe('landed')
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.physicalFlightEnabled).toBe(false)
  expect(report.boardOutputsInhibited).toBe(true)
  expect(report).not.toHaveProperty('trace')
  expect(report).not.toHaveProperty('path')
  expect(report).not.toHaveProperty('energy')
}, 90000)

test('native full-route electrical option retains qualified landing and modeled energy evidence', async () => {
  const result = await command(['vtol:simulate', '--electrical']).withTimeout(60000)
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.demonstrationMatched).toBe(true)
  expect(report.completeTransitions).toBe(true)
  expect(report.landingContact).toBe(true)
  expect(report.energy.model).toEqual({ evidence: 'modeled-vehicle-battery-v1', capacityWh: 100, maximumSourceW: 1061 })
  expect(report.energy.lastObservation.energyUsedWh).toBeGreaterThan(0)
  expect(report.energy.lastObservation.capturedAtMs).toBeLessThan(report.energy.lastObservation.observedAtMs)
  expect(report.energy.lastObservation.cutoff).toBe(false)
}, 90000)

test('native full-route command preserves partial outcomes and rejects invalid duration', async () => {
  const short = await command(['vtol:simulate', '--seconds', '2']).withTimeout(60000)
  expect(short.exitCode).toBe(1)
  const report = JSON.parse(short.stdout)
  expect(report.status).toBe('duration-exhausted')
  expect(report.demonstrationMatched).toBe(false)
  expect(report.completeTransitions).toBe(false)
  expect(report.landingContact).toBe(false)
  expect(report.mission.state).toBe('running')
  expect(report.boardNeutral).toBe(true)
  expect(report.transitionEvidence.map((row: { taskId: string }) => row.taskId)).toEqual(['initial-hover'])
  for (const seconds of ['NaN', '1', '181', '2.5']) {
    const invalid = await command(['vtol:simulate', '--seconds', seconds]).withTimeout(60000)
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stdout).toBe('')
  }
}, 90000)
