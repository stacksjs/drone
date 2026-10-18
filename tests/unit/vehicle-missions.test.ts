import { expect, test } from 'bun:test'
import type { VehicleMissionObservation, VehicleMissionPlan } from '../../resources/functions/drone/vehicles/types'
import { createVehicleMissionEngine, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'
function plan(): VehicleMissionPlan {
  return { version: 2, vehicle: 'ground', id: 'ground-route', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 20, minDownM: -0.5, maxDownM: 0.5 }, rallyM: [0, 0, 0], power: { availableWh: 10, maxW: 100, reservePercent: 30 }, start: 'begin', tasks: [{ id: 'begin', kind: 'start', next: 'drive' }, { id: 'drive', kind: 'waypoint', positionM: [2, 0, 0], acceptanceM: 0.2, maxArrivalSpeedMps: 0.2, settleMs: 100, timeoutMs: 10000, next: 'park' }, { id: 'park', kind: 'stop', positionM: [2, 0, 0], acceptanceM: 0.2, maxArrivalSpeedMps: 0.1, settleMs: 100, timeoutMs: 3000 }] }
}
function observation(nowMs: number): VehicleMissionObservation { return { kind: 'simulation', nowMs, reference: '55:0,0,0,0,0', origin: plan().origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true, payloadAck: null } }
test('vehicle missions require explicit operator start and emit the full profile goal', () => {
  const input = plan()
  expect(validateVehicleMission(input).worstCaseMs).toBe(13020)
  const engine = createVehicleMissionEngine(input)
  input.tasks.length = 0
  expect(engine.step(observation(1000)).state).toBe('ready')
  const started = engine.step(observation(1020), 'start')
  expect(started.taskId).toBe('drive')
  expect(started.targetM).toEqual([2, 0, 0])
  expect(engine.step(observation(1040)).targetM).toEqual([2, 0, 0])
  expect(engine.snapshot().physicalFlightEnabled).toBe(false)
})

import { parseVehicleMissionTrace, recoverVehicleMission, replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'
function arrive(engine: ReturnType<typeof createVehicleMissionEngine>, untilMs = 1120) {
  engine.step(observation(1000), 'start')
  for (let at = 1020; at <= untilMs; at += 20) engine.step({ ...observation(at), positionM: [2, 0, 0] })
}
test('profile arrival speed, settling and measured surface contact gate terminal completion and replay', () => {
  const engine = createVehicleMissionEngine(plan())
  engine.step(observation(1000), 'start')
  for (let at = 1020; at <= 1120; at += 20) expect(engine.step({ ...observation(at), positionM: [2, 0, 0], velocityMps: [0.3, 0, 0] }).taskId).toBe('drive')
  for (let at = 1140; at <= 1220; at += 20) engine.step({ ...observation(at), positionM: [2, 0, 0] })
  expect(engine.snapshot().taskId).toBe('park')
  for (let at = 1240; at <= 1340; at += 20) expect(engine.step({ ...observation(at), positionM: [2, 0, 0], onGround: false }).state).toBe('running')
  for (let at = 1360; at <= 1440; at += 20) engine.step({ ...observation(at), positionM: [2, 0, 0] })
  expect(engine.snapshot().state).toBe('completed')
  expect(engine.snapshot().targetM).toBeNull()
  const trace = engine.trace()
  expect(replayVehicleMission(trace).snapshot()).toEqual(engine.snapshot())
  expect(parseVehicleMissionTrace(JSON.stringify(trace))).toEqual(trace)
  trace.rows[1]!.result.targetM![0] += 1
  expect(() => replayVehicleMission(trace)).toThrow('mismatch')
})
test('vehicle graph validation rejects cycles, orphan nodes, unsupported variants and insufficient reserve', () => {
  for (const mutate of [
    (p: VehicleMissionPlan) => { p.tasks[1]!.id = 'begin' },
    (p: VehicleMissionPlan) => { p.tasks.push({ id: 'orphan', kind: 'abort' }) },
    (p: VehicleMissionPlan) => { (p.tasks[1] as { next: string }).next = 'begin' },
    (p: VehicleMissionPlan) => { (p as { vehicle: string }).vehicle = 'vtol' },
    (p: VehicleMissionPlan) => { (p.tasks[1] as { positionM: number[] }).positionM = [30, 0, 0] },
    (p: VehicleMissionPlan) => { p.power.availableWh = 0.01 },
    (p: VehicleMissionPlan) => { delete (p.tasks[1] as { timeoutMs?: number }).timeoutMs },
  ]) { const input = plan(); mutate(input); expect(() => validateVehicleMission(input)).toThrow() }
  const engine = createVehicleMissionEngine(plan())
  engine.step(observation(1000), 'start')
  for (let at = 1020; at <= 11000; at += 20) engine.step(observation(at))
  expect(engine.snapshot().reason).toBe('task-timeout')
})
function payloadEngine() {
  const input = plan()
  ;(input.tasks[1] as { next: string }).next = 'drop'
  input.tasks.splice(2, 0, { id: 'drop', kind: 'payload', operation: 'material-drop', containerId: 'tray-1', timeoutMs: 500, next: 'park' })
  const engine = createVehicleMissionEngine(input)
  arrive(engine, 1100)
  engine.step({ ...observation(1120), positionM: [2, 0, 0] })
  return engine
}
test('payload events retain one identity and require a fresh exact scoped acknowledgement', () => {
  const engine = payloadEngine(), command = engine.snapshot().payload!
  expect(command.eventId).toContain('ground-route:55:0,0,0,0,0:drop')
  engine.step({ ...observation(1140), positionM: [2, 0, 0] })
  expect(engine.snapshot().payload).toEqual(command)
  const ack = { eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: command.containerId, capturedAtMs: command.issuedAtMs, reference: command.reference, positionM: [...command.positionM] as [number, number, number], outcome: 'confirmed' as const }
  expect(engine.step({ ...observation(1160), positionM: [2, 0, 0], payloadAck: ack }).reason).toBe('payload-confirmed')
  expect(engine.snapshot().taskId).toBe('park')
  for (const change of [
    { eventId: 'another-event' }, { taskId: 'another-task' }, { operation: 'water-sample' as const }, { containerId: 'tray-2' },
    { reference: '56:0,0,0,0,0' }, { capturedAtMs: 999 }, { capturedAtMs: 2000 }, { positionM: [4, 0, 0] as [number, number, number] }, { outcome: 'uncertain' as const },
  ]) {
    const other = payloadEngine(), pending = other.snapshot().payload!
    const invalid = { eventId: pending.eventId, taskId: pending.taskId, operation: pending.operation, containerId: pending.containerId, capturedAtMs: pending.issuedAtMs, reference: pending.reference, positionM: pending.positionM, outcome: 'confirmed' as 'confirmed' | 'uncertain', ...change }
    expect(other.step({ ...observation(1140), positionM: [2, 0, 0], payloadAck: invalid }).reason).toBe('payload-outcome-uncertain')
    expect(other.snapshot().targetM).toBeNull()
  }
})
test('checkpoint recovery is paused and payload recovery or deadline never automatically retries an uncertain action', () => {
  const moving = createVehicleMissionEngine(plan())
  moving.step(observation(1000), 'start'); moving.step(observation(1020))
  const recovered = recoverVehicleMission(moving.trace(), observation(1100))
  expect(recovered.snapshot().state).toBe('paused')
  expect(recovered.step(observation(1120)).state).toBe('paused')
  expect(recovered.step(observation(1140), 'resume').state).toBe('running')
  const pending = payloadEngine()
  expect(() => recoverVehicleMission(pending.trace(), { ...observation(1140), positionM: [2, 0, 0] })).toThrow()
  for (let at = 1140; at <= 1640; at += 20) pending.step({ ...observation(at), positionM: [2, 0, 0] })
  expect(pending.snapshot().reason).toBe('payload-outcome-uncertain')
  expect(pending.step({ ...observation(1660), positionM: [2, 0, 0] }, 'resume').state).toBe('blocked')
})


test('uncloneable observations and oversized references release the active mission', () => {
  for (const change of [{ extra: () => true }, { reference: `55:${'0'.repeat(121)},0,0,0,0` }]) {
    const engine = createVehicleMissionEngine(plan())
    engine.step(observation(1000), 'start')
    expect(() => engine.step({ ...observation(1020), ...change })).toThrow()
    expect(engine.snapshot().state).toBe('blocked')
    expect(engine.snapshot().targetM).toBeNull()
    expect(engine.snapshot().payload).toBeNull()
  }
})
