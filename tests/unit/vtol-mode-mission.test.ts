import { expect, test } from 'bun:test'
import type { VehicleMissionObservation, VehicleMissionPlan, VehicleVtolTransitionCommand, VehicleVtolTransitionObservation } from '../../resources/functions/drone/vehicles/types'
import { checkpointVehicleMission, createVehicleMissionEngine, replayVehicleMission, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'
import { createVtolHoverProfile } from '../../resources/functions/drone/vehicles/vtol'

// Public mission seam catches requested/observed ordering and replay, not controller dynamics or hardware.
test('an explicit VTOL hover request waits for its correlated observed outcome before takeoff', () => {
  const input = {
    ...createVtolHoverProfile().mission,
    id: 'vtol-mode-policy',
    tasks: [
      { id: 'start', kind: 'start', next: 'confirm-hover' },
      { id: 'confirm-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 1000, next: 'depart' },
      { id: 'depart', kind: 'takeoff', positionM: [0, 0, -5], acceptanceM: 0.2, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 2000, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 2000 },
    ],
  } satisfies VehicleMissionPlan
  const reference = '55:0,0,0,0,0'
  const observation = (nowMs: number): VehicleMissionObservation => ({ kind: 'simulation', nowMs, reference, origin: input.origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true, payloadAck: null, transition: null })
  const engine = createVehicleMissionEngine(input)
  expect(engine.step(observation(1000), 'start').taskId).toBe('confirm-hover')
  const requested = engine.step(observation(1020))
  expect(requested).toMatchObject({ taskId: 'confirm-hover', targetM: [0, 0, 0], transition: {
    eventId: 'vtol-mode-policy:55:0,0,0,0,0:confirm-hover', taskId: 'confirm-hover', mode: 'hover', headingRad: 0,
    issuedAtMs: 1020, expiresAtMs: 2000, positionM: [0, 0, 0], reference,
  } })
  expect(engine.step(observation(1040))).toMatchObject({ state: 'running', taskId: 'confirm-hover', targetM: [0, 0, 0], transition: requested.transition })
  const confirmed = engine.step({ ...observation(1060), transition: {
    evidence: 'modeled-vtol-controller-observation', eventId: 'vtol-mode-policy:55:0,0,0,0,0:confirm-hover', taskId: 'confirm-hover', mode: 'hover', reference,
    capturedAtMs: 1060, measurementCapturedAtMs: 1040, phase: 'hover', outcome: 'confirmed', reason: 'hover-qualified',
  } })
  expect(confirmed).toMatchObject({ state: 'running', taskId: 'depart', reason: 'vtol-transition-confirmed', targetM: [0, 0, -5], transition: null, physicalFlightEnabled: false })
  expect(replayVehicleMission(engine.trace()).snapshot()).toEqual(confirmed)
})

function awaitingHover() {
  const input = createVtolHoverProfile().mission
  if (input.tasks[0]!.kind !== 'start') throw new Error('Expected the declared VTOL start task')
  input.tasks[0]!.next = 'confirm-hover'
  input.tasks.splice(1, 0, { id: 'confirm-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 1000, next: 'depart' })
  const reference = '55:0,0,0,0,0'
  const observation = (nowMs: number): VehicleMissionObservation => ({ kind: 'simulation', nowMs, reference, origin: input.origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true, payloadAck: null, transition: null })
  const engine = createVehicleMissionEngine(input)
  engine.step(observation(1000), 'start'); engine.step(observation(1020))
  const command = engine.snapshot().transition!
  const confirmed = (capturedAtMs: number, measurementCapturedAtMs: number): VehicleVtolTransitionObservation => ({ evidence: 'modeled-vtol-controller-observation', eventId: command.eventId, taskId: command.taskId, mode: command.mode, reference: command.reference, capturedAtMs, measurementCapturedAtMs, phase: 'hover', outcome: 'confirmed', reason: 'hover-qualified' })
  return { engine, observation, confirmed }
}

test('older VTOL phase evidence cannot confirm a request after newer progress or regain the blocked mission', () => {
  const { engine, observation, confirmed } = awaitingHover()
  expect(engine.step({ ...observation(1060), transition: { ...confirmed(1060, 1040), outcome: 'progress', reason: 'hover-qualifying' } }).taskId).toBe('confirm-hover')
  const replayed = engine.step({ ...observation(1080), transition: confirmed(1040, 1020) })
  expect(replayed).toMatchObject({ state: 'blocked', reason: 'vtol-transition-observation-replayed', targetM: null, transition: null })
  expect(engine.step(observation(1100), 'resume').state).toBe('blocked')
})

test('VTOL mode outcomes require matching identity, reference, post-request capture and the requested phase', () => {
  for (const change of [
    { eventId: 'foreign-event' }, { taskId: 'foreign-task' }, { mode: 'cruise' }, { reference: '56:0,0,0,0,0' },
    { capturedAtMs: 1000, measurementCapturedAtMs: 1000 }, { capturedAtMs: 1080 }, { measurementCapturedAtMs: 1000 }, { phase: 'cruise' },
  ] satisfies Partial<VehicleVtolTransitionObservation>[]) {
    const { engine, observation, confirmed } = awaitingHover()
    const refused = engine.step({ ...observation(1060), transition: { ...confirmed(1060, 1040), ...change } })
    expect(refused).toMatchObject({ state: 'blocked', reason: 'vtol-transition-outcome-uncertain', targetM: null, transition: null })
    expect(engine.step(observation(1080), 'resume').state).toBe('blocked')
  }
})

test('identical retained progress is order independent but altered same-epoch confirmation is a replay', () => {
  const { engine, observation, confirmed } = awaitingHover()
  const progress: VehicleVtolTransitionObservation = { ...confirmed(1060, 1040), outcome: 'progress', reason: 'hover-qualifying' }
  engine.step({ ...observation(1060), transition: progress })
  const reordered: VehicleVtolTransitionObservation = {
    reason: progress.reason, outcome: progress.outcome, phase: progress.phase, measurementCapturedAtMs: progress.measurementCapturedAtMs, capturedAtMs: progress.capturedAtMs,
    reference: progress.reference, mode: progress.mode, taskId: progress.taskId, eventId: progress.eventId, evidence: progress.evidence,
  }
  expect(engine.step({ ...observation(1080), transition: reordered }).taskId).toBe('confirm-hover')
  expect(engine.step({ ...observation(1100), transition: confirmed(1060, 1040) })).toMatchObject({ state: 'blocked', reason: 'vtol-transition-observation-replayed', transition: null })
})

test('a pending VTOL transition expires at its original task deadline and cannot be checkpointed or silently recovered', () => {
  for (const action of ['pause', 'recover'] as const) {
    const { engine, observation } = awaitingHover()
    expect(() => checkpointVehicleMission(engine.trace(), 1020)).toThrow('not resumable')
    expect(engine.step(observation(1040), action)).toMatchObject({ state: 'blocked', reason: 'vtol-transition-recovery-uncertain', targetM: null, transition: null })
    expect(engine.step(observation(1060), 'resume').state).toBe('blocked')
  }
  const { engine, observation, confirmed } = awaitingHover()
  for (let now = 1040; now < 2000; now += 20) expect(engine.step(observation(now)).taskId).toBe('confirm-hover')
  expect(engine.step({ ...observation(2000), transition: confirmed(1980, 1960) })).toMatchObject({ state: 'blocked', reason: 'vtol-transition-outcome-uncertain', targetM: null, transition: null })
})

test('malformed VTOL outcome packets release the mission rather than supplying a partial confirmation', () => {
  for (const mutate of [
    (p: VehicleVtolTransitionObservation) => { Reflect.deleteProperty(p, 'measurementCapturedAtMs') },
    (p: VehicleVtolTransitionObservation) => { Reflect.set(p, 'capturedAtMs', NaN) },
    (p: VehicleVtolTransitionObservation) => { Object.assign(p, { extra: true }) },
    (p: VehicleVtolTransitionObservation) => { Object.assign(p, { extra: () => true }) },
    (p: VehicleVtolTransitionObservation) => { p.reason = 'not a bounded reason' },
  ]) {
    const { engine, observation, confirmed } = awaitingHover(), packet = confirmed(1060, 1040)
    mutate(packet)
    expect(() => engine.step({ ...observation(1060), transition: packet })).toThrow('Invalid vehicle mission observation')
    expect(engine.snapshot()).toMatchObject({ state: 'blocked', targetM: null, transition: null })
  }
})

test('old hover recordings keep their exact observation and snapshot keys and other vehicle plans reject VTOL tasks', () => {
  const input = createVtolHoverProfile().mission, engine = createVehicleMissionEngine(input)
  const before = engine.snapshot()
  const old: VehicleMissionObservation = { kind: 'simulation', nowMs: 1000, reference: '55:0,0,0,0,0', origin: input.origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true, payloadAck: null }
  engine.step(old, 'start')
  expect(Object.keys(before).sort()).toEqual(['version', 'vehicle', 'evidence', 'physicalFlightEnabled', 'state', 'taskId', 'taskKind', 'targetM', 'payload', 'reason', 'elapsedMs'].sort())
  expect(Object.keys(engine.snapshot()).sort()).toEqual(Object.keys(before).sort())
  expect(Object.keys(engine.trace().rows[0]!.observation).sort()).toEqual(['kind', 'nowMs', 'reference', 'origin', 'healthy', 'positionM', 'velocityMps', 'authority', 'batteryPercent', 'onGround', 'payloadAck'].sort())
  expect(replayVehicleMission(engine.trace()).snapshot()).toEqual(engine.snapshot())
  for (const vehicle of ['fixed-wing', 'ground', 'surface', 'subsea'] as const) {
    const base: VehicleMissionPlan = { ...input, vehicle, tasks: [{ id: 'start', kind: 'start', next: 'abort' }, { id: 'abort', kind: 'abort' }] }
    expect(() => validateVehicleMission(base)).not.toThrow()
    base.tasks = [{ id: 'start', kind: 'start', next: 'hover' }, { id: 'hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 1000, next: 'abort' }, { id: 'abort', kind: 'abort' }]
    expect(() => validateVehicleMission(base)).toThrow('unsupported profile')
  }
})

test('front and back requests retain distinct identities and require their observed destination phases in replay', () => {
  const input: VehicleMissionPlan = { ...createVtolHoverProfile().mission, tasks: [
    { id: 'start', kind: 'start', next: 'depart' },
    { id: 'depart', kind: 'takeoff', positionM: [0, 0, -5], acceptanceM: 0.2, maxArrivalSpeedMps: 0.2, settleMs: 0, timeoutMs: 2000, next: 'front' },
    { id: 'front', kind: 'vtol-mode', mode: 'cruise', headingRad: 0, timeoutMs: 2000, next: 'leg' },
    { id: 'leg', kind: 'waypoint', positionM: [20, 0, -5], acceptanceM: 1, maxArrivalSpeedMps: 15, settleMs: 0, timeoutMs: 2000, next: 'back' },
    { id: 'back', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 2000, next: 'land' },
    { id: 'land', kind: 'land', positionM: [20, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 0, timeoutMs: 2000 },
  ] }
  const observation = (nowMs: number, positionM: [number, number, number] = [0, 0, -5], onGround = false, velocityMps: [number, number, number] = [0, 0, 0]): VehicleMissionObservation => ({ kind: 'simulation', nowMs, reference: '55:0,0,0,0,0', origin: input.origin, healthy: true, positionM, velocityMps, authority: 'autonomous', batteryPercent: 100, onGround, payloadAck: null, transition: null })
  const outcome = (request: VehicleVtolTransitionCommand, now: number, phase: VehicleVtolTransitionObservation['phase'], status: VehicleVtolTransitionObservation['outcome']): VehicleVtolTransitionObservation => ({ evidence: 'modeled-vtol-controller-observation', eventId: request.eventId, taskId: request.taskId, mode: request.mode, reference: request.reference, capturedAtMs: now, measurementCapturedAtMs: now - 20, phase, outcome: status, reason: status === 'confirmed' ? 'mode-qualified' : 'mode-progress' })
  const engine = createVehicleMissionEngine(input)
  engine.step(observation(1000, [0, 0, 0], true), 'start'); engine.step(observation(1020))
  const front = engine.step(observation(1040)).transition!
  expect(front.mode).toBe('cruise')
  expect(engine.step({ ...observation(1060), transition: outcome(front, 1060, 'front-transition', 'progress') }).taskId).toBe('front')
  expect(engine.step({ ...observation(1080), transition: outcome(front, 1080, 'cruise', 'confirmed') }).taskId).toBe('leg')
  engine.step(observation(1100, [20, 0, -5], false, [13, 0, 0]))
  const back = engine.step(observation(1120, [20.2, 0, -5], false, [13, 0, 0])).transition!
  expect(back.mode).toBe('hover'); expect(back.eventId).not.toBe(front.eventId)
  const foreign = replayVehicleMission(engine.trace())
  expect(foreign.step({ ...observation(1140), transition: outcome(front, 1140, 'cruise', 'confirmed') }).reason).toBe('vtol-transition-outcome-uncertain')
  expect(engine.step({ ...observation(1140), transition: outcome(back, 1140, 'back-transition', 'progress') }).taskId).toBe('back')
  expect(engine.step({ ...observation(1160), transition: outcome(back, 1160, 'hover', 'confirmed') }).taskId).toBe('land')
  expect(engine.step(observation(1180, [20, 0, 0], true)).state).toBe('completed')
  expect(replayVehicleMission(engine.trace()).snapshot()).toEqual(engine.snapshot())
})

test('observed transition aborts and confirmations reused after consumption cannot advance or retry the mission', () => {
  const aborted = awaitingHover()
  expect(aborted.engine.step({ ...aborted.observation(1060), transition: { ...aborted.confirmed(1060, 1040), outcome: 'aborted', reason: 'transition-rejected' } })).toMatchObject({ state: 'blocked', reason: 'vtol-transition-aborted', transition: null, targetM: null })
  expect(aborted.engine.step(aborted.observation(1080), 'resume').state).toBe('blocked')
  const consumed = awaitingHover(), packet = consumed.confirmed(1060, 1040)
  expect(consumed.engine.step({ ...consumed.observation(1060), transition: packet }).taskId).toBe('depart')
  expect(consumed.engine.step({ ...consumed.observation(1080), transition: packet })).toMatchObject({ state: 'blocked', reason: 'unsolicited-vtol-transition', transition: null, targetM: null })
  const operator = awaitingHover()
  expect(operator.engine.step(operator.observation(1040), 'abort')).toMatchObject({ state: 'aborted', reason: 'operator-abort', transition: null, targetM: null })
})
