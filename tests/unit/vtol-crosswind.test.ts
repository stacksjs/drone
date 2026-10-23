import { expect, test } from 'bun:test'
import { createVtolSimulationCase } from '../../resources/functions/drone/vehicles/vtol/simulation'
import { vtolAerodynamics, vtolModel } from '../../resources/functions/drone/vehicles/vtol/plant'
import { quaternionEuler } from '../../resources/functions/drone/estimation/frames'
import { allocateVtolLift } from '../../resources/functions/drone/vehicles/vtol/allocation'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Existing actual-runtime seam: explicit mission heading, sustained world wind, raw
// sensors, estimator, controller and independent board. No physical qualification.
test('an explicitly west-facing back hover completes the east crosswind route within the original budget', () => {
  const selected = createVtolSimulationCase('east-crosswind-2mps', { electrical: true })
  const back = selected.profile.mission.tasks.find(task => task.id === 'back')
  expect(back?.kind === 'vtol-mode' && back.headingRad).toBe(-Math.PI / 2)
  const { result, report } = selected.run()
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.windEvidence).toMatchObject({ windMps: [0, 2, 0], backHeadingRad: -Math.PI / 2, expectedOutcome: 'completed-route', worldMatched: true, outcomeMatched: true, backHeadingMatched: true })
  expect(report.budget).toEqual({ worstCaseMs: 131520, requiredWh: 43.84 })
  expect(report.transitionEvidence.map(row => [row.taskId, row.phase])).toEqual([['initial-hover', 'hover'], ['front', 'cruise'], ['back', 'hover']])
  const backCapture = result.path.find(row => row.atMs === report.transitionEvidence.at(-1)!.capturedAtMs)!.measurementPose!
  const yaw = quaternionEuler(backCapture.quaternionWxyz)[2]
  expect(Math.abs(Math.atan2(Math.sin(-Math.PI / 2 - yaw), Math.cos(-Math.PI / 2 - yaw)))).toBeLessThan(0.1)
  expect(backCapture.capturedAtMs).toBeLessThanOrEqual(report.transitionEvidence.at(-1)!.capturedAtMs)
  expect(result.mission.reason).toBe('landed')
  expect(report.landingContact).toBe(true)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.board.physicalActuationEnabled).toBe(false)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
})

test('an explicitly east-facing back hover completes the west crosswind route without changing its deadline', () => {
  const selected = createVtolSimulationCase('west-crosswind-2mps', { electrical: true })
  const back = selected.profile.mission.tasks.find(task => task.id === 'back')
  expect(back?.kind === 'vtol-mode' && back.headingRad).toBe(Math.PI / 2)
  const { result, report } = selected.run()
  expect(report.status).toBe('completed')
  expect(report.windEvidence).toMatchObject({ windMps: [0, -2, 0], backHeadingRad: Math.PI / 2, worldMatched: true, outcomeMatched: true, backHeadingMatched: true })
  expect(report.demonstrationMatched).toBe(true)
  expect(report.budget).toEqual({ worstCaseMs: 131520, requiredWh: 43.84 })
  expect(report.transitionEvidence.map(row => row.taskId)).toEqual(['initial-hover', 'front', 'back'])
  expect(report.landingContact).toBe(true)
  expect(report.boardNeutral).toBe(true)
  expect(report.board.physicalActuationEnabled).toBe(false)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
})

test('a completed route under a different back heading cannot qualify the named declared plan', () => {
  const selected = createVtolSimulationCase('east-crosswind-2mps', { electrical: true })
  const back = selected.profile.mission.tasks.find(task => task.id === 'back')
  if (!back || back.kind !== 'vtol-mode') throw new Error('Missing back task')
  back.headingRad = -1.5
  const { report } = selected.run()
  expect(report.status).toBe('completed')
  expect(report.windEvidence!.worldMatched).toBe(true)
  expect(report.windEvidence!.backHeadingMatched).toBe(false)
  expect(report.demonstrationMatched).toBe(false)
})

test('the retained north-facing level-hover example lacks yaw authority even at full rudder and rotor allocation', () => {
  const aero = vtolAerodynamics([0, -2, 0], [0, 0, 0], [0, 0, 0, 0.4, 0])
  const allocation = allocateVtolLift({ thrustN: vtolModel.massKg * vtolModel.gravityMps2, torqueNm: [0, 0, -aero.torqueNm[2]] })
  // Worked fictional-model example: -0.73615511 Nm with full opposing rudder,
  // +0.4696675 Nm available rotor yaw while preserving 24.516625 N support.
  expect(allocation.limited).toBe(true)
  expect(allocation.achieved.thrustN).toBeCloseTo(24.516625, 7)
  expect(aero.torqueNm[2] + allocation.achieved.torqueNm[2]).toBeCloseTo(-0.2664876105491832, 7)
  expect(allocation.rotorsN.every(value => value >= 0 && value <= 12)).toBe(true)
})
