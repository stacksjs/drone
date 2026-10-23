import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'

test('CI qualifies nominal and failure full-route commands outside the checkout', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../../.github/workflows/ci.yml', import.meta.url)).text()) as {
    jobs: { check: { steps: { run?: string, 'working-directory'?: string }[] } }
  }
  expect(workflow.jobs.check.steps.filter(step => step.run?.startsWith('$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate')).map(step => ({ command: step.run, directory: step['working-directory'] }))).toEqual([
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario host-loss --phase back --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario cruise-pause-resume --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario front-abort --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario pusher-open-circuit --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario back-recovery-hold --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario headwind-2mps --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario tailwind-2mps --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario east-crosswind-limit-2mps --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario west-crosswind-limit-2mps --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario east-crosswind-2mps --electrical', directory: '${{ runner.temp }}' },
    { command: '$GITHUB_WORKSPACE/storage/runtime-build/cli/drone vtol:simulate --scenario west-crosswind-2mps --electrical', directory: '${{ runner.temp }}' },
  ])
})

test('native VTOL full-route command reports qualified initial hover, cruise, back hover and landing', async () => {
  const result = await command(['vtol:simulate']).withTimeout(60000)
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.status).toBe('completed')
  expect(report.scope).toBe('development-lift-and-cruise')
  expect(report.aerodynamicsModel).toBe('projected-incidence-v3')
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

test('native full-route host loss binds the selected back phase and independent lease expiry', async () => {
  const result = await command(['vtol:simulate', '--scenario', 'host-loss', '--phase', 'back', '--electrical']).withTimeout(60000)
  expect(result.exitCode).toBe(0)
  const report = JSON.parse(result.stdout)
  expect(report.scenario).toBe('host-loss')
  expect(report.status).toBe('host-lost')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.scenarioEvidence).toMatchObject({ phase: 'back', injectedAtMs: 30000, taskId: 'back', faultObserved: true })
  expect(report.board.fault).toBe('output-lease-expired')
  expect(report.board.lastCheckedAtMs).toBeGreaterThanOrEqual(30100)
  expect(report.authority.lastCheckedAtMs).toBeLessThan(30000)
  expect(report.mission.state).toBe('running')
  expect(report.landingContact).toBe(false)
  expect(report.boardNeutral).toBe(true)
  expect(report.energy.lastObservation.observedAtMs).toBe(29980)
}, 90000)

test('native named abort and recovery hold retain different failure outcomes with neutral outputs', async () => {
  for (const [scenario, reason] of [['front-abort', 'vtol-abort-landed'], ['back-recovery-hold', 'mission-endurance-exhausted']]) {
    const result = await command(['vtol:simulate', '--scenario', scenario!, '--electrical']).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('blocked')
    expect(report.mission.reason).toBe(reason)
    expect(report.demonstrationMatched).toBe(true)
    expect(report.landingContact).toBe(scenario === 'front-abort')
    expect(report.boardNeutral).toBe(true)
  }
}, 90000)

test('native scenario selectors cannot silently become a nominal demonstration', async () => {
  for (const args of [['--scenario', 'foreign'], ['--scenario', 'host-loss', '--phase', 'foreign'], ['--phase', 'front'], ['--scenario', 'cruise-pause-resume', '--phase', 'back'], ['--scenario', 'back-recover-resume', '--seconds', '60']]) {
    const invalid = await command(['vtol:simulate', ...args]).withTimeout(60000)
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stdout).toBe('')
  }
  const short = await command(['vtol:simulate', '--scenario', 'host-loss', '--seconds', '2']).withTimeout(60000)
  expect(short.exitCode).toBe(1)
  const report = JSON.parse(short.stdout)
  expect(report.status).toBe('duration-exhausted')
  expect(report.demonstrationMatched).toBe(false)
  expect(report.scenarioEvidence.faultObserved).toBe(false)
}, 90000)

test('native wind selectors retain actual exposure and distinct completed or envelope-stop outcomes', async () => {
  for (const [scenario, status] of [['headwind-2mps', 'completed'], ['tailwind-2mps', 'completed'], ['east-crosswind-limit-2mps', 'blocked'], ['west-crosswind-limit-2mps', 'blocked']] as const) {
    const result = await command(['vtol:simulate', '--scenario', scenario, '--electrical']).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.scenario).toBe(scenario)
    expect(report.status).toBe(status)
    expect(report.demonstrationMatched).toBe(true)
    expect(report.windEvidence.worldMatched).toBe(true)
    expect(report.windEvidence.outcomeMatched).toBe(true)
    expect(report.windEvidence.firstAppliedAtMs).toBe(1000)
    expect(report.landingContact).toBe(status === 'completed')
    expect(report.board.expiresAtMs).toBeNull()
    expect(report.board.physicalActuationEnabled).toBe(false)
  }
  const invalid = await command(['vtol:simulate', '--scenario', 'headwind-2mps', '--phase', 'back']).withTimeout(60000)
  expect(invalid.exitCode).toBe(1)
  expect(invalid.stdout).toBe('')
  const short = await command(['vtol:simulate', '--scenario', 'tailwind-2mps', '--seconds', '2']).withTimeout(60000)
  expect(short.exitCode).toBe(1)
  expect(JSON.parse(short.stdout).windEvidence.outcomeMatched).toBe(false)
}, 90000)

test('native wind-aligned plans retain their explicit headings, fresh hover and completed contact', async () => {
  for (const [scenario, heading] of [['east-crosswind-2mps', -Math.PI / 2], ['west-crosswind-2mps', Math.PI / 2]] as const) {
    const result = await command(['vtol:simulate', '--scenario', scenario, '--electrical']).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.status).toBe('completed')
    expect(report.demonstrationMatched).toBe(true)
    expect(report.windEvidence).toMatchObject({ backHeadingRad: heading, backHeadingMatched: true, worldMatched: true, outcomeMatched: true })
    expect(report.transitionEvidence.map((row: { taskId: string }) => row.taskId)).toEqual(['initial-hover', 'front', 'back'])
    expect(report.transitionEvidence.at(-1).eventId).toStartWith(`vtol-${scenario}:`)
    expect(report.landingContact).toBe(true)
    expect(report.boardNeutral).toBe(true)
    expect(report.board.physicalActuationEnabled).toBe(false)
  }
}, 90000)
