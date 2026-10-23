import { expect, test } from 'bun:test'
import { createVtolTransitionProfile } from '../../resources/functions/drone/vehicles/vtol/transition-profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { createVtolFlightController } from '../../resources/functions/drone/vehicles/vtol/flight-controller'
import { multiplyQuaternion, quaternionEuler, quaternionFromTilt } from '../../resources/functions/drone/estimation/frames'
import { replayVehicleMission, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import type { VehicleControllerContext, VehiclePlantState } from '../../resources/functions/drone/vehicles/types'

// Agreed shared-runtime seam: actual front-transition dynamics and capture-bound observation;
// independent model probes are assertions only, never controller inputs or physical evidence.
test('an owned VTOL front transition transfers lift to the wing from actual relative-airflow observations', () => {
  const profile = createVtolTransitionProfile(), createSession = profile.createSession
  const independent: { atMs: number, state: VehiclePlantState }[] = [], inputs: VehicleControllerContext[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(c) { inputs.push(structuredClone(c)); return controller.step(c) } }),
      observeIndependent(state, atMs) { independent.push({ atMs, state: structuredClone(state) }) } }
  }
  const report = runVehicleSimulation(profile, { seconds: 35 })
  const front = report.trace.rows.filter(row => row.result.taskId === 'front')
  expect(front.length).toBeGreaterThan(10)
  const confirmed = report.trace.rows.filter(row => row.observation.transition?.mode === 'cruise' && row.observation.transition.outcome === 'confirmed')
  expect(confirmed).toHaveLength(1)
  const row = confirmed[0]!, request = front.find(row => row.result.transition)?.result.transition!
  expect(row.observation.transition!.phase).toBe('cruise')
  expect(row.observation.transition!.measurementCapturedAtMs).toBeGreaterThanOrEqual(request.issuedAtMs + 500)
  expect(row.result.taskId).toBe('cruise-leg')
  const before = independent.filter(p => p.atMs >= request.issuedAtMs && p.atMs <= row.observation.nowMs)
  expect(before.some(p => (p.state.details.airspeedMps as number) > 12)).toBe(true)
  const wingBorne = before.filter(p => p.atMs >= row.observation.nowMs - 500)
  expect(wingBorne.length).toBeGreaterThan(100)
  expect(wingBorne.every(p => (p.state.details.rotorThrustN as number) < 1)).toBe(true)
  expect(wingBorne.every(p => (p.state.details.airspeedMps as number) >= 12 && (p.state.details.airspeedMps as number) <= 14)).toBe(true)
  expect(before.every(p => Math.abs(p.state.positionM[2] + 15) < 2)).toBe(true)
  expect(before.every(p => quaternionEuler(p.state.quaternionWxyz).slice(0, 2).every(n => Math.abs(n) < 0.45))).toBe(true)
  expect(report.path.some(p => p.actuators[4]! > 0)).toBe(true)
  expect(inputs.every(c => !Object.hasOwn(c, 'truth') && c.estimate.evidence === 'fixture' && c.controlRate?.evidence === 'modeled-qualified-imu')).toBe(true)
  expect(report.physicalFlightEnabled).toBe(false)
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})


test('the owned VTOL route returns from wing-borne cruise to captured hover and a vertical landing', () => {
  const report = runVehicleSimulation(createVtolTransitionProfile(), { seconds: 160 })
  expect(report.status).toBe('completed')
  const phases = report.trace.rows.flatMap(row => row.observation.transition?.outcome === 'confirmed' ? [row.observation.transition.phase] : [])
  expect(phases).toEqual(['hover', 'cruise', 'hover'])
  expect(report.path.some(p => p.mission.taskId === 'back' && p.transitionObservation?.phase === 'back-transition')).toBe(true)
  const back = report.path.filter(p => p.mission.taskId === 'back')
  expect(back.length).toBeGreaterThan(50)
  expect(back.some(p => p.actuators.slice(0, 4).reduce((a, n) => a + n, 0) > 15)).toBe(true)
  expect(back.filter(p => p.mission.transition !== null).every(p => p.actuators[4] === 0)).toBe(true)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(true)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(Math.hypot(report.finalTruthPositionM[0] - 180, report.finalTruthPositionM[1])).toBeLessThan(0.3)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.mission.transition).toBeNull()
  expect(report.mission.targetM).toBeNull()
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})


test('the full modeled back-capture allowance remains finite and is charged to the complete mission reserve', () => {
  const plan = createVtolTransitionProfile().mission, back = plan.tasks.find(t => t.id === 'back')!
  if (back.kind !== 'vtol-mode') throw new Error('Expected the back mode task')
  back.timeoutMs = 45000
  expect(validateVehicleMission(plan).worstCaseMs).toBe(131520)
  expect(validateVehicleMission(plan).requiredWh).toBeCloseTo(43.84, 8)
  back.timeoutMs = 45001
  expect(() => validateVehicleMission(plan)).toThrow('unsupported profile')
  back.timeoutMs = 45000
  const front = plan.tasks.find(t => t.id === 'front')!
  if (front.kind !== 'vtol-mode') throw new Error('Expected the front mode task')
  front.timeoutMs = 15001
  expect(() => validateVehicleMission(plan)).toThrow('unsupported profile')
  front.timeoutMs = 15000
  plan.power.availableWh = 50
  expect(() => validateVehicleMission(plan)).toThrow('preserve energy reserve')
})


test('the original short back-capture budget fails without retry or a fabricated landing', () => {
  const profile = createVtolTransitionProfile(), back = profile.mission.tasks.find(t => t.id === 'back')!
  if (back.kind !== 'vtol-mode') throw new Error('Expected the back mode task')
  back.timeoutMs = 15000
  const report = runVehicleSimulation(profile, { seconds: 60 })
  expect(report.status).toBe('blocked')
  expect(report.mission.reason).toBe('vtol-transition-outcome-uncertain')
  expect(report.trace.rows.filter(r => r.observation.transition?.mode === 'hover' && r.observation.transition.outcome === 'confirmed')).toHaveLength(1)
  expect(report.path.some(p => p.mission.taskId === 'land')).toBe(false)
  expect(report.path.at(-1)!.measurement!.values.onSurface).toBe(false)
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
})


test('a physically failed modeled pusher cannot certify wing support or trigger an automatic retry', () => {
  const profile = createVtolTransitionProfile(), createSession = profile.createSession
  profile.createSession = () => {
    const session = createSession(), plant = session.createPlant()
    return { ...session, createPlant: () => ({ snapshot: () => plant.snapshot(), step(actuators, dtS, environment) {
      const applied = [...actuators]
      applied[4] = 0
      return plant.step(applied, dtS, environment)
    } }) }
  }
  const report = runVehicleSimulation(profile, { seconds: 60 })
  expect(report.status).toBe('blocked')
  expect(report.mission.reason).toBe('vtol-transition-outcome-uncertain')
  expect(report.path.some(p => p.actuators[4]! > 0.3)).toBe(true)
  expect(report.path.every(p => p.measurement!.values.pusherThrustN === 0)).toBe(true)
  expect(report.trace.rows.some(r => r.observation.transition?.mode === 'cruise' && r.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(report.transitions.filter(t => t.taskId === 'front' && t.state === 'running')).toHaveLength(1)
  expect(report.path.some(p => p.mission.taskId === 'cruise-leg')).toBe(false)
  expect(report.mission.transition).toBeNull()
  expect(report.board.expiresAtMs).toBeNull()
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
})


test('high ground speed in a co-moving-air fault fixture cannot substitute for relative wing airspeed', () => {
  // This artificial world fault follows the independently observed body velocity. It is not a
  // meteorological model, a fabricated air packet, or information supplied to the controller.
  const profile = createVtolTransitionProfile(), createSession = profile.createSession
  let active = false, wind: [number, number, number] = [0, 0, 0]
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(c) { if (c.mission.taskId === 'front') active = true; return controller.step(c) } }),
      observeIndependent(state) { wind = [...state.velocityMps] } }
  }
  profile.faults = () => active ? { windMps: [...wind] } : {}
  const report = runVehicleSimulation(profile, { seconds: 60 })
  expect(report.status).toBe('blocked')
  expect(report.mission.reason).toBe('vtol-transition-outcome-uncertain')
  const fast = report.trace.rows.filter(r => r.result.taskId === 'front' && Math.hypot(...r.observation.velocityMps) > 12)
  expect(fast.length).toBeGreaterThan(20)
  const fastStart = fast[0]!.observation.nowMs
  expect(report.path.filter(p => p.atMs >= fastStart).every(p => (p.measurement!.values.airspeedMps as number) < 0.1)).toBe(true)
  expect(report.trace.rows.some(r => r.observation.transition?.mode === 'cruise' && r.observation.transition.outcome === 'confirmed')).toBe(false)
  expect(report.path.some(p => p.mission.taskId === 'cruise-leg')).toBe(false)
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(report.board.expiresAtMs).toBeNull()
})


function actualTransitionInputs() {
  const profile = createVtolTransitionProfile(), createSession = profile.createSession, inputs: VehicleControllerContext[] = []
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(c) { inputs.push(structuredClone(c)); return controller.step(c) } }) }
  }
  expect(runVehicleSimulation(profile, { seconds: 160 }).status).toBe('completed')
  return inputs
}

test('front, cruise, back and post-back hover retain latching source, reference and clock guards', () => {
  const inputs = actualTransitionInputs()
  for (const [task, atMs] of [['front', 13000], ['cruise-leg', 20000], ['back', 30000], ['land', 68000]] as const) {
    const index = inputs.findIndex(c => c.nowMs === atMs)
    expect(index).toBeGreaterThan(0)
    expect(inputs[index]!.mission.taskId).toBe(task)
    for (const change of [
      (c: VehicleControllerContext) => { c.controlRate!.capturedAtMs -= 1000 },
      (c: VehicleControllerContext) => { c.controlRate!.reference = 'foreign-reference' },
      (c: VehicleControllerContext) => { c.measurement!.capturedAtMs -= 1000 },
      (c: VehicleControllerContext) => { c.measurement!.sequence -= 2 },
      (c: VehicleControllerContext) => { c.measurementPose!.reference = 'foreign-reference' },
      (c: VehicleControllerContext) => { c.measurementPose!.capturedAtMs -= 20 },
      (c: VehicleControllerContext) => { c.measurementPose!.gyroCapturedAtMs = NaN },
      (c: VehicleControllerContext) => { c.estimate.localPosition!.origin!.ellipsoidHeightM += 1 },
      (c: VehicleControllerContext) => { c.estimate.attitude!.quaternionWxyz = [2, 0, 0, 0] },
      (c: VehicleControllerContext) => { c.nowMs -= 20 },
    ]) {
      const controller = createVtolFlightController()
      let warmed = true
      for (const c of inputs.slice(0, index)) if (controller.step(c).inhibited) warmed = false
      expect(warmed).toBe(true)
      const invalid = structuredClone(inputs[index]!)
      change(invalid)
      const refused = controller.step(invalid)
      expect(refused.inhibited).toBe(true)
      expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
      expect(refused.transition).toBeUndefined()
      const next = controller.step(inputs[index + 1]!)
      expect(next.inhibited).toBe(true)
      expect(next.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    }
  }
})


for (const [task, atMs] of [['front', 13000], ['cruise-leg', 20000], ['back', 30000], ['land', 68000]] as const) {
  for (const failure of ['dropImu', 'dropPosition', 'dropVehicleSensor', 'rcOverride', 'kill', 'hostLost'] as const) {
    test(`VTOL ${task} withdraws independent output authority for ${failure}`, () => {
      const profile = createVtolTransitionProfile()
      profile.faults = (_scenario, nowMs) => nowMs >= atMs ? { [failure]: true } : {}
      const report = runVehicleSimulation(profile, { seconds: 90 })
      expect(report.status).toBe(failure === 'hostLost' ? 'host-lost' : 'blocked')
      expect(report.path.filter(p => p.atMs < atMs).at(-1)!.mission.taskId).toBe(task)
      expect(report.finalTruthPositionM[2]).toBeLessThan(0)
      expect(report.mission.state).not.toBe('completed')
      expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
      expect(report.board.expiresAtMs).toBeNull()
      if (failure === 'hostLost') {
        expect(report.board.fault).toBe('output-lease-expired')
        expect(report.authority.lastCheckedAtMs).toBeLessThan(atMs)
      }
      else {
        expect(report.mission.state).toBe('blocked')
        expect(report.mission.targetM).toBeNull()
        expect(report.mission.transition).toBeNull()
        expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
      }
      if (failure === 'rcOverride') expect(report.authority.events.some(event => event.to === 'manual')).toBe(true)
      if (failure === 'kill') expect(report.authority.events.some(event => event.to === 'killed')).toBe(true)
    })
  }
}


test('a turning VTOL cruise leg and back capture retain the same NED position and heading contract', () => {
  const profile = createVtolTransitionProfile()
  for (const task of profile.mission.tasks) {
    if (task.id === 'cruise-leg' || task.id === 'land') {
      if (!('positionM' in task)) throw new Error('Expected a position task')
      task.positionM[0] = 150; task.positionM[1] = 100
    }
    if (task.id === 'back' && task.kind === 'vtol-mode') task.headingRad = 1
  }
  const report = runVehicleSimulation(profile, { seconds: 160 })
  expect(report.status).toBe('completed')
  expect(report.path.some(p => p.truthPositionM[1] > 90)).toBe(true)
  expect(Math.hypot(report.finalTruthPositionM[0] - 150, report.finalTruthPositionM[1] - 100)).toBeLessThan(0.3)
  expect(report.finalTruthPositionM[2]).toBe(0)
  expect(report.trace.rows.filter(r => r.observation.transition?.outcome === 'confirmed').map(r => r.observation.transition!.phase)).toEqual(['hover', 'cruise', 'hover'])
  expect(report.board.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(replayVehicleMission(report.trace).snapshot()).toEqual(report.mission)
})


test('airflow capture attitude without its observed source epochs cannot drive the full controller', () => {
  const inputs = actualTransitionInputs(), index = inputs.findIndex(c => c.nowMs === 13000), controller = createVtolFlightController()
  for (const c of inputs.slice(0, index)) controller.step(c)
  const invalid = structuredClone(inputs[index]!)
  Reflect.deleteProperty(invalid.measurementPose!, 'attitudeCapturedAtMs')
  Reflect.deleteProperty(invalid.measurementPose!, 'gyroCapturedAtMs')
  const refused = controller.step(invalid)
  expect(refused.inhibited).toBe(true)
  expect(refused.transition).toBeUndefined()
  expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(controller.step(inputs[index + 1]!).inhibited).toBe(true)
})


test('a first full-flight mode request cannot invent a negative issuance or an oversized control budget', () => {
  const inputs = actualTransitionInputs(), index = inputs.findIndex(c => c.mission.transition?.mode === 'cruise')
  expect(index).toBeGreaterThan(0)
  for (const change of [
    (c: VehicleControllerContext) => { c.mission.transition!.issuedAtMs = -1 },
    (c: VehicleControllerContext) => { c.mission.transition!.expiresAtMs = c.mission.transition!.issuedAtMs + 15001 },
  ]) {
    const controller = createVtolFlightController()
    for (const c of inputs.slice(0, index)) controller.step(c)
    const invalid = structuredClone(inputs[index]!)
    change(invalid)
    const refused = controller.step(invalid)
    expect(refused.inhibited).toBe(true)
    expect(refused.transition).toBeUndefined()
    expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(controller.step(inputs[index + 1]!).inhibited).toBe(true)
  }
})


test('full-flight acknowledgements retain the oldest capture attitude and gyro actually consumed', () => {
  const inputs = actualTransitionInputs(), controller = createVtolFlightController()
  let fullFlight = false
  const overclaims: number[] = [], preRequest: number[] = []
  for (const c of inputs) {
    fullFlight ||= c.mission.transition?.mode === 'cruise'
    const response = controller.step(c), observation = response.transition
    if (!fullFlight || !observation) continue
    if (observation.measurementCapturedAtMs > c.measurementPose!.attitudeCapturedAtMs || observation.measurementCapturedAtMs > c.measurementPose!.gyroCapturedAtMs) overclaims.push(c.nowMs)
    if (observation.measurementCapturedAtMs < c.mission.transition!.issuedAtMs) preRequest.push(c.nowMs)
  }
  expect(fullFlight).toBe(true)
  expect(overclaims).toEqual([])
  expect(preRequest).toEqual([])
})


test('back hover cannot confirm while a near-stationary body remains away from the requested heading', () => {
  const inputs = actualTransitionInputs(), controller = createVtolFlightController()
  const back = inputs.filter(c => c.mission.taskId === 'back' && c.mission.transition?.mode === 'hover')
  expect(back.length).toBeGreaterThan(50)
  const startMs = back.at(-1)!.nowMs - 800
  const wrongYaw: [number, number, number, number] = [Math.cos(0.3 / 2), 0, 0, Math.sin(0.3 / 2)]
  let qualifiedSamples = 0
  const confirmations: number[] = []
  for (const c of inputs) {
    if (c.nowMs < startMs) { controller.step(c); continue }
    if (c.mission.taskId !== 'back' || !c.mission.transition) break
    // A measured yaw offset is a public input fixture, not a fabricated mode outcome.
    // Preserve actual position, velocity, gyro, airflow and every capture epoch.
    const offset = structuredClone(c)
    offset.estimate.attitude!.quaternionWxyz = multiplyQuaternion(wrongYaw, offset.estimate.attitude!.quaternionWxyz)
    offset.measurementPose!.quaternionWxyz = multiplyQuaternion(wrongYaw, offset.measurementPose!.quaternionWxyz)
    const response = controller.step(offset)
    expect(response.inhibited).toBe(false)
    const yaw = quaternionEuler(offset.estimate.attitude!.quaternionWxyz)[2]
    expect(Math.abs(Math.atan2(Math.sin(yaw - offset.mission.transition!.headingRad), Math.cos(yaw - offset.mission.transition!.headingRad)))).toBeGreaterThan(0.2)
    if (Math.hypot(...offset.estimate.localPosition!.velocityMps) <= 0.2 && Math.hypot(...offset.controlRate!.angularRateRadS) < 0.1) qualifiedSamples++
    if (response.transition?.outcome === 'confirmed') confirmations.push(c.nowMs)
  }
  expect(qualifiedSamples).toBeGreaterThan(25)
  expect(confirmations).toEqual([])
  // Continue the same controller with fresh observations of the recorded settled heading.
  // The prior wrong-heading window cannot count toward the required 500 ms dwell.
  const settled = back.at(-1)!, qualifiedAt: number[] = []
  for (let tick = 1; tick <= 30; tick++) {
    const c = structuredClone(settled), elapsedMs = tick * 20
    c.nowMs += elapsedMs; c.estimate.nowMs += elapsedMs
    c.estimate.attitude!.capturedAtMs! += elapsedMs
    c.estimate.localPosition!.capturedAtMs! += elapsedMs
    c.estimate.localPosition!.predictedToMs += elapsedMs
    c.controlRate!.capturedAtMs += elapsedMs
    c.measurement!.capturedAtMs += elapsedMs; c.measurement!.receivedAtMs += elapsedMs; c.measurement!.sequence += tick
    for (const key of ['capturedAtMs', 'positionCapturedAtMs', 'positionPredictedToMs', 'attitudeCapturedAtMs', 'attitudePredictedToMs', 'gyroCapturedAtMs'] as const) c.measurementPose![key] += elapsedMs
    const response = controller.step(c)
    expect(response.inhibited).toBe(false)
    if (response.transition?.outcome === 'confirmed') qualifiedAt.push(c.nowMs)
  }
  expect(qualifiedAt).toEqual([settled.nowMs + 520])
})

function unachievableBrakeObservation(context: VehicleControllerContext) {
  const input = structuredClone(context), pose = quaternionFromTilt(0, -0.4)
  input.estimate.attitude!.quaternionWxyz = [...pose]
  input.estimate.attitude!.eulerRad = [0, -0.4, 0]
  input.measurementPose!.quaternionWxyz = [...pose]
  input.controlRate!.angularRateRadS = [0, 0, 0]
  Object.assign(input.measurement!.values, { airspeedMps: 13, differentialPressurePa: 103.5125, alphaRad: 0.1, betaRad: 0 })
  return input
}

test('back braking refuses and latches when qualified airflow admits no pitch inside the declared bounds', () => {
  const inputs = actualTransitionInputs(), index = inputs.findIndex(c => c.mission.transition?.taskId === 'back')
  expect(index).toBeGreaterThan(0)
  const controller = createVtolFlightController()
  let warmed = true
  for (const input of inputs.slice(0, index)) if (controller.step(input).inhibited) warmed = false
  expect(warmed).toBe(true)
  const refused = controller.step(unachievableBrakeObservation(inputs[index]!))
  expect(refused.inhibited).toBe(true)
  expect(refused.reason).toBe('vtol-braking-no-feasible-pitch')
  expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(refused.transition).toBeUndefined()
  expect(controller.step(inputs[index + 1]!).inhibited).toBe(true)
})

function advanceControlEpoch(context: VehicleControllerContext) {
  const input = structuredClone(context)
  input.nowMs += 20; input.estimate.nowMs += 20; input.mission.elapsedMs += 20
  input.estimate.attitude!.capturedAtMs! += 20
  input.estimate.localPosition!.capturedAtMs! += 20
  input.estimate.localPosition!.predictedToMs += 20
  input.controlRate!.capturedAtMs += 20
  input.measurement!.capturedAtMs += 20; input.measurement!.receivedAtMs += 20; input.measurement!.sequence++
  for (const key of ['capturedAtMs', 'positionCapturedAtMs', 'positionPredictedToMs', 'attitudeCapturedAtMs', 'attitudePredictedToMs', 'gyroCapturedAtMs'] as const) input.measurementPose![key] += 20
  return input
}

test('a later front recovery cannot inherit a previous back leg rotary-capture latch', () => {
  const inputs = actualTransitionInputs(), index = inputs.findIndex(c => c.mission.taskId === 'land')
  expect(index).toBeGreaterThan(0)
  const controller = createVtolFlightController()
  let warmed = true
  for (const input of inputs.slice(0, index)) if (controller.step(input).inhibited) warmed = false
  expect(warmed).toBe(true)
  const front = advanceControlEpoch(inputs[index - 1]!), anchor = [...front.estimate.localPosition!.positionM] as [number, number, number]
  front.mission.taskId = 'front-second'; front.mission.taskKind = 'vtol-mode'; front.mission.targetM = anchor
  front.mission.transition = { eventId: 'front-second', taskId: 'front-second', mode: 'cruise', headingRad: 0, issuedAtMs: front.nowMs, expiresAtMs: front.nowMs + 15000, positionM: anchor, reference: front.measurement!.reference }
  expect(controller.step(front).inhibited).toBe(false)
  const recovery = unachievableBrakeObservation(advanceControlEpoch(front))
  recovery.mission.taskId = 'recover-second'
  recovery.mission.recovery = { failedEventId: 'front-second', failedTaskId: 'front-second', hoverTaskId: 'recover-second', triggeredAtMs: recovery.nowMs, cause: 'operator-recover' }
  recovery.mission.transition = { eventId: 'recover-second', taskId: 'recover-second', mode: 'hover', headingRad: 0, issuedAtMs: recovery.nowMs, expiresAtMs: recovery.nowMs + 45000, positionM: anchor, reference: recovery.measurement!.reference, supersedesEventId: 'front-second' }
  const refused = controller.step(recovery)
  expect(refused.inhibited).toBe(true)
  expect(refused.reason).toBe('vtol-braking-no-feasible-pitch')
  expect(refused.actuators).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(refused.transition).toBeUndefined()
})
