import { expect, test } from 'bun:test'
import type { SensorVector } from '../../resources/functions/drone/sensors/types'
import { createVtolBackCaptureProfile } from '../../resources/functions/drone/vehicles/vtol/back-capture-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Public runtime seam, including actual world integration and raw-sensor estimation.
// The finite sampled cases do not prove an interval envelope or physical airframe capability.
// These conservative planner limits are distinct from the original published
// wind-facing transition cases, whose original completed-route contracts remain.
const cases: { name: string, wind: SensorVector, anchor: SensorVector, heading: number, outcome: 'completed' | 'limit' }[] = [
  { name: 'calm 330 m north-facing anchor', wind: [0, 0, 0], anchor: [330, 0, -15], heading: 0, outcome: 'completed' },
  { name: '2 m/s headwind', wind: [-2, 0, 0], anchor: [330, 0, -15], heading: 0, outcome: 'completed' },
  { name: '2 m/s tailwind', wind: [2, 0, 0], anchor: [330, 0, -15], heading: 0, outcome: 'completed' },
  { name: 'east crosswind with declared wind-facing hover', wind: [0, 2, 0], anchor: [330, 0, -15], heading: -Math.PI / 2, outcome: 'limit' },
  { name: 'west crosswind with declared wind-facing hover', wind: [0, -2, 0], anchor: [330, 0, -15], heading: Math.PI / 2, outcome: 'limit' },
  { name: 'east crosswind with fixed north hover', wind: [0, 2, 0], anchor: [330, 0, -15], heading: 0, outcome: 'limit' },
  { name: 'west crosswind with fixed north hover', wind: [0, -2, 0], anchor: [330, 0, -15], heading: 0, outcome: 'limit' },
  { name: 'calm 300 m east-facing anchor', wind: [0, 0, 0], anchor: [300, 0, -15], heading: Math.PI / 2, outcome: 'limit' },
  { name: 'calm 350 m south-facing anchor', wind: [0, 0, 0], anchor: [350, 0, -15], heading: Math.PI, outcome: 'limit' },
  { name: 'calm 390 m north-facing anchor', wind: [0, 0, 0], anchor: [390, 0, -15], heading: 0, outcome: 'limit' },
]

for (const declaration of cases) test(`bounded capture retains its distinct ${declaration.name} outcome`, () => {
  const profile = createVtolBackCaptureProfile(), factory = profile.createSession
  Object.assign(profile.mission.tasks.find(task => task.id === 'back')!, { anchorM: [...declaration.anchor], headingRad: declaration.heading })
  Object.assign(profile.mission.tasks.find(task => task.id === 'land')!, { positionM: [declaration.anchor[0], declaration.anchor[1], 0] })
  profile.faults = (_name, atMs) => ({ windMps: atMs >= 1000 ? [...declaration.wind] : [0, 0, 0] })
  let mismatchSteps = 0, integrationSteps = 0
  const exposure: { observedOnset: number | null } = { observedOnset: null }
  profile.createSession = () => {
    const session = factory(), plant = session.createPlant()
    let atMs = 600
    return { ...session, createPlant: () => ({ snapshot: () => plant.snapshot(), step(actuators, dtS, world) {
      atMs += dtS * 1000
      const state = plant.step(actuators, dtS, world)
      integrationSteps++
      if (!world.windMps.every((n, i) => n === (atMs >= 1000 ? declaration.wind[i] : 0))) mismatchSteps++
      if (atMs >= 1000) exposure.observedOnset ??= atMs
      return state
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  const forecasts = report.path.flatMap(row => row.backCapture ? [row.backCapture] : [])
  const command = report.trace.rows.find(row => row.result.transition?.taskId === 'back')!.result.transition!
  const confirmations = report.trace.rows.flatMap(row => row.observation.transition?.outcome === 'confirmed' ? [row.observation.transition] : [])
  console.log(JSON.stringify({ oracle: 'bounded-capture-wind-v2', declaration, status: report.status, fault: report.fault, forecasts: forecasts.map(f => ({ status: f.status, reason: f.reason, radius: f.windSampleRadiusMps, rejected: f.predictions.filter(t => t.status !== 'confirmed').map(t => ({ wind: t.windMps, wait: t.waitMs, reason: t.reason, rotaryPosition: t.rotaryPositionM })) })) }))
  expect(integrationSteps).toBeGreaterThan(1000)
  expect(mismatchSteps).toBe(0)
  expect(exposure.observedOnset).toBe(1000)
  expect(command.positionM).toEqual(declaration.anchor)
  expect(command.headingRad).toBe(declaration.heading)
  expect(command.expiresAtMs - command.issuedAtMs).toBeLessThanOrEqual(45000)
  expect(command.planning!.remainingMissionMs).toBe(25000)
  expect(forecasts).toHaveLength(1)
  expect(forecasts[0]!.status).toBe(declaration.outcome === 'completed' ? 'predicted' : 'limit')
  expect(forecasts[0]!.predictions.length).toBeLessThanOrEqual(28)
  expect(report.status).toBe(declaration.outcome === 'completed' ? 'completed' : 'blocked')
  expect(report.fault).toBe(declaration.outcome === 'completed' ? null : 'vtol-transition-aborted')
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(declaration.outcome === 'completed')
  if (declaration.outcome === 'completed') {
    expect(confirmations.map(row => row.taskId)).toEqual(['initial-hover', 'front', 'back'])
    expect(confirmations.at(-1)!.capturedAtMs).toBeLessThan(command.expiresAtMs)
    expect(confirmations.at(-1)!.measurementCapturedAtMs).toBeGreaterThanOrEqual(command.issuedAtMs)
    const selected = forecasts[0]!.predictions.filter(row => row.waitMs === forecasts[0]!.waitMs)
    expect(selected).toHaveLength(7)
    expect(selected.every(row => row.status === 'confirmed' && row.confirmedAtMs! <= command.expiresAtMs - 1500)).toBe(true)
  }
  else {
    expect(confirmations.map(row => row.taskId)).toEqual(['initial-hover', 'front'])
    expect(forecasts[0]!.reason).toBe('forecast-anchor-deadline-reserve-or-uncertainty')
  }
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.physicalFlightEnabled).toBe(false)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
}, 60000)

test('an actual world wind change after admission invalidates capture without restarting its request', () => {
  const profile = createVtolBackCaptureProfile(), factory = profile.createSession
  const epochs: { admittedAt: number | null, firstWindAt: number | null } = { admittedAt: null, firstWindAt: null }
  profile.faults = (_name, atMs) => ({ windMps: epochs.admittedAt !== null && atMs >= epochs.admittedAt + 4 ? [2, 0, 0] : [0, 0, 0] })
  profile.createSession = () => {
    const session = factory(), controller = session.createController(), plant = session.createPlant()
    let atMs = 600
    return { ...session, createController: () => ({ step(context) {
      const output = controller.step(context)
      if (output.backCapture?.status === 'predicted') epochs.admittedAt ??= context.nowMs
      return output
    } }), createPlant: () => ({ snapshot: () => plant.snapshot(), step(actuators, dtS, world) {
      atMs += dtS * 1000
      if (world.windMps[0] === 2) epochs.firstWindAt ??= atMs
      return plant.step(actuators, dtS, world)
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  const forecasts = report.path.flatMap(row => row.backCapture ? [row.backCapture] : [])
  expect(epochs.admittedAt).not.toBeNull()
  expect(epochs.firstWindAt).toBe(epochs.admittedAt! + 4)
  expect(forecasts.map(row => row.status)).toEqual(['predicted', 'uncertain'])
  expect(forecasts[1]!.reason).toBe('forecast-wind-changed')
  expect(forecasts[1]!.monitor!.sourceCapturedAtMs).toBeGreaterThanOrEqual(epochs.firstWindAt!)
  expect(report.status).toBe('blocked')
  expect(report.fault).toBe('vtol-transition-aborted')
  expect(new Set(report.trace.rows.flatMap(row => row.result.transition?.taskId === 'back' ? [row.result.transition.eventId] : [])).size).toBe(1)
  expect(report.trace.rows.some(row => row.observation.transition?.taskId === 'back' && row.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
}, 60000)
