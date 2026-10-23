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

function observedControllerInputs(profile = createVtolHoverProfile(), expectedStatus: ReturnType<typeof runVehicleSimulation>['status'] = 'completed') {
  const createSession = profile.createSession, inputs: VehicleControllerContext[] = []
  profile.createSession = () => {
    const session = createSession(), createController = session.createController
    return { ...session, createController() {
      const controller = createController()
      return { step(context) { inputs.push(structuredClone(context)); return controller.step(context) } }
    } }
  }
  expect(runVehicleSimulation(profile, { seconds: 60 }).status).toBe(expectedStatus)
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


function initialModeProfile(mode: 'hover' | 'cruise' = 'hover', headingRad = 0) {
  const profile = createVtolHoverProfile()
  profile.mission.id = 'vtol-observed-initial-hover'
  if (profile.mission.tasks[0]!.kind !== 'start') throw new Error('Expected the declared start task')
  profile.mission.tasks[0]!.next = 'confirm-hover'
  profile.mission.tasks.splice(1, 0, { id: 'confirm-hover', kind: 'vtol-mode', mode, headingRad, timeoutMs: 1000, next: 'depart' })
  return profile
}

test('an actual initial hover observation crosses the shared runtime once before vertical departure', () => {
  const profile = initialModeProfile(), createSession = profile.createSession
  const outputs: { context: VehicleControllerContext, output: ReturnType<ReturnType<typeof createVtolVehicleHoverController>['step']> }[] = []
  profile.createSession = () => {
    const session = createSession(), createController = session.createController
    return { ...session, createController() {
      const controller = createController()
      return { step(context) {
        const output = controller.step(context)
        outputs.push({ context: structuredClone(context), output: structuredClone(output) })
        return output
      } }
    } }
  }
  const report = runVehicleSimulation(profile, { seconds: 60 })
  expect(report.status).toBe('completed')
  const confirmed = outputs.filter(row => row.output.transition?.outcome === 'confirmed')
  expect(confirmed).toHaveLength(1)
  const { context, output } = confirmed[0]!, request = context.mission.transition!
  expect(context.measurement!.capturedAtMs).toBeGreaterThanOrEqual(request.issuedAtMs)
  expect(output.transition).toMatchObject({ eventId: request.eventId, taskId: 'confirm-hover', mode: 'hover', phase: 'hover', outcome: 'confirmed', reference: request.reference, capturedAtMs: context.nowMs })
  expect(output.transition!.measurementCapturedAtMs).toBeGreaterThanOrEqual(request.issuedAtMs + 200)
  const delivered = report.trace.rows.filter(row => row.observation.transition?.outcome === 'confirmed')
  expect(delivered).toHaveLength(1)
  expect(delivered[0]!.observation.nowMs).toBe(context.nowMs + 20)
  expect(delivered[0]!.observation.transition).toEqual(output.transition)
  expect(outputs.filter(row => row.context.mission.taskId === 'confirm-hover').every(row => row.output.actuators.every(n => n === 0))).toBe(true)
  for (const row of outputs.filter(row => row.output.transition)) {
    const epoch = row.output.transition!.measurementCapturedAtMs
    expect(epoch).toBeLessThanOrEqual(row.context.measurement!.capturedAtMs)
    expect(epoch).toBeLessThanOrEqual(row.context.controlRate!.capturedAtMs)
    expect(epoch).toBeLessThanOrEqual(row.context.estimate.attitude!.capturedAtMs!)
    expect(epoch).toBeLessThanOrEqual(row.context.estimate.localPosition!.capturedAtMs!)
  }
  expect(report.path.some(row => row.truthPositionM[2] < -4)).toBe(true)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})


test('initial mode observation cannot survive real sensor or host loss before its qualifying dwell', () => {
  for (const drop of ['dropImu', 'dropPosition', 'dropVehicleSensor', 'hostLost'] as const) {
    const profile = initialModeProfile()
    profile.faults = (_scenario, atMs) => atMs >= 620 ? { [drop]: true } : {}
    const report = runVehicleSimulation(profile, { seconds: 2 })
    expect(report.status).toBe(drop === 'hostLost' ? 'host-lost' : 'blocked')
    expect(report.trace.rows.some(row => row.observation.transition?.outcome === 'confirmed')).toBe(false)
    expect(report.trace.rows.some(row => row.result.taskId === 'depart')).toBe(false)
    expect(report.path.every(row => row.actuators.every(n => n === 0))).toBe(true)
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(report.board.expiresAtMs).toBeNull()
    if (drop === 'hostLost') expect(report.board.fault).toBe('output-lease-expired')
    else expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
  }
})

test('the hover adapter reports unsupported cruise as an abort and a mismatched initial heading times out', () => {
  const unsupported = runVehicleSimulation(initialModeProfile('cruise'), { seconds: 2 })
  expect(unsupported.status).toBe('blocked')
  expect(unsupported.mission.reason).toBe('vtol-transition-aborted')
  const aborted = unsupported.trace.rows.find(row => row.observation.transition?.outcome === 'aborted')!.observation.transition!
  expect(aborted).toMatchObject({ mode: 'cruise', phase: 'hover', reason: 'hover-only-controller' })
  expect(unsupported.trace.rows.some(row => row.result.taskId === 'depart')).toBe(false)
  const wrongHeading = runVehicleSimulation(initialModeProfile('hover', 1), { seconds: 2 })
  expect(wrongHeading.status).toBe('blocked')
  expect(wrongHeading.mission.reason).toBe('vtol-transition-outcome-uncertain')
  expect(wrongHeading.trace.rows.some(row => row.observation.transition?.outcome === 'confirmed')).toBe(false)
  expect(wrongHeading.path.every(row => row.actuators.every(n => n === 0))).toBe(true)
  for (const report of [unsupported, wrongHeading]) {
    expect(report.mission.targetM).toBeNull()
    expect(report.mission.transition).toBeNull()
    expect(report.board.expiresAtMs).toBeNull()
    expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
  }
})


test('fresh ground contact cannot bypass current rate, request reference or expiry before mode confirmation', () => {
  const inputs = observedControllerInputs(initialModeProfile())
  const index = inputs.findIndex(c => c.mission.transition && c.measurement!.capturedAtMs >= c.mission.transition.issuedAtMs)
  expect(index).toBeGreaterThan(0)
  for (const mutate of [
    (c: VehicleControllerContext) => { c.controlRate!.capturedAtMs -= 1000 },
    (c: VehicleControllerContext) => { c.controlRate!.reference = 'another-reference' },
    (c: VehicleControllerContext) => { c.mission.transition!.reference = 'another-reference' },
    (c: VehicleControllerContext) => { c.mission.transition!.expiresAtMs = c.nowMs },
    (c: VehicleControllerContext) => { c.mission.transition!.issuedAtMs = c.nowMs + 20 },
    (c: VehicleControllerContext) => { c.mission.transition!.headingRad = NaN },
  ]) {
    const controller = createVtolVehicleHoverController()
    for (const c of inputs.slice(0, index)) expect(controller.step(c).inhibited).toBe(false)
    const invalid = structuredClone(inputs[index]!)
    mutate(invalid)
    const refused = controller.step(invalid)
    expect(refused.inhibited).toBe(true)
    expect(refused.transition).toBeUndefined()
    expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(controller.step(inputs[index + 1]!).inhibited).toBe(true)
  }
})

test('legacy hover runtime records and outputs retain their shapes when no explicit modes are declared', () => {
  const profile = createVtolHoverProfile(), createSession = profile.createSession
  let emitted = false
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(c) {
      const result = controller.step(c)
      if (Object.hasOwn(result, 'transition')) emitted = true
      return result
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 60 })
  expect(report.status).toBe('completed')
  expect(emitted).toBe(false)
  expect(report.path.every(row => !Object.hasOwn(row, 'transitionObservation') && !Object.hasOwn(row.mission, 'transition'))).toBe(true)
  expect(report.trace.rows.every(row => !Object.hasOwn(row.observation, 'transition') && !Object.hasOwn(row.result, 'transition'))).toBe(true)
})


test('a first hover request for a different position cannot certify the held target or clear its refusal', () => {
  const inputs = observedControllerInputs(initialModeProfile())
  const index = inputs.findIndex(c => c.mission.transition !== null)
  const invalid = structuredClone(inputs[index]!)
  expect(invalid.mission.targetM).toEqual([0, 0, 0])
  invalid.mission.transition!.positionM = [10, 0, 0]
  const controller = createVtolVehicleHoverController(), result = controller.step(invalid)
  expect(result.inhibited).toBe(true)
  expect(result.transition).toBeUndefined()
  expect(result.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(controller.step(inputs[index + 1]!).inhibited).toBe(true)
})

test('changing capture lag cannot shorten the observed hover stability dwell', () => {
  // Real ground sensor/estimator contexts from an unobserved-heading mission retain the actual
  // 100 ms GNSS and 60 ms contact cadence. A fresh public controller observes north instead.
  const inputs = observedControllerInputs(initialModeProfile('hover', 1), 'blocked')
  const controller = createVtolVehicleHoverController(), confirmed: number[] = []
  const observed = inputs.filter(c => c.nowMs >= 900 && c.nowMs <= 1100)
  expect(observed).toHaveLength(11)
  expect(observed[0]!.estimate.localPosition!.capturedAtMs).toBe(800)
  for (const input of observed) {
    input.mission.transition!.headingRad = 0
    const output = controller.step(input)
    expect(output.inhibited).toBe(false)
    if (output.transition?.outcome === 'confirmed') confirmed.push(input.nowMs)
  }
  expect(confirmed).toHaveLength(1)
  expect(confirmed[0]!).toBeGreaterThanOrEqual(1100)
})


test('custom target iterators cannot certify a different position from its own numeric slots', () => {
  const inputs = observedControllerInputs(initialModeProfile('hover', 1), 'blocked'), controller = createVtolVehicleHoverController()
  let iteratorCalls = 0, confirmed = false
  for (const input of inputs.filter(c => c.nowMs >= 900 && c.nowMs <= 1120)) {
    const heldTarget: [number, number, number] = [10, 0, 0]
    Object.defineProperty(heldTarget, Symbol.iterator, { value: function* () { iteratorCalls++; yield 0; yield 0; yield 0 } })
    input.mission.targetM = heldTarget
    input.mission.transition!.positionM = [10, 0, 0]
    input.mission.transition!.headingRad = 0
    const result = controller.step(input)
    expect(result.inhibited).toBe(false)
    if (result.transition?.outcome === 'confirmed') confirmed = true
  }
  expect(confirmed).toBe(false)
  expect(iteratorCalls).toBe(0)
})
