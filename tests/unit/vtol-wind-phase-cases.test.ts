import { expect, test } from 'bun:test'
import { createVtolSimulationCase } from '../../resources/functions/drone/vehicles/vtol/simulation'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Shared public case seam: phase selection must schedule actual world weather
// from observed runtime entry. This does not qualify arbitrary weather or hardware.
test('a fixed north crosswind beginning only at landing reports the completed phase-specific route', () => {
  const scenario = createVtolSimulationCase('east-crosswind-limit-2mps', { phase: 'landing', electrical: true })
  const { result, report } = scenario.run()
  const entry = result.trace.rows.find(row => row.result.state === 'running' && row.result.taskId === 'land')!
  expect(entry).toBeDefined()
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.windEvidence).toMatchObject({ phase: 'landing', phaseEnteredAtMs: entry.observation.nowMs, beginsAtMs: entry.observation.nowMs + 4, firstAppliedAtMs: entry.observation.nowMs + 4, expectedOutcome: 'completed-route', backHeadingRad: 0, backHeadingMatched: true, phaseMatched: true, worldMatched: true, outcomeMatched: true })
  expect(report.landingContact).toBe(true)
  expect(report.completeTransitions).toBe(true)
  expect(report.boardNeutral).toBe(true)
  expect(report.budget).toEqual({ worstCaseMs: 131520, requiredWh: 43.84 })
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
})

const winds = ['headwind-2mps', 'tailwind-2mps', 'east-crosswind-limit-2mps', 'west-crosswind-limit-2mps', 'east-crosswind-2mps', 'west-crosswind-2mps'] as const
const entries = [{ phase: 'front', task: 'front' }, { phase: 'cruise', task: 'cruise-leg' }, { phase: 'back', task: 'back' }, { phase: 'landing', task: 'land' }] as const
for (const name of winds) for (const entry of entries) test(`${name} exposes genuine ${entry.phase} onset and its distinct route outcome`, () => {
  const scenario = createVtolSimulationCase(name, { phase: entry.phase, electrical: true }), factory = scenario.profile.createSession
  let enteredAt: number | null = null, firstApplied: number | null = null, mismatch = 0
  const vector = scenario.wind!.windMps
  scenario.profile.createSession = () => {
    const session = factory()
    return { ...session, createController() {
      const controller = session.createController()
      return { step(context) {
        if (enteredAt === null && context.enabled && context.mission.state === 'running' && context.mission.taskId === entry.task) enteredAt = context.nowMs
        return controller.step(context)
      } }
    }, createPlant() {
      const plant = session.createPlant()
      let atMs = 600
      return { snapshot: () => plant.snapshot(), step(actuators, dtS, world) {
        atMs += dtS * 1000
        const state = plant.step(actuators, dtS, world)
        const windy = enteredAt !== null && atMs >= enteredAt + 4
        if (!world.windMps.every((value, i) => value === (windy ? vector[i] : 0))) mismatch++
        if (world.windMps.some(n => n !== 0)) firstApplied ??= atMs
        return state
      } }
    } }
  }
  const { result, report } = scenario.run()
  const blocked = name.includes('-limit-') && entry.phase !== 'landing'
  expect(enteredAt).not.toBeNull()
  expect(firstApplied).toBe(enteredAt! + 4)
  expect(mismatch).toBe(0)
  expect(report.windEvidence).toMatchObject({ phase: entry.phase, phaseEnteredAtMs: enteredAt, beginsAtMs: firstApplied, firstAppliedAtMs: firstApplied, phaseMatched: true, worldMatched: true, outcomeMatched: true, expectedOutcome: blocked ? 'envelope-stop' : 'completed-route', backHeadingMatched: true })
  expect(report.demonstrationMatched).toBe(true)
  expect(report.status).toBe(blocked ? 'blocked' : 'completed')
  expect(report.fault).toBe(blocked ? 'vtol-transition-envelope' : null)
  expect(report.landingContact).toBe(!blocked)
  expect(report.completeTransitions).toBe(!blocked)
  expect(report.budget).toEqual({ worstCaseMs: 131520, requiredWh: 43.84 })
  expect(report.boardNeutral).toBe(true)
  expect(report.board.physicalActuationEnabled).toBe(false)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
})

for (const mutation of ['absent', 'early', 'late', 'opposite'] as const) test(`${mutation} weather cannot qualify the selected observed back-phase wind`, () => {
  const scenario = createVtolSimulationCase('headwind-2mps', { phase: 'back' }), faults = scenario.profile.faults
  scenario.profile.faults = (name, atMs) => {
    const declared = faults(name, atMs - (mutation === 'late' ? 4 : 0))
    return { windMps: mutation === 'absent' ? [0, 0, 0] : mutation === 'early' ? atMs >= 1000 ? [-2, 0, 0] : [0, 0, 0] : mutation === 'opposite' ? [-(declared.windMps?.[0] ?? 0), 0, 0] : declared.windMps }
  }
  const { report } = scenario.run()
  expect(report.windEvidence!.worldMatched).toBe(false)
  expect(report.windEvidence!.mismatchSteps).toBeGreaterThan(0)
  expect(report.demonstrationMatched).toBe(false)
  expect(report.boardNeutral).toBe(true)
})

test('an unreached wind phase stays unexposed and cannot qualify a partial run', () => {
  const { report } = createVtolSimulationCase('tailwind-2mps', { phase: 'landing', seconds: 2 }).run()
  expect(report.status).toBe('duration-exhausted')
  expect(report.windEvidence).toMatchObject({ beginsAtMs: null, phaseEnteredAtMs: null, firstAppliedAtMs: null, appliedSteps: 0, phaseMatched: false, worldMatched: false, outcomeMatched: false })
  expect(report.demonstrationMatched).toBe(false)
  expect(report.boardNeutral).toBe(true)
})

test('wind phase runs reset exposure and own copies of their declarations', () => {
  const scenario = createVtolSimulationCase('west-crosswind-limit-2mps', { phase: 'landing' })
  const first = scenario.run().report, original = structuredClone(first)
  first.windEvidence!.phaseEnteredAtMs = 0
  scenario.wind!.windMps[1] = 999
  scenario.phases.length = 0
  expect(scenario.run().report).toEqual(original)
})

test('a different completed heading plan cannot qualify the fixed north landing-onset name', () => {
  const scenario = createVtolSimulationCase('east-crosswind-limit-2mps', { phase: 'landing' })
  const back = scenario.profile.mission.tasks.find(task => task.id === 'back')!
  if (back.kind !== 'vtol-mode') throw new Error('Expected back heading task')
  back.headingRad = -Math.PI / 2
  const { report } = scenario.run()
  expect(report.status).toBe('completed')
  expect(report.windEvidence).toMatchObject({ worldMatched: true, phaseMatched: true, outcomeMatched: true, backHeadingMatched: false })
  expect(report.demonstrationMatched).toBe(false)
})

test('startup is an explicit wind-only default and unrelated phase selectors remain rejected', () => {
  const selected = createVtolSimulationCase('headwind-2mps', { phase: 'startup' })
  expect(selected.phase).toBeNull()
  expect(selected.wind).toMatchObject({ beginsAtMs: 1000, expectedOutcome: 'completed-route' })
  expect(selected.phases).toEqual(['startup', 'front', 'cruise', 'back', 'landing'])
  expect(() => createVtolSimulationCase('host-loss', { phase: 'startup' })).toThrow('Unknown VTOL simulation phase')
  expect(() => createVtolSimulationCase('nominal', { phase: 'back' })).toThrow('requires a fault or wind scenario')
})
