import { expect, test } from 'bun:test'
import { createVtolHoverProfile } from '../../resources/functions/drone/vehicles/vtol'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import type { VehicleControllerContext } from '../../resources/functions/drone/vehicles/types'
import { createVtolVehicleHoverController } from '../../resources/functions/drone/vehicles/vtol/controller'

// Shared runtime seam includes raw sensors, estimator, mission, authority and independent leases; no transition or hardware qualification.
test('the owned VTOL hover mission takes off vertically and lands under shared mission authority', () => {
  const report = runVehicleSimulation(createVtolHoverProfile(), { seconds: 60 })
  expect(report.status).toBe('completed')
  expect(report.mission.reason).toBe('landed')
  expect(report.navigationEvidence.observedSensors.imu).toBeGreaterThan(100)
  expect(report.navigationEvidence.observedSensors.gnss).toBeGreaterThan(20)
  expect(report.path.some(row => row.truthPositionM[2] < -4)).toBe(true)
  expect(report.path.some(row => row.actuators.slice(0, 4).some(n => n > 0))).toBe(true)
  expect(report.path.every(row => row.actuators.slice(4).every(n => n === 0))).toBe(true)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(Math.hypot(report.finalTruthPositionM[0] - 2, report.finalTruthPositionM[1] - 1)).toBeLessThan(0.3)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.physicalFlightEnabled).toBe(false)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})

function observedControllerInputs() {
  const profile = createVtolHoverProfile(), createSession = profile.createSession, inputs: VehicleControllerContext[] = []
  profile.createSession = () => {
    const session = createSession(), createController = session.createController
    return { ...session, createController() {
      const controller = createController()
      return { step(context) { inputs.push(structuredClone(context)); return controller.step(context) } }
    } }
  }
  expect(runVehicleSimulation(profile, { seconds: 60 }).status).toBe('completed')
  return inputs
}

test('fresh landing contact cannot bypass a stale raw rate observation or clear its inhibition', () => {
  const inputs = observedControllerInputs()
  const contactIndex = inputs.findIndex(c => c.enabled && c.mission.taskKind === 'land' && c.measurement?.values.onSurface === true)
  expect(contactIndex).toBeGreaterThan(0)
  const controller = createVtolVehicleHoverController()
  expect(controller.step(inputs[contactIndex - 1]!).inhibited).toBe(false)
  const stale = structuredClone(inputs[contactIndex]!)
  stale.controlRate!.capturedAtMs -= 1000
  const rejected = controller.step(stale)
  expect(rejected.inhibited).toBe(true)
  expect(rejected.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(controller.step(inputs[contactIndex + 1]!).inhibited).toBe(true)
})

test('pausing a qualified VTOL on the ground keeps propulsion neutral until explicit mission resume', () => {
  const inputs = observedControllerInputs(), controller = createVtolVehicleHoverController()
  const paused = structuredClone(inputs[0]!)
  paused.mission.state = 'paused'
  paused.mission.targetM = [0, 0, 0]
  expect(paused.measurement!.values.onSurface).toBe(true)
  const held = controller.step(paused)
  expect(held.inhibited).toBe(false)
  expect(held.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  const resumed = controller.step(inputs[1]!)
  expect(resumed.inhibited).toBe(false)
  expect(resumed.actuators.slice(0, 4).some(n => n > 0)).toBe(true)
})

test('VTOL sensor loss, manual takeover and host death revoke distinct owned output leases', () => {
  // Neutral lease withdrawal does not establish a safe emergency landing.
  for (const scenario of ['imu-loss', 'position-loss', 'vehicle-sensor-loss', 'host-loss', 'rc-override', 'kill']) {
    const report = runVehicleSimulation(createVtolHoverProfile(scenario), { scenario, seconds: 30 })
    expect(report.status).toBe(scenario === 'host-loss' ? 'host-lost' : 'blocked')
    expect(report.path.some(row => row.truthPositionM[2] < -1)).toBe(true)
    expect(report.path.some(row => row.actuators.slice(0, 4).some(n => n > 0))).toBe(true)
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(report.board.expiresAtMs).toBeNull()
    if (scenario === 'host-loss') expect(report.board.fault).toBe('output-lease-expired')
    else expect(report.mission.state).toBe('blocked')
  }
})

test('separate VTOL sessions retain independent controller faults and returned actuator arrays', () => {
  const inputs = observedControllerInputs(), profile = createVtolHoverProfile()
  const first = profile.createSession().createController(), second = profile.createSession().createController()
  const firstOutput = first.step(inputs[0]!)
  expect(second.step(inputs[0]!)).toEqual(firstOutput)
  firstOutput.actuators[0] = 99
  const invalid = structuredClone(inputs[1]!)
  invalid.controlRate!.reference = 'another-reference'
  expect(first.step(invalid).inhibited).toBe(true)
  expect(first.step(inputs[2]!).inhibited).toBe(true)
  const unaffected = second.step(inputs[1]!)
  expect(unaffected.inhibited).toBe(false)
  expect(unaffected.actuators.slice(0, 4).every(n => n >= 0 && n <= 12)).toBe(true)
})
