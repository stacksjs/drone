import { describe, expect, test } from 'bun:test'
import { airAerodynamics, airModel, createAirPlant } from '../../resources/functions/drone/vehicles/air/plant'

describe('owned fixed-wing aerodynamics', () => {
  test('lift is perpendicular to relative wind and scales with dynamic pressure', () => {
    const slow = airAerodynamics([10, 0, 0], [0, 0, 0], [0, 0, 0, 0, 0])
    const fast = airAerodynamics([20, 0, 0], [0, 0, 0], [0, 0, 0, 0, 0])
    expect(slow.forceN[2]).toBeCloseTo(-12.25, 5)
    expect(fast.forceN[2]).toBeCloseTo(-49, 5)
    expect(slow.forceN[0]).toBeLessThan(0)
    expect(airModel.massKg).toBe(2)
  })
})

test('wheel brake dissipates kinetic energy without teleporting the airframe', () => {
  const plant = createAirPlant({ velocityMps: [5, 0, 0] })
  let state = plant.snapshot()
  for (let i = 0; i < 250; i++) state = plant.step([0, 0, 0, 0, 1], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(state.positionM[0]).toBeGreaterThan(1)
  expect(Math.abs(state.velocityMps[0])).toBeLessThan(0.02)
  expect(state.onSurface).toBe(true)
})

test('angle of attack above the declared stall angle loses lift and retains drag', () => {
  const polar = (alpha: number) => airAerodynamics([15 * Math.cos(alpha), 0, 15 * Math.sin(alpha)], [0, 0, 0], [0, 0, 0, 0, 0])
  expect(polar(0.7).liftCoefficient).toBeLessThan(polar(0.28).liftCoefficient)
  expect(polar(0.7).dragCoefficient).toBeGreaterThan(polar(0.28).dragCoefficient)
  expect(polar(0.7).stalled).toBe(true)
  expect(airAerodynamics([0, 0, 0], [0, 0, 0], [0, 0.4, 0.4, 0.4, 0]).torqueNm).toEqual([0, 0, 0])
})

test('plant wind changes relative airspeed, lift and drift without changing commanded position', () => {
  const still = createAirPlant({ positionM: [0, 0, -20], velocityMps: [13, 0, 0] })
  const headwind = createAirPlant({ positionM: [0, 0, -20], velocityMps: [13, 0, 0] })
  const a = still.step([0.25, 0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  const b = headwind.step([0.25, 0, 0, 0, 0], 0.004, { windMps: [-3, 0, 0], currentMps: [0, 0, 0] })
  expect(a.details.airspeedMps).toBe(13)
  expect(b.details.airspeedMps).toBe(16)
  expect(b.accelerationMps2[2]).toBeLessThan(a.accelerationMps2[2])
  const snapshot = still.snapshot(); snapshot.positionM[0] = 999
  expect(still.snapshot().positionM[0]).not.toBe(999)
})

import { createAirController, createAirProfile } from '../../resources/functions/drone/vehicles/air'
import { airContext } from '../fixtures/air/context'

test('energy controller increases propulsion for a qualified airspeed deficit and rejects stale input', () => {
  const cruise = airContext(), slow = structuredClone(cruise)
  slow.measurement!.values.airspeedMps = 9; slow.measurement!.values.differentialPressurePa = 49.6125
  const normal = createAirController().step(cruise), recovery = createAirController().step(slow)
  expect(normal.inhibited).toBe(false)
  expect(recovery.actuators[0]!).toBeGreaterThan(normal.actuators[0]!)
  const controller = createAirController()
  cruise.measurement!.capturedAtMs = 800; cruise.measurement!.receivedAtMs = 860
  expect(controller.step(cruise).reason).toBe('air-sensor-unqualified')
  expect(controller.step(airContext()).inhibited).toBe(true)
})

test('qualified surface/rate packet replay and estimator reference changes latch inhibition', () => {
  const controller = createAirController(), context = airContext()
  expect(controller.step(context).inhibited).toBe(false)
  context.nowMs += 20; context.estimate.nowMs += 20; context.estimate.localPosition!.predictedToMs += 20
  expect(controller.step(context).inhibited).toBe(false)
  context.measurement!.values.airspeedMps = 14
  expect(controller.step(context).reason).toBe('air-sensor-unqualified')
  const reset = airContext(); reset.estimate.resets.manual++
  expect(createAirController().step(reset).inhibited).toBe(true)
})

test('airborne stall and excessive bank inhibit, while pause requests a flyable orbit', () => {
  const stalled = airContext(); stalled.measurement!.values.alphaRad = 0.4
  expect(createAirController().step(stalled).reason).toBe('air-flight-envelope')
  const banked = airContext(); banked.estimate.attitude!.eulerRad[0] = 1
  expect(createAirController().step(banked).inhibited).toBe(true)
  const paused = airContext(); paused.mission.state = 'paused'; paused.mission.targetM = null
  const output = createAirController().step(paused)
  expect(output.inhibited).toBe(false)
  expect(output.reason).toBe('bounded-air-loiter')
})

test('profile quantizes independent modeled measurements and returns fresh owned copies', () => {
  const profile = createAirProfile(), state = profile.createPlant().snapshot()
  state.details.airspeedMps = 12.34567
  const packet = profile.renderMeasurement(state, 200, 'ref')
  expect(packet.values.airspeedMps).toBe(12.35)
  expect(packet.receivedAtMs).toBe(260)
  expect(packet.values.onSurface).toBe(true)
  expect(packet.values.stopped).toBe(true)
  profile.mission.tasks[1]!.id = 'mutated'
  expect(createAirProfile().mission.tasks[1]!.id).toBe('depart')
})

test('malformed estimator attitude cannot produce nonfinite actuator commands', () => {
  const context = airContext(); context.estimate.attitude!.eulerRad[1] = Number.NaN
  const result = createAirController().step(context)
  expect(result.inhibited).toBe(true)
  expect(result.actuators.every(Number.isFinite)).toBe(true)
})

test('reverse relative airflow is outside the declared normal-flight alpha envelope', () => {
  expect(Math.abs(airAerodynamics([-10, 0, 0], [0, 0, 0], [0, 0, 0, 0, 0]).alphaRad)).toBeCloseTo(Math.PI, 8)
})

test('pausing before takeoff holds the runway with brakes instead of launching', () => {
  const context = airContext(); context.mission.state = 'paused'; context.measurement!.values.onSurface = true; context.measurement!.values.stopped = true
  context.measurement!.values.airspeedMps = 0; context.measurement!.values.differentialPressurePa = 0
  const output = createAirController().step(context)
  expect(output.actuators).toEqual([0, 0, 0, 0, 1])
  expect(output.reason).toBe('runway-paused')
})

test('landing follows its captured runway heading through goal overshoot instead of commanding a turnback', () => {
  const controller = createAirController(), context = airContext()
  context.mission.taskId = 'land'; context.mission.taskKind = 'land'; context.mission.targetM = [650, 0, 0]
  context.estimate.localPosition!.positionM = [600, 0, -3]
  expect(controller.step(context).inhibited).toBe(false)
  context.nowMs += 20; context.estimate.nowMs += 20; context.estimate.localPosition!.predictedToMs += 20
  context.estimate.localPosition!.positionM = [655, 0, -1]
  expect(Math.abs(controller.step(context).actuators[1]!)).toBeLessThan(0.01)
})

// Common runtime seam: catches raw IMU/GNSS integration and complete vehicle mission behavior, not physical airworthiness.
test('owned aerodynamic trainer takes off, navigates and lands through raw sensors in still air and crosswind', async () => {
  const { runVehicleSimulation } = await import('../../resources/functions/drone/vehicles/runtime')
  for (const scenario of ['nominal', 'crosswind']) {
    const report = runVehicleSimulation(createAirProfile(scenario), { scenario, seconds: 120 })
    expect(report.status).toBe('completed')
    expect(report.mission.state).toBe('completed')
    expect(report.path.some(row => row.truthPositionM[2] < -10)).toBe(true)
    expect(report.path.some(row => row.truthPositionM[0] > 330)).toBe(true)
    expect(report.mission.physicalFlightEnabled).toBe(false)
    expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
    expect(report.path.at(-1)!.measurement!.values.stopped).toBe(true)
    expect(report.finalTruthPositionM[2]).toBe(0)
    expect(Math.abs(report.finalTruthPositionM[0] - 650)).toBeLessThan(10)
  }
}, 60000)

test('air sensor, position, manual and kill losses release propulsion while independent board expires a lost host', async () => {
  const { runVehicleSimulation } = await import('../../resources/functions/drone/vehicles/runtime')
  for (const scenario of ['airspeed-loss', 'position-loss', 'host-loss', 'rc-override', 'kill']) {
    const report = runVehicleSimulation(createAirProfile(scenario), { scenario, seconds: 30 })
    expect(report.status).toBe(scenario === 'host-loss' ? 'host-lost' : 'blocked')
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 1])
    expect(report.board.expiresAtMs).toBeNull()
    expect(report.path.some(row => row.truthPositionM[2] < -10)).toBe(true)
    if (scenario === 'host-loss') expect(report.board.fault).toBe('output-lease-expired')
    else expect(report.mission.state).toBe('blocked')
  }
}, 60000)

import { join } from 'node:path'

// Native CLI seam: catches command parsing and report visibility, not packaging or flight qualification.
test('native air command executes the owned runway mission and rejects invalid inputs', async () => {
  const command = (args: string[]) => Bun.spawn([process.execPath, '--no-env-file', `--config=${join(import.meta.dir, '../fixtures/process/bunfig.toml')}`, join(import.meta.dir, '../fixtures/air/cli.ts'), 'air:simulate', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const child = command(['--seconds', '120'])
  const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(status).toBe(0); expect(errors).toBe('')
  const report = JSON.parse(output)
  expect(report.status).toBe('completed'); expect(report.physicalFlightEnabled).toBe(false)
  for (const args of [['--seconds', 'NaN'], ['--seconds', '181'], ['--seconds', '1.5'], ['--scenario', 'unmodeled-vtol']]) {
    const invalid = command(args)
    const [text, error, code] = await Promise.all([new Response(invalid.stdout).text(), new Response(invalid.stderr).text(), invalid.exited])
    expect(text).toBe(''); expect(code).toBe(1); expect(error.length).toBeGreaterThan(0)
  }
}, 180000)
