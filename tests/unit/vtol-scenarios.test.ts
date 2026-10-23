import { expect, test } from 'bun:test'
import { runVtolSimulation } from '../../resources/functions/drone/vehicles/vtol/simulation'

test('VTOL front IMU loss reports an observed source failure without claiming landing', () => {
  const report = runVtolSimulation('imu-loss', { electrical: true })
  expect(report.status).toBe('blocked')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.scenarioEvidence).toMatchObject({ phase: 'front', injectedAtMs: 13000, taskId: 'front', faultObserved: true })
  expect(report.mission.state).toBe('blocked')
  expect(report.landingContact).toBe(false)
  expect(report.boardNeutral).toBe(true)
  expect(report.physicalFlightEnabled).toBe(false)
})

for (const electrical of [false, true]) for (const [phase, atMs, taskId] of [['front', 13000, 'front'], ['cruise', 20000, 'cruise-leg'], ['back', 30000, 'back'], ['landing', 68000, 'land']] as const) {
  for (const scenario of ['host-loss', 'imu-loss', 'position-loss', 'vehicle-sensor-loss', 'rc-override', 'kill']) test(`${phase} ${scenario} binds the actual loss with electrical=${electrical}`, () => {
    const report = runVtolSimulation(scenario, { phase, electrical })
    expect(report.status).toBe(scenario === 'host-loss' ? 'host-lost' : 'blocked')
    expect(report.scenarioEvidence).toMatchObject({ phase, injectedAtMs: atMs, taskId, faultObserved: true })
    expect(report.demonstrationMatched).toBe(true)
    expect(report.mission.state).not.toBe('completed')
    expect(report.landingContact).toBe(false)
    expect(report.observedFlight).toBe(true)
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(report.board.expiresAtMs).toBeNull()
    expect(report.physicalFlightEnabled).toBe(false)
    if (electrical) expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(0)
    if (scenario === 'host-loss') {
      expect(report.authority.lastCheckedAtMs).toBe(atMs - 20)
      expect(report.board.fault).toBe('output-lease-expired')
      expect(report.board.lastCheckedAtMs).toBeGreaterThanOrEqual(atMs + 100)
    }
    else {
      expect(report.mission.state).toBe('blocked')
      expect(report.scenarioEvidence!.sources!.atMs).toBeGreaterThanOrEqual(atMs)
      expect(report.scenarioEvidence!.sources!.atMs).toBeLessThanOrEqual(atMs + 500)
    }
    if (scenario === 'rc-override') expect(report.authority.events.some(event => event.to === 'manual')).toBe(true)
    if (scenario === 'kill') expect(report.authority.state).toBe('killed')
  })
}

test('unknown or inapplicable selectors and pre-onset duration cannot qualify a fault case', () => {
  expect(() => runVtolSimulation('foreign')).toThrow('Unknown VTOL simulation scenario')
  expect(() => runVtolSimulation('host-loss', { phase: 'foreign' })).toThrow('Unknown VTOL simulation phase')
  expect(() => runVtolSimulation('host-loss', { phase: null } as never)).toThrow('Unknown VTOL simulation phase')
  expect(() => runVtolSimulation('nominal', { phase: 'back' })).toThrow('requires a fault or wind scenario')
  for (const scenario of ['host-loss', 'imu-loss', 'position-loss', 'vehicle-sensor-loss', 'rc-override', 'kill']) {
    const report = runVtolSimulation(scenario, { seconds: 2 })
    expect(report.status).toBe('duration-exhausted')
    expect(report.scenarioEvidence).toMatchObject({ taskId: null, faultObserved: false })
    expect(report.demonstrationMatched).toBe(false)
  }
})

test('cruise pause and resume require both observed operator actions and the full route', () => {
  const report = runVtolSimulation('cruise-pause-resume', { electrical: true })
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.completeTransitions).toBe(true)
  expect(report.operatorEvidence).toMatchObject({ matched: true, observedPaused: true, actions: [{ atMs: 20000, action: 'pause' }, { atMs: 40000, action: 'resume' }] })
  expect(report.operatorEvidence!.tasksBeforeActions).toEqual([{ atMs: 20000, taskId: 'cruise-leg', state: 'running' }, { atMs: 40000, taskId: 'cruise-leg', state: 'paused' }])
  expect(report.operatorEvidence!.phaseMatched).toBe(true)
  expect(report.mission.reason).toBe('landed')
  expect(report.landingContact).toBe(true)
  expect(report.boardNeutral).toBe(true)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(0)
})

test('front abort requires declared recovery, correlated hover and contact with an aborted outcome', () => {
  const report = runVtolSimulation('front-abort', { electrical: true })
  expect(report.status).toBe('blocked')
  expect(report.mission.state).toBe('aborted')
  expect(report.mission.reason).toBe('vtol-abort-landed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.completeTransitions).toBe(false)
  expect(report.transitionEvidence.map(row => row.taskId)).toEqual(['initial-hover', 'recover-hover'])
  expect(report.operatorEvidence).toMatchObject({ matched: true, actions: [{ atMs: 13000, action: 'abort' }], recoveryCorrelated: true })
  expect(report.mission.recovery).toMatchObject({ failedTaskId: 'front', cause: 'operator-abort', triggeredAtMs: 13000 })
  expect(report.landingContact).toBe(true)
  expect(report.boardNeutral).toBe(true)
})

test('back recovery holds qualified hover until explicit resume and preserves its complete budget', () => {
  const report = runVtolSimulation('back-recover-resume', { seconds: 180, electrical: true })
  expect(report.demonstrationMatched).toBe(true)
  expect(report.mission.state).toBe('completed')
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  expect(report.mission.recovery).toMatchObject({ failedTaskId: 'back', cause: 'operator-recover', triggeredAtMs: 30000 })
  expect(report.operatorEvidence).toMatchObject({ actions: [{ atMs: 30000, action: 'recover' }, { atMs: 80000, action: 'resume' }], observedPaused: true, recoveryCorrelated: true, matched: true })
  expect(report.budget.worstCaseMs).toBe(176520)
  expect(report.budget.requiredWh).toBeCloseTo(58.84, 8)
  expect(report.landingContact).toBe(true)
  expect(report.boardNeutral).toBe(true)
})

test('the open-circuit pusher case confirms timeout recovery without inventing cruise or retry', () => {
  const report = runVtolSimulation('pusher-open-circuit', { electrical: true })
  expect(report.status).toBe('completed')
  expect(report.mission.reason).toBe('vtol-recovery-landed')
  expect(report.mission.recovery?.cause).toBe('timeout')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.completeTransitions).toBe(false)
  expect(report.transitionEvidence.map(row => row.taskId)).toEqual(['initial-hover', 'recover-hover'])
  expect(report.operatorEvidence).toMatchObject({ actions: [], recoveryCorrelated: true, pusherOpenCircuitObserved: true, matched: true })
  expect(report.landingContact).toBe(true)
  expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(0)
})

test('unresumed recovery reaches the global endurance limit without a landing claim', () => {
  const report = runVtolSimulation('back-recovery-hold', { electrical: true })
  expect(report.status).toBe('blocked')
  expect(report.mission.reason).toBe('mission-endurance-exhausted')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.landingContact).toBe(false)
  expect(report.boardNeutral).toBe(true)
  expect(report.operatorEvidence).toMatchObject({ actions: [{ atMs: 30000, action: 'recover' }], observedPaused: true, recoveryCorrelated: true, globalEnduranceExpired: true, landingStarted: false, matched: true })
  const short = runVtolSimulation('back-recovery-hold', { seconds: 160 })
  expect(short.status).toBe('duration-exhausted')
  expect(short.demonstrationMatched).toBe(false)
  expect(short.operatorEvidence!.globalEnduranceExpired).toBe(false)
})

for (const electrical of [false, true]) for (const [scenario, reason] of [
  ['cruise-pause-resume', 'landed'], ['front-abort', 'vtol-abort-landed'], ['back-abort', 'vtol-abort-landed'],
  ['front-recover-resume', 'vtol-recovery-landed'], ['back-recover-resume', 'vtol-recovery-landed'],
  ['pusher-open-circuit', 'vtol-recovery-landed'], ['back-recovery-hold', 'mission-endurance-exhausted'],
] as const) test(`${scenario} keeps its declared outcome with electrical=${electrical}`, () => {
  const report = runVtolSimulation(scenario, { electrical })
  expect(report.demonstrationMatched).toBe(true)
  expect(report.operatorEvidence!.matched).toBe(true)
  expect(report.operatorEvidence!.phaseMatched).toBe(true)
  expect(report.mission.reason).toBe(reason)
  expect(report.mission.state).toBe(reason === 'vtol-abort-landed' ? 'aborted' : reason === 'mission-endurance-exhausted' ? 'blocked' : 'completed')
  expect(report.status).toBe(['vtol-abort-landed', 'mission-endurance-exhausted'].includes(reason) ? 'blocked' : 'completed')
  expect(report.landingContact).toBe(reason !== 'mission-endurance-exhausted')
  expect(report.boardNeutral).toBe(true)
  expect(report.physicalFlightEnabled).toBe(false)
  if (electrical) expect(report.energy!.lastObservation!.energyUsedWh).toBeGreaterThan(0)
  if (scenario !== 'cruise-pause-resume') expect(report.operatorEvidence!.recoveryCorrelated).toBe(true)
})

test('operator presets refuse phase selectors and duration that would drop scheduled actions', () => {
  expect(() => runVtolSimulation('front-abort', { phase: 'front' })).toThrow('requires a fault or wind scenario')
  expect(() => runVtolSimulation('cruise-pause-resume', { seconds: 30 })).toThrow('action schedule')
  expect(() => runVtolSimulation('back-recover-resume', { seconds: 60 })).toThrow('action schedule')
  const first = runVtolSimulation('back-abort', { electrical: true })
  first.operatorEvidence!.actions[0]!.atMs = 700
  first.operatorEvidence!.matched = false
  const second = runVtolSimulation('back-abort', { electrical: true })
  expect(second.operatorEvidence!.actions).toEqual([{ atMs: 30000, action: 'abort' }])
  expect(second.demonstrationMatched).toBe(true)
})
