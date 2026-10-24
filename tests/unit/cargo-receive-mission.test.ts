import { expect, test } from 'bun:test'
import type { VehicleMissionObservation, VehiclePayloadCommand } from '../../resources/functions/drone/vehicles/types'
import { createReceivingRigidBody } from '../../resources/functions/drone/controls/physics'
import { createVehicleSimulationSession } from '../../resources/functions/drone/vehicles/runtime'
import { createMultirotorPlant, createMultirotorProfile, multirotorMission } from '../../resources/functions/drone/vehicles/multirotor/profile'
import { createVehicleMissionEngine, parseVehicleMissionTrace, replayVehicleMission, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'

function receivePlan() {
  const spatial = { acceptanceM: .2, maxArrivalSpeedMps: .18, settleMs: 200, timeoutMs: 10000 }
  return { ...multirotorMission(), id: 'cargo-receiver', tasks: [
    { id: 'start', kind: 'start', next: 'intake' },
    { id: 'intake', kind: 'payload', operation: 'material-receive', containerId: 'parcel-a', positionM: [3, 2, -.1], timeoutMs: 60000, next: 'depart', onFailure: 'divert' },
    { id: 'depart', kind: 'takeoff', positionM: [3, 2, -1], ...spatial, next: 'land' },
    { id: 'land', kind: 'land', positionM: [3, 2, 0], ...spatial },
    { id: 'divert', kind: 'waypoint', positionM: [4, 2, -1], ...spatial, timeoutMs: 8000, next: 'alternate' },
    { id: 'alternate', kind: 'land', positionM: [4, 2, 0], ...spatial, timeoutMs: 8000 },
  ] }
}
function observation(nowMs: number): VehicleMissionObservation {
  return { kind: 'simulation', nowMs, reference: '102:0,0,0,0,0', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, healthy: true, positionM: [3, 2, -.1], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 98, onGround: true, payloadAck: null }
}

// Native mission function seam: proves receipt command, anchor, scope and counted
// plan behavior. It does not produce mechanical intake or current payload authority.
test('a receiving mission holds its declared pad and advances only after its own correlated receipt ACK', () => {
  const plan = receivePlan(), validated = validateVehicleMission(plan)
  expect(validated.worstCaseMs).toBe(80020)
  const engine = createVehicleMissionEngine(plan)
  expect(engine.step(observation(600), 'start')).toMatchObject({ taskId: 'intake', state: 'running', targetM: [3, 2, -.1] })
  const pending = engine.step(observation(620)).payload!
  expect(pending).toMatchObject({ taskId: 'intake', operation: 'material-receive', containerId: 'parcel-a', reference: '102:0,0,0,0,0', issuedAtMs: 600, expiresAtMs: 60600 })
  const result = engine.step({ ...observation(640), payloadAck: { eventId: pending.eventId, taskId: pending.taskId, operation: pending.operation, containerId: pending.containerId, reference: pending.reference, positionM: pending.positionM, capturedAtMs: 640, outcome: 'confirmed' } })
  expect(result.taskId).toBe('depart')
  expect(result.reason).toBe('payload-confirmed')
  expect(result.payload).toBeNull()
  expect(replayVehicleMission(engine.trace()).snapshot()).toEqual(result)
  expect(parseVehicleMissionTrace(JSON.stringify(engine.trace()))).toEqual(engine.trace())
})


// Actual receiving body plus raw-sensor/estimator/authority runtime. The only
// external fixture is a payload wire that withholds its ACK, not an intake mock.
test('an unacknowledged receiving mission keeps its actual parked body neutral under its own live authority', () => {
  const body = createReceivingRigidBody({ positionM: [3, 2, -.1], groundDownM: -.1, expectedPointLoad: { id: 'parcel-a', massKg: .1, forwardM: .08 } })
  const profile = createMultirotorProfile(), create = profile.createSession
  profile.mission = validateVehicleMission(receivePlan()).plan
  const commands: VehiclePayloadCommand[] = []
  profile.createSession = () => ({ ...create(), createPlant: () => createMultirotorPlant(body), createPayload: () => ({ request(command) { commands.push(structuredClone(command)) }, poll() { return null }, close() {} }) })
  const session = createVehicleSimulationSession(profile, { seconds: 3, scope: { bootId: 102n, sessionId: 202n } })
  try {
    for (let nowMs = 0; nowMs <= 2000; nowMs += 4) {
      const row = session.step(nowMs)
      if (nowMs >= 600) {
        expect(row.authority.state).toBe('autonomous')
        expect(row.authority.sessionId).toBe(202n)
        expect(row.reference.startsWith('102:')).toBe(true)
        expect(row.board.actuators).toEqual([0, 0, 0, 0])
        expect(body.snapshot().positionM).toEqual([3, 2, -.1])
        expect(body.snapshot().motorsN).toEqual([0, 0, 0, 0])
        expect(body.loadSnapshot().properties.totalMassKg).toBe(1.5)
      }
    }
    expect(commands).toHaveLength(1)
    expect(commands[0]!.operation).toBe('material-receive')
    expect(commands[0]!.issuedAtMs).toBe(600)
    expect(body.loadSnapshot().properties.phase).toBe('awaiting')
  }
  finally { session.close() }
})

test('a foreign, stale or uncertain receipt takes only the declared counted failure route', () => {
  for (const changed of [
    { reference: '101:0,0,0,0,0' }, { eventId: 'source-vehicle-event' }, { containerId: 'parcel-b' },
    { capturedAtMs: 599 }, { capturedAtMs: 641 }, { outcome: 'uncertain' as const }, { outcome: 'rejected' as const },
  ]) {
    const engine = createVehicleMissionEngine(receivePlan())
    const request = engine.step(observation(600), 'start').payload!
    const ack = { eventId: request.eventId, taskId: request.taskId, operation: request.operation, containerId: request.containerId, reference: request.reference, positionM: request.positionM, capturedAtMs: 620, outcome: 'confirmed' as 'confirmed' | 'uncertain' | 'rejected', ...changed }
    const row = engine.step({ ...observation(640), payloadAck: ack })
    expect(row.taskId).toBe('divert')
    expect(row.payloadFailure).toMatchObject({ taskId: 'intake', operation: 'material-receive', approachTaskId: 'divert', landingTaskId: 'alternate' })
    expect(row.payload).toBeNull()
    expect(row.reason).toBe('payload-failure-diversion')
  }
})

test('receiving cannot start or accept an ACK away from its pad, moving or without contact', () => {
  for (const change of [{ onGround: false }, { positionM: [3, 2, -.31] as [number, number, number] }, { velocityMps: [.101, 0, 0] as [number, number, number] }]) {
    for (const atEntry of [true, false]) {
      const engine = createVehicleMissionEngine(receivePlan())
      let result
      if (atEntry) result = engine.step({ ...observation(600), ...change }, 'start')
      else {
        const pending = engine.step(observation(600), 'start').payload!
        result = engine.step({ ...observation(620), ...change, payloadAck: { eventId: pending.eventId, taskId: pending.taskId, operation: pending.operation, containerId: pending.containerId, reference: pending.reference, positionM: pending.positionM, capturedAtMs: 620, outcome: 'confirmed' } })
      }
      expect(result.state).toBe('blocked')
      expect(result.payload).toBeNull()
      expect(result.taskId).not.toBe('depart')
      expect(result.targetM).toBeNull()
    }
  }
})

test('receipt expiry diverts once and cannot be cleared by a late ACK', () => {
  const engine = createVehicleMissionEngine(receivePlan())
  const pending = engine.step(observation(600), 'start').payload!
  for (let atMs = 620; atMs <= 60600; atMs += 20) engine.step(observation(atMs))
  const timedOut = engine.snapshot()
  expect(timedOut.taskId).toBe('divert')
  expect(timedOut.payloadFailure).toMatchObject({ reason: 'timeout', triggeredAtMs: 60600 })
  const late = engine.step({ ...observation(60620), payloadAck: { eventId: pending.eventId, taskId: pending.taskId, operation: pending.operation, containerId: pending.containerId, reference: pending.reference, positionM: pending.positionM, capturedAtMs: 60600, outcome: 'confirmed' } })
  expect(late.state).toBe('blocked')
  expect(late.taskId).toBe('divert')
  expect(late.reason).toBe('unsolicited-payload-ack')
})

test('receipt validation preserves finite graph reserve and rejects unsupported profiles, missing anchors and retry paths', () => {
  for (const change of [
    (p: ReturnType<typeof receivePlan>) => { p.vehicle = 'ground' },
    (p: ReturnType<typeof receivePlan>) => { Reflect.set(p.tasks[1]!, 'containerId', null) },
    (p: ReturnType<typeof receivePlan>) => { delete p.tasks[1]!.positionM },
    (p: ReturnType<typeof receivePlan>) => { p.tasks[1]!.positionM = [3, 2, -1.001] },
    (p: ReturnType<typeof receivePlan>) => { p.tasks[1]!.timeoutMs = 60001 },
    (p: ReturnType<typeof receivePlan>) => { p.tasks[1]!.timeoutMs = 100.5 },
    (p: ReturnType<typeof receivePlan>) => { p.tasks[5]!.next = 'intake' },
    (p: ReturnType<typeof receivePlan>) => { p.tasks[1]!.onFailure = 'depart' },
    (p: ReturnType<typeof receivePlan>) => { p.tasks[3]!.timeoutMs = 60000; p.tasks[5]!.timeoutMs = 60000; p.power.availableWh = 20 },
  ]) {
    const input = receivePlan(); change(input)
    expect(() => validateVehicleMission(input)).toThrow()
  }
  const alternateBudget = receivePlan()
  alternateBudget.tasks[3]!.timeoutMs = 1000; alternateBudget.tasks[4]!.timeoutMs = 30000; alternateBudget.tasks[5]!.timeoutMs = 30000
  expect(validateVehicleMission(alternateBudget).worstCaseMs).toBe(120020)
})

test('missing or nonfinite ACK coordinates cannot confirm receipt or create an unreplayable accepted trace', () => {
  for (const position of [Array<number>(3), [3, , -.1], [NaN, 2, -.1], [3, 2, Infinity]]) {
    const engine = createVehicleMissionEngine(receivePlan()), pending = engine.step(observation(600), 'start').payload!
    const ack = { eventId: pending.eventId, taskId: pending.taskId, operation: pending.operation, containerId: pending.containerId, reference: pending.reference, positionM: position as [number, number, number], capturedAtMs: 620, outcome: 'confirmed' as const }
    expect(() => engine.step({ ...observation(620), payloadAck: ack })).toThrow('Invalid vehicle mission observation')
    expect(engine.snapshot().state).toBe('blocked')
    expect(engine.snapshot().taskId).toBe('intake')
    expect(engine.snapshot().payload).toBeNull()
    expect(engine.snapshot().reason).not.toBe('payload-confirmed')
    expect(() => parseVehicleMissionTrace(JSON.stringify(engine.trace()))).not.toThrow()
  }
})
