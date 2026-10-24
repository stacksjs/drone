import { expect, test } from 'bun:test'
import { getMissionWorkspaceDefinition, missionWorkspacePlot, runMissionWorkspace } from '../../resources/functions/drone/vehicles/workspace'
import { createVtolSimulationCase } from '../../resources/functions/drone/vehicles/vtol/simulation'

test('VTOL workspace records the complete modeled route with capture-bound mode acknowledgements', () => {
  const definition = getMissionWorkspaceDefinition('vtol')
  expect(definition.scenarios).toHaveLength(27)
  const run = runMissionWorkspace('vtol')
  expect(run.status).toBe('completed')
  expect(run.physicalActuationEnabled).toBe(false)
  expect(run.boardNeutral).toBe(true)
  expect(run.rows.at(-1)!.taskId).toBe('land')
  expect(run.rows.some(row => row.positionM && row.positionM[2] < -1)).toBe(true)
  const confirmations = run.rows.flatMap(row => row.vtol?.observation?.outcome === 'confirmed' ? [row.vtol.observation] : [])
  expect(confirmations.map(row => [row.taskId, row.phase])).toEqual([['initial-hover', 'hover'], ['front', 'cruise'], ['back', 'hover']])
  for (const observation of confirmations) {
    const request = run.rows.find(row => row.vtol?.request?.eventId === observation.eventId)!.vtol!.request!
    expect(request.taskId).toBe(observation.taskId)
    expect(request.reference).toBe(observation.reference)
    expect(observation.measurementCapturedAtMs).toBeLessThanOrEqual(observation.capturedAtMs)
    expect(observation.capturedAtMs).toBeLessThan(request.expiresAtMs)
  }
}, 60000)

test('VTOL recovery graph includes the counted failure edge and preserves an aborted landing outcome', () => {
  const definition = getMissionWorkspaceDefinition('vtol', 'back-abort')
  expect(definition.tasks.find(task => task.id === 'back')?.failureEdge).toBe('recover-hover')
  expect(definition.budget.worstCaseMs).toBe(176520)
  const run = runMissionWorkspace('vtol', 'back-abort')
  expect(run.status).toBe('blocked')
  expect(run.rows.at(-1)!.state).toBe('aborted')
  expect(run.rows.at(-1)!.reason).toBe('vtol-abort-landed')
  expect('vtol' in run && run.vtol?.landingContact).toBe(true)
  expect(run.rows.some(row => row.vtol?.action === 'abort' && row.atMs === 30000)).toBe(true)
}, 60000)

test('VTOL energy timeline uses qualified capture epochs and never fills a missing reading from plant truth', () => {
  const run = runMissionWorkspace('vtol', 'vehicle-sensor-loss', { phase: 'landing', electrical: true })
  expect(run.status).toBe('blocked')
  const sampled = run.rows.filter(row => row.vtol?.battery)
  expect(sampled.length).toBeGreaterThan(3000)
  const battery = sampled.at(-1)!.vtol!.battery!
  expect(battery.observedAtMs - battery.capturedAtMs).toBe(120)
  expect(battery.energyUsedWh).toBeGreaterThan(1)
  expect(battery.remainingWhLowerBound).toBeLessThan(100 - battery.energyUsedWh)
  expect(run.rows.at(-1)!.vtol?.battery).toBeNull()
  expect('truthPositionM' in run.rows[0]!).toBe(false)
  expect('finalTruthPositionM' in run).toBe(false)
}, 60000)

test('VTOL host loss retains stale host evidence and held recovery never becomes a completed landing', () => {
  const lost = runMissionWorkspace('vtol', 'host-loss', { phase: 'cruise', electrical: true })
  expect(lost.status).toBe('host-lost')
  expect(lost.maximumTimeMs).toBe(19980)
  expect(lost.snapshotsStale).toBe(true)
  expect(lost.boardFault).toBe('output-lease-expired')
  expect(lost.boardNeutral).toBe(true)
  const held = runMissionWorkspace('vtol', 'back-recovery-hold')
  expect(held.status).toBe('blocked')
  expect(held.fault).toBe('mission-endurance-exhausted')
  expect(held.rows.some(row => row.taskId === 'recover-land' && row.state === 'paused')).toBe(true)
  expect(held.rows.some(row => row.taskId === 'recover-land' && row.state === 'running')).toBe(false)
  expect('vtol' in held && held.vtol?.landingContact).toBe(false)
}, 60000)

test('VTOL choices reject irrelevant phases and do not apply electrical flags to other profiles', () => {
  expect(() => getMissionWorkspaceDefinition('vtol', 'nominal', { phase: 'front' })).toThrow()
  expect(() => getMissionWorkspaceDefinition('vtol', 'imu-loss', { phase: 'unknown' })).toThrow()
  expect(() => getMissionWorkspaceDefinition('ground', 'nominal', { electrical: true })).toThrow()
  expect(() => getMissionWorkspaceDefinition('vtol', 'physical')).toThrow()
})

test('the workspace retains planned wind separately from observed exposure and a blocked crosswind recording', () => {
  const definition = getMissionWorkspaceDefinition('vtol', 'tailwind-2mps', { electrical: true })
  if (!('vtol' in definition)) throw new Error('Expected the VTOL definition')
  expect(definition.vtol!.wind).toEqual({ frame: 'LOCAL_NED', windMps: [2, 0, 0], beginsAtMs: 1000, expectedOutcome: 'completed-route' })
  expect(definition.vtol!.phases).toEqual(['startup', 'front', 'cruise', 'back', 'landing'])
  const run = runMissionWorkspace('vtol', 'west-crosswind-limit-2mps', { electrical: true })
  if (!('vtol' in run)) throw new Error('Expected the VTOL recording')
  expect(run.status).toBe('blocked')
  expect(run.fault).toBe('vtol-transition-envelope')
  expect(run.vtol!.windEvidence).toMatchObject({ windMps: [0, -2, 0], expectedOutcome: 'envelope-stop', worldMatched: true, outcomeMatched: true })
  expect(run.vtol!.demonstrationMatched).toBe(true)
  expect(run.vtol!.landingContact).toBe(false)
  expect(run.rows.at(-1)!.taskId).toBe('back')
  expect(run.rows.at(-1)!.state).toBe('blocked')
  expect(run.boardNeutral).toBe(true)
  expect(run.physicalActuationEnabled).toBe(false)
})

test('workspace wind onset remains a declaration until the selected phase is actually observed', () => {
  const definition = getMissionWorkspaceDefinition('vtol', 'east-crosswind-limit-2mps', { phase: 'landing', electrical: true })
  if (!('vtol' in definition)) throw new Error('Expected VTOL definition')
  expect(definition.vtol!.phase).toBe('landing')
  expect(definition.vtol!.wind).toMatchObject({ phase: 'landing', beginsAtMs: null, expectedOutcome: 'completed-route', backHeadingRad: 0 })
  const run = runMissionWorkspace('vtol', 'east-crosswind-limit-2mps', { phase: 'landing', electrical: true })
  if (!('vtol' in run)) throw new Error('Expected VTOL recording')
  const enteredAt = run.rows.find(row => row.state === 'running' && row.taskId === 'land')!.atMs
  expect(run.vtol!.windEvidence).toMatchObject({ phase: 'landing', phaseEnteredAtMs: enteredAt, beginsAtMs: enteredAt + 4, firstAppliedAtMs: enteredAt + 4, phaseMatched: true, worldMatched: true, outcomeMatched: true })
  expect(run.status).toBe('completed')
  expect(run.vtol!.landingContact).toBe(true)
  expect(run.vtol!.demonstrationMatched).toBe(true)
  expect(run.boardNeutral).toBe(true)
})

test('the shared VTOL case factory runs isolated sessions and retains the CLI report from the same recording', () => {
  const selected = createVtolSimulationCase('imu-loss', { phase: 'back', electrical: true })
  const first = selected.run(), second = selected.run()
  expect(first.report).toEqual(second.report)
  expect(first.result.trace.rows.length).toBe(first.report.recordedMissionRows)
  expect(first.result.path.length).toBe(first.report.evaluatedPathRows)
  expect(first.report.scenarioEvidence?.phase).toBe('back')
  expect(first.report.scenarioEvidence?.sources?.atMs).toBeGreaterThanOrEqual(30000)
  expect(first.report.demonstrationMatched).toBe(true)
  first.result.path[0]!.actuators[0] = 999
  expect(second.result.path[0]!.actuators[0]).not.toBe(999)
}, 60000)

test('the workspace exposes the explicit crosswind back heading with its completed recording', () => {
  const definition = getMissionWorkspaceDefinition('vtol', 'east-crosswind-2mps', { electrical: true })
  expect(definition.planId).toBe('vtol-east-crosswind-2mps')
  expect(definition.tasks.find(task => task.id === 'back')?.headingRad).toBe(-Math.PI / 2)
  const run = runMissionWorkspace('vtol', 'east-crosswind-2mps', { electrical: true })
  if (!('vtol' in run)) throw new Error('Expected VTOL recording')
  expect(run.status).toBe('completed')
  expect(run.vtol!.windEvidence).toMatchObject({ windMps: [0, 2, 0], backHeadingRad: -Math.PI / 2, backHeadingMatched: true, worldMatched: true, outcomeMatched: true })
  expect(run.vtol!.landingContact).toBe(true)
  expect(run.rows.at(-1)!.state).toBe('completed')
  expect(run.boardNeutral).toBe(true)
})


test('workspace projection does not invent a current point when navigation is unavailable', () => {
  const definition = getMissionWorkspaceDefinition('vtol', 'nominal')
  const row = { atMs: 600, state: 'blocked', taskId: 'back', reason: 'estimator-loss', positionM: null, velocityMps: null, targetM: null, payloadRequest: null, payloadAck: null }
  const plot = missionWorkspacePlot(definition, [row])
  expect(plot.current).toBeNull()
  expect(plot.estimated).toBe('')
  expect(Number.isFinite(plot.spanM)).toBe(true)
})


test('the common workspace preserves a planning limit before requested wind onset', () => {
  const run = runMissionWorkspace('vtol', 'planned-west-crosswind-2mps', { phase: 'landing' })
  if (!('vtol' in run)) throw new Error('Expected the VTOL recording')
  expect(run.status).toBe('blocked')
  expect(run.fault).toBe('vtol-transition-aborted')
  expect(run.vtol!.demonstrationMatched).toBe(false)
  expect(run.vtol!.windEvidence).toMatchObject({ phase: 'landing', phaseEnteredAtMs: null, beginsAtMs: null, firstAppliedAtMs: null, appliedSteps: 0, worldMatched: false, outcomeMatched: true, expectedOutcome: 'planning-limit-before-onset' })
  expect(run.rows.flatMap(row => row.vtol?.backCapture ? [row.vtol.backCapture.status] : [])).toEqual(['limit'])
  expect(run.rows.some(row => row.taskId === 'land')).toBe(false)
  expect(run.boardNeutral).toBe(true)
})
