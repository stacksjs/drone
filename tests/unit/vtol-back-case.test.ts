import { expect, test } from 'bun:test'
import { createVtolSimulationCase } from '../../resources/functions/drone/vehicles/vtol/simulation'
import { getMissionWorkspaceDefinition, runMissionWorkspace } from '../../resources/functions/drone/vehicles/workspace'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import { createVtolBackCaptureProfile } from '../../resources/functions/drone/vehicles/vtol/back-capture-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'

// Shared case and workspace seams check real modeled execution and retained evidence.
// They do not establish aircraft uncertainty, HIL or physical flight acceptance.
test('the named bounded capture case retains its approach forecasts and actual finite route', () => {
  const selected = createVtolSimulationCase('planned-back-capture')
  const { result, report } = selected.run()
  expect(selected.electrical).toBe(true)
  expect(result.navigationEvidence.positionPrediction).toMatchObject({ mode: 'fixture-imu', version: 'fixture-imu-v1', initialNorthHeadingAssumed: true, physicalFlightEnabled: false })
  expect(report.backCaptureCase!.positionPrediction).toEqual(result.navigationEvidence.positionPrediction)
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(true)
  expect(report.landingContact).toBe(true)
  expect(result.trace.plan.tasks.find(task => task.id === 'back')).toMatchObject({ anchorM: [330, 0, -15], approach: 'bounded-approach-v1', timeoutMs: 45000 })
  expect(result.trace.rows.some(row => row.result.taskId === 'cruise-leg')).toBe(true)
  const forecasts = result.path.flatMap(row => row.backCapture ? [row.backCapture] : [])
  expect(report.backCaptureEvidence).toEqual(forecasts)
  expect(forecasts).toHaveLength(1)
  expect(forecasts[0]).toMatchObject({ status: 'predicted', anchorM: [330, 0, -15], physicalFlightEnabled: false })
  const command = result.trace.rows.find(row => row.result.transition?.taskId === 'back')!.result.transition!
  const confirmed = result.trace.rows.find(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')!.observation.transition!
  expect(confirmed.capturedAtMs).toBeLessThan(command.expiresAtMs)
  expect(confirmed.measurementCapturedAtMs).toBeGreaterThanOrEqual(command.issuedAtMs)
  expect(report.boardNeutral).toBe(true)
  expect(report.board.physicalActuationEnabled).toBe(false)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
}, 60000)

test('a different completed declaration cannot qualify the named capture example', () => {
  const selected = createVtolSimulationCase('planned-back-capture')
  const back = selected.profile.mission.tasks.find(task => task.id === 'back')!
  if (back.kind !== 'vtol-mode') throw new TypeError('Expected back task')
  back.headingRad = 0.01
  const { report } = selected.run()
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(false)
  expect(report.boardNeutral).toBe(true)
}, 60000)

test('undeclared actual wind cannot qualify the calm named capture example', () => {
  const selected = createVtolSimulationCase('planned-back-capture')
  selected.profile.faults = (_name, atMs) => ({ windMps: atMs >= 1000 ? [2, 0, 0] : [0, 0, 0] })
  const { report } = selected.run()
  expect(report.status).toBe('completed')
  expect(report.demonstrationMatched).toBe(false)
  expect(report.boardNeutral).toBe(true)
}, 60000)

test('the common workspace preserves the explicit anchor and actual forecast at its recorded epoch', () => {
  const definition = getMissionWorkspaceDefinition('vtol', 'planned-back-capture')
  expect(definition.tasks.find(task => task.id === 'back')!.targetM).toEqual([330, 0, -15])
  const run = runMissionWorkspace('vtol', 'planned-back-capture')
  expect(run.status).toBe('completed')
  const forecasts = run.rows.flatMap(row => row.vtol?.backCapture ? [{ atMs: row.atMs, forecast: row.vtol.backCapture }] : [])
  expect(forecasts).toHaveLength(1)
  expect(forecasts[0]!.atMs).toBe(forecasts[0]!.forecast.observedAtMs)
  expect(forecasts[0]!.forecast.sourceCapturedAtMs).toBeLessThanOrEqual(forecasts[0]!.atMs)
  expect(run.rows.some(row => row.atMs < forecasts[0]!.atMs && row.vtol?.backCapture)).toBe(false)
  expect(run.boardNeutral).toBe(true)
  expect(run.physicalActuationEnabled).toBe(false)
}, 60000)

test('capture resources include the longer declared failure route after the capture deadline', () => {
  const profile = createVtolBackCaptureProfile()
  const back = profile.mission.tasks.find(task => task.id === 'back')!
  if (back.kind !== 'vtol-mode') throw new TypeError('Expected back task')
  back.onFailure = 'recover-hover'
  profile.mission.tasks.push(
    { id: 'recover-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 20000, next: 'recover-land' },
    { id: 'recover-land', kind: 'land', positionM: [330, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 30000 },
  )
  const report = runVehicleSimulation(profile, { seconds: 160 })
  expect(report.status).toBe('completed')
  const command = report.trace.rows.find(row => row.result.transition?.taskId === 'back')!.result.transition!
  expect(command.planning!.remainingMissionMs).toBe(50000)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
}, 60000)

// Observe the actual plant before contact, not the post-contact velocity clamp.
test('a planned capture flares to its declared landing speed within the original task budget', () => {
  const profile = createVtolBackCaptureProfile(), factory = profile.createSession
  const contact: { atMs: number, incomingDownMps: number }[] = []
  profile.createSession = () => {
    const session = factory(), plant = session.createPlant(), controller = session.createController()
    let previous = plant.snapshot(), atMs = 600, landingEntered = false
    return { ...session, createController: () => ({ step(context) {
      landingEntered ||= context.mission.taskId === 'land' && context.mission.state === 'running'
      return controller.step(context)
    } }), createPlant: () => ({ snapshot: () => plant.snapshot(), step(actuators, dtS, world) {
      atMs += dtS * 1000
      const next = plant.step(actuators, dtS, world)
      if (landingEntered && !previous.onSurface && next.onSurface) contact.push({ atMs, incomingDownMps: previous.velocityMps[2] })
      previous = next
      return next
    } }) }
  }
  const result = runVehicleSimulation(profile, { seconds: 160 })
  console.log(JSON.stringify({ oracle: 'planned-landing-incoming-contact-speeds', contact, status: result.status }))
  expect(contact.length).toBeGreaterThan(0)
  expect(Math.max(...contact.map(row => row.incomingDownMps))).toBeLessThanOrEqual(0.2)
  expect(result.status).toBe('completed')
  expect(result.trace.plan.tasks.find(task => task.id === 'land')).toMatchObject({ kind: 'land', timeoutMs: 25000 })
  expect(result.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
}, 60000)

test('the shared planned tailwind case binds wind, estimator and completed capture evidence', () => {
  const selected = createVtolSimulationCase('planned-tailwind-2mps')
  const { result, report } = selected.run()
  expect(report.demonstrationMatched).toBe(true)
  expect(report.status).toBe('completed')
  expect(report.backCaptureCase).toMatchObject({ declarationMatched: true, worldMatched: true, matched: true })
  expect(report.windEvidence).toMatchObject({ windMps: [2, 0, 0], beginsAtMs: 1000, worldMatched: true, outcomeMatched: true })
  expect(result.navigationEvidence.positionPrediction?.mode).toBe('fixture-imu')
  expect(report.backCaptureEvidence!.map(row => row.status)).toEqual(['predicted'])
  expect(report.transitionEvidence.map(row => row.taskId)).toEqual(['initial-hover', 'front', 'back'])
  expect(report.landingContact).toBe(true)
  expect(report.boardNeutral).toBe(true)
  expect(replayVehicleMission(result.trace).snapshot()).toEqual(result.mission)
}, 60000)
