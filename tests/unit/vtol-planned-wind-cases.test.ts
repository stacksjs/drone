import { expect, test } from 'bun:test'
import { createVtolSimulationCase } from '../../resources/functions/drone/vehicles/vtol/simulation'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Public case + actual integration seam: verify phase-bound weather and finite
// planner outcomes independently. Sampled fictional cases do not qualify hardware.
const winds = ['headwind-2mps', 'tailwind-2mps', 'east-crosswind-limit-2mps', 'west-crosswind-limit-2mps', 'east-crosswind-2mps', 'west-crosswind-2mps'] as const
const phases = ['startup', 'front', 'cruise', 'back', 'landing'] as const
for (const name of winds) for (const phase of phases) test(`planned ${name} retains its actual ${phase} onset and capture outcome`, () => {
  const selected = createVtolSimulationCase(`planned-${name}`, { phase }), factory = selected.profile.createSession
  const crosswind = name.startsWith('east-') || name.startsWith('west-')
  const windFacing = crosswind && !name.includes('-limit-')
  const unreached = windFacing && phase === 'landing'
  const blocked = crosswind && (phase !== 'landing' || windFacing)
  const expectedOutcome = unreached ? 'planning-limit-before-onset' : blocked ? 'planning-limit' : 'completed-route'
  const taskId = phase === 'cruise' ? 'cruise-leg' : phase === 'landing' ? 'land' : phase
  const actual: { enteredAt: number | null, firstWindAt: number | null, mismatch: number } = { enteredAt: null, firstWindAt: null, mismatch: 0 }
  selected.profile.createSession = () => {
    const session = factory()
    return { ...session, createController() {
      const controller = session.createController()
      return { step(context) {
        if (actual.enteredAt === null && context.enabled && context.mission.state === 'running' && context.mission.taskId === taskId) actual.enteredAt = context.nowMs
        return controller.step(context)
      } }
    }, createPlant() {
      const plant = session.createPlant()
      let atMs = 600
      return { snapshot: () => plant.snapshot(), step(actuators, dtS, world) {
        atMs += dtS * 1000
        const onset = phase === 'startup' ? 1000 : actual.enteredAt === null ? null : actual.enteredAt + 4
        const windy = onset !== null && atMs >= onset
        if (!world.windMps.every((n, i) => n === (windy ? selected.wind!.windMps[i] : 0))) actual.mismatch++
        if (world.windMps.some(n => n !== 0)) actual.firstWindAt ??= atMs
        return plant.step(actuators, dtS, world)
      } }
    } }
  }
  const { result, report } = selected.run(), forecast = report.backCaptureEvidence!
  const expectedOnset = phase === 'startup' ? 1000 : unreached ? null : actual.enteredAt! + 4
  expect(actual.mismatch).toBe(0)
  expect(actual.firstWindAt).toBe(expectedOnset)
  if (phase !== 'startup') expect(actual.enteredAt === null).toBe(unreached)
  expect(report.windEvidence).toMatchObject({ beginsAtMs: expectedOnset, firstAppliedAtMs: expectedOnset, worldMatched: !unreached, outcomeMatched: true, expectedOutcome })
  expect(report.demonstrationMatched).toBe(!unreached)
  expect(report.backCaptureCase).toMatchObject({ declarationMatched: true, worldMatched: !unreached, matched: !unreached })
  expect(report.status).toBe(blocked ? 'blocked' : 'completed')
  expect(report.fault).toBe(blocked ? 'vtol-transition-aborted' : null)
  expect(forecast).toHaveLength(1)
  expect(forecast[0]!.status).toBe(blocked ? 'limit' : 'predicted')
  if (phase !== 'landing') expect(forecast[0]!.sourceCapturedAtMs).toBeGreaterThanOrEqual(expectedOnset!)
  if (unreached) expect(report.windEvidence!.appliedSteps).toBe(0)
  expect(report.completeTransitions).toBe(!blocked)
  expect(report.landingContact).toBe(!blocked)
  expect(report.boardNeutral).toBe(true)
  expect(report.board.physicalActuationEnabled).toBe(false)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
}, 60000)
