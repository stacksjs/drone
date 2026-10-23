import { expect, test } from 'bun:test'
import { createVtolSimulationCase } from '../../resources/functions/drone/vehicles/vtol/simulation'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Shared public case seam: actual plant wind, raw sensors, estimator, mission,
// authority and board loop. These observations do not qualify a measured airframe.
test('the named headwind case observes actual world exposure and completes the original finite route', () => {
  const scenario = createVtolSimulationCase('headwind-2mps', { electrical: true })
  const { result, report } = scenario.run()
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.windEvidence).toMatchObject({ frame: 'LOCAL_NED', windMps: [-2, 0, 0], beginsAtMs: 1000, expectedOutcome: 'completed-route', firstAppliedAtMs: 1000, mismatchSteps: 0, worldMatched: true, outcomeMatched: true })
  expect(report.windEvidence!.appliedSteps).toBeGreaterThan(100)
  expect(report.windEvidence!.lastAppliedAtMs).toBe(result.trace.rows.at(-1)!.observation.nowMs)
  expect(report.transitionEvidence.map(row => row.taskId)).toEqual(['initial-hover', 'front', 'back'])
  expect(report.landingContact).toBe(true)
  expect(report.boardNeutral).toBe(true)
  expect(report.board.physicalActuationEnabled).toBe(false)
  expect(result.trace.rows.at(-1)!.result.reason).toBe('landed')
})

test('the named tailwind completes captured transitions and replay without extending its reserve or deadline', () => {
  const { result, report } = createVtolSimulationCase('tailwind-2mps', { electrical: true }).run()
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.windEvidence).toMatchObject({ windMps: [2, 0, 0], beginsAtMs: 1000, worldMatched: true, outcomeMatched: true })
  expect(report.budget).toEqual({ worstCaseMs: 131520, requiredWh: 43.84 })
  expect(report.transitionEvidence.map(row => row.phase)).toEqual(['hover', 'cruise', 'hover'])
  expect(report.landingContact).toBe(true)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
})

test('the east crosswind limit records the actual back-envelope stop without certifying hover or landing', () => {
  const { result, report } = createVtolSimulationCase('east-crosswind-limit-2mps', { electrical: true }).run()
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('vtol-transition-envelope')
  expect(report.mission.taskId).toBe('back')
  expect(report.mission.state).toBe('blocked')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.windEvidence).toMatchObject({ windMps: [0, 2, 0], expectedOutcome: 'envelope-stop', worldMatched: true, outcomeMatched: true, mismatchSteps: 0 })
  expect(report.transitionEvidence.map(row => row.taskId)).toEqual(['initial-hover', 'front'])
  expect(report.completeTransitions).toBe(false)
  expect(report.landingContact).toBe(false)
  expect(report.boardNeutral).toBe(true)
  expect(report.board.physicalActuationEnabled).toBe(false)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
})

test('the west crosswind limit keeps its own signed world vector and blocked outcome', () => {
  const { report } = createVtolSimulationCase('west-crosswind-limit-2mps').run()
  expect(report.windEvidence).toMatchObject({ windMps: [0, -2, 0], expectedOutcome: 'envelope-stop', worldMatched: true, outcomeMatched: true })
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('vtol-transition-envelope')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.landingContact).toBe(false)
  expect(report.completeTransitions).toBe(false)
  expect(report.boardNeutral).toBe(true)
})

for (const mutation of ['absent', 'early', 'late', 'opposite'] as const) test(`${mutation} world wind cannot qualify under the declared headwind name`, () => {
  const scenario = createVtolSimulationCase('headwind-2mps')
  scenario.profile.faults = (_name, atMs) => ({ windMps: mutation === 'absent' ? [0, 0, 0] : atMs >= (mutation === 'early' ? 800 : mutation === 'late' ? 1200 : 1000) ? [mutation === 'opposite' ? 2 : -2, 0, 0] : [0, 0, 0] })
  const { report } = scenario.run()
  expect(report.windEvidence!.worldMatched).toBe(false)
  expect(report.windEvidence!.mismatchSteps).toBeGreaterThan(0)
  expect(report.demonstrationMatched).toBe(false)
  expect(report.boardNeutral).toBe(true)
})

test('wind selection rejects unknown phases and cannot qualify a partial route', () => {
  expect(() => createVtolSimulationCase('tailwind-2mps', { phase: 'unknown' })).toThrow('Unknown VTOL simulation phase')
  const { report } = createVtolSimulationCase('tailwind-2mps', { seconds: 2 }).run()
  expect(report.status).toBe('duration-exhausted')
  expect(report.windEvidence!.worldMatched).toBe(true)
  expect(report.windEvidence!.outcomeMatched).toBe(false)
  expect(report.demonstrationMatched).toBe(false)
  expect(report.landingContact).toBe(false)
})

test('each wind run owns its declaration, exposure and mutable vehicle session', () => {
  const scenario = createVtolSimulationCase('headwind-2mps', { electrical: true })
  const first = scenario.run().report, original = structuredClone(first)
  first.windEvidence!.windMps[0] = 99
  first.windEvidence!.appliedSteps = 0
  scenario.wind!.windMps[0] = 999
  expect(scenario.run().report).toEqual(original)
})
