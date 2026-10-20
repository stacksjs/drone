import { expect, test } from 'bun:test'
import type { TaskMotionMissionObservation } from '../../resources/functions/drone/missions/engine'
import * as policy from '../../resources/functions/drone/missions/engine'
import type { MissionAction, MissionSnapshot, TaskMotionMissionAction, TaskMotionMissionDeclaration, TaskMotionMissionSnapshot } from '../../resources/functions/drone/missions/engine'
import type { TaskMotionMissionPlan } from '../../resources/functions/drone/missions/plan'
import { parseOwnedMissionTrace } from '../../resources/functions/drone/missions/recording'
import { exampleMission, validateMission, validateReadinessMission, validateTaskMotionMission } from '../../resources/functions/drone/missions/plan'

function fixture() {
  return {
    version: 4, id: 'motion-demo', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE',
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.6,
    tasks: [
      { id: 'takeoff', kind: 'takeoff', speedMps: 0.1, positionM: [0, 0, -1], timeoutMs: 10000, next: 'stage' },
      { id: 'stage', kind: 'readiness-loiter', positionM: [0, 0, -1], durationMs: 1500, timeoutMs: 3000, sourceId: 'camera-ready', next: 'dolly' },
      { id: 'dolly', kind: 'waypoint', speedMps: 0.4, positionM: [1, 0, -1], timeoutMs: 12000, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 7000 },
    ],
  }
}
function observation(nowMs: number, positionM: TaskMotionMissionObservation['positionM'] = [0, 0, -1], onGround = false): TaskMotionMissionObservation {
  return { kind: 'simulation', nowMs, reference: '1:0,0,0,0,0', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, healthy: true, positionM, velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround }
}
function release(nowMs: number) { return { version: 1, planId: 'motion-demo', runStartedAtMs: 600, taskId: 'stage', taskEnteredAtMs: 1100, sourceId: 'camera-ready', reference: '1:0,0,0,0,0', observedAtMs: nowMs, ready: true } }
function near(actual: number, expected: number) { expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-12) }

test('a concrete native task-motion kernel is available', () => {
  expect(policy).toHaveProperty('createTaskMotionMissionEngine')
})

test('per-task target rates hold, release and replay on the same pure native policy', () => {
  const plan = validateTaskMotionMission(fixture()).plan
  expect(plan.tasks.map(t => 'speedMps' in t ? t.speedMps : null)).toEqual([0.1, 0.6, 0.4, 0.6])
  expect(Object.keys(plan.tasks[0]!)).toEqual(['id', 'kind', 'speedMps', 'positionM', 'timeoutMs', 'next'])
  const engine = policy.createTaskMotionMissionEngine(plan)
  expect(engine.step(observation(600, [0, 0, -0.1], true), 'start').targetM).toEqual([0, 0, -0.1])
  near(engine.step(observation(620)).targetM![2], -0.102)
  for (let at = 640; at <= 1100; at += 20) engine.step(observation(at))
  expect(engine.snapshot().taskId).toBe('stage')
  expect(engine.snapshot().taskEnteredAtMs).toBe(1100)
  near(engine.snapshot().targetM![2], -0.15)
  near(engine.step(observation(1120)).targetM![2], -0.162)
  for (let at = 1140; at < 2600; at += 20) engine.step(observation(at))
  expect(engine.snapshot().taskId).toBe('stage')
  expect(engine.step(observation(2600), undefined, release(2600)).taskId).toBe('dolly')
  expect(engine.snapshot().targetM).toEqual([0, 0, -1])
  near(engine.step(observation(2620)).targetM![0], 0.008)
  expect(policy.replayTaskMotionMission(engine.trace()).snapshot()).toEqual(engine.snapshot())
  expect(policy.parseTaskMotionMissionTrace(`${JSON.stringify(engine.trace())}\n`)).toEqual(engine.trace())
})

function matrixFixture(): TaskMotionMissionPlan {
  return validateTaskMotionMission({ version: 4, id: 'ready-demo', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.2, tasks: [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 10000, next: 'stage' }, { id: 'stage', kind: 'readiness-loiter', positionM: [0, 0, -1.2], durationMs: 1500, timeoutMs: 3000, sourceId: 'camera-ready', next: 'dolly' }, { id: 'dolly', kind: 'waypoint', positionM: [2, 0, -1.2], timeoutMs: 12000, next: 'return' }, { id: 'return', kind: 'return', timeoutMs: 12000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 7000 }] }).plan
}
function matrixObservation(nowMs: number, overrides: Partial<TaskMotionMissionObservation> = {}): TaskMotionMissionObservation { return { kind: 'simulation', nowMs, reference: '55:0,0,0,0,0', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, healthy: true, positionM: [0, 0, nowMs === 600 ? -0.1 : -1.2], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: nowMs === 600, ...overrides } }
function matrixStaged(until = 2600) {
  const engine = policy.createTaskMotionMissionEngine(matrixFixture())
  engine.step(matrixObservation(600), 'start')
  for (let n = 620; n <= until; n += 20) engine.step(matrixObservation(n))
  return engine
}
function matrixRelease(engine: policy.TaskMotionMissionEngine, nowMs: number): TaskMotionMissionDeclaration { const s = engine.snapshot(); return { version: 1, planId: 'ready-demo', runStartedAtMs: s.runStartedAtMs!, taskId: s.taskId, taskEnteredAtMs: s.taskEnteredAtMs!, sourceId: 'camera-ready', reference: '55:0,0,0,0,0', observedAtMs: nowMs, ready: true } }
function caught(fn: () => unknown): unknown { try { fn() } catch (error) { return error }; throw new Error('Expected refusal') }

test('early truth is not latched, false/missing withhold, native reach loss resets dwell', () => {
  const exact = matrixStaged(2560)
  expect(exact.step(matrixObservation(2580), undefined, matrixRelease(exact, 2580)).taskId).toBe('stage')
  expect(exact.step(matrixObservation(2600), undefined, matrixRelease(exact, 2600)).taskId).toBe('dolly')
  const e = matrixStaged(1100)
  e.step(matrixObservation(1120), undefined, matrixRelease(e, 1120))
  for (let n = 1140; n <= 2600; n += 20) e.step(matrixObservation(n))
  expect(e.snapshot().taskId).toBe('stage')
  e.step(matrixObservation(2620), undefined, { ...matrixRelease(e, 2620), ready: false })
  expect(e.snapshot().taskId).toBe('stage')
  e.step(matrixObservation(2640), undefined, matrixRelease(e, 2640))
  expect(e.snapshot().taskId).toBe('dolly')
  const reset = matrixStaged(2480)
  reset.step(matrixObservation(2500, { positionM: [1, 0, -1.2] }))
  for (let n = 2520; n <= 2600; n += 20) reset.step(matrixObservation(n), undefined, matrixRelease(reset, n))
  expect(reset.snapshot().taskId).toBe('stage')
  expect(policy.replayTaskMotionMission(reset.trace()).snapshot()).toEqual(reset.snapshot())
})

test('every bounded binding mismatch is retained, refuses only that step, and does not steal the edge', () => {
  const variants = [{ planId: 'other' }, { runStartedAtMs: 601 }, { taskId: 'dolly' }, { taskEnteredAtMs: 1101 }, { sourceId: 'foreign' }, { reference: '56:0,0,0,0,0' }, { observedAtMs: 2619 }, { observedAtMs: 2621 }]
  for (const variant of variants) {
    const e = matrixStaged(), foreign = { ...matrixRelease(e, 2620), ...variant }
    expect(e.step(matrixObservation(2620), undefined, foreign).taskId).toBe('stage')
    expect(e.trace().rows.at(-1)!.readiness).toEqual(foreign)
    expect(e.step(matrixObservation(2640), undefined, matrixRelease(e, 2640)).taskId).toBe('dolly')
    expect(e.snapshot().taskEnteredAtMs).toBe(2640)
    expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
  }
})

test('canonical invalid readiness blocks only the live gated task and remains replayable', () => {
  let reads = 0
  const proxy = new Proxy({}, { ownKeys() { reads++; throw new Error('private') }, getPrototypeOf() { reads++; throw new Error('private') } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const getter = Object.defineProperty({}, 'ready', { enumerable: true, get() { reads++; return true } })
  for (const bad of [proxy, revoked.proxy, getter, [], true, 'private', {}, { extra: true }, { ready: true }, 'invalid']) {
    const e = matrixStaged()
    const s = e.step(matrixObservation(2620), undefined, bad)
    expect(s.state).toBe('blocked')
    expect(s.reason).toBe('invalid-readiness-release')
    expect(s.targetM).toBeNull()
    expect(e.trace().rows.at(-1)!.readiness).toBe('invalid')
    e.step(matrixObservation(2640), undefined, proxy)
    expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
  }
  expect(reads).toBe(0)
  const e = policy.createTaskMotionMissionEngine(matrixFixture())
  expect(e.step(matrixObservation(580, { positionM: [0, 0, -0.1], onGround: true }), undefined, proxy).state).toBe('ready')
  expect(e.step(matrixObservation(600), 'start', proxy).state).toBe('running')
  expect(e.snapshot().reason).toBe('operator-start')
  expect(e.step(matrixObservation(620), 'abort', proxy).reason).toBe('operator-abort')
  expect(e.step(matrixObservation(640), 'start', proxy).state).toBe('aborted')
  expect(e.snapshot().runStartedAtMs).toBe(600)
  expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
  expect(reads).toBe(0)
})

test('native safety and explicit abort beat release or malformed readiness, timeout wins its exact tie', () => {
  const cases: [Partial<TaskMotionMissionObservation>, policy.TaskMotionMissionReason][] = [[{ reference: '56:0,0,0,0,0' }, 'estimator-reference-changed'], [{ healthy: false }, 'estimator-loss'], [{ positionM: [13, 0, -1.2] }, 'mission-fence-breach'], [{ authority: 'manual' }, 'authority-revoked'], [{ batteryPercent: 30 }, 'mission-battery-reserve']]
  for (const readiness of ['selected', 'invalid'] as const) for (const [overrides, reason] of cases) {
    const e = matrixStaged(), packet = readiness === 'selected' ? matrixRelease(e, 2620) : 'invalid'
    expect(e.step(matrixObservation(2620, overrides), 'abort', packet).reason).toBe(reason)
    expect(e.snapshot().targetM).toBeNull()
    expect(e.snapshot().taskId).toBe('stage')
    expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
  }
  const gap = matrixStaged()
  expect(gap.step(matrixObservation(2660), 'abort', matrixRelease(gap, 2660)).reason).toBe('mission-schedule-gap')
  const aborted = matrixStaged()
  expect(aborted.step(matrixObservation(2620), 'abort', matrixRelease(aborted, 2620)).reason).toBe('operator-abort')
  for (const ready of ['selected', 'invalid'] as const) {
    const e = matrixStaged(4080)
    const s = e.step(matrixObservation(4100), undefined, ready === 'selected' ? matrixRelease(e, 4100) : 'invalid')
    expect(s.reason).toBe('task-timeout')
    expect(s.taskId).toBe('stage')
    expect(s.taskEnteredAtMs).toBe(1100)
  }
})

test('ordinary, branch and payload edges expose true native epochs; repeated start cannot reset timers', () => {
  const p = matrixFixture(), takeoff = p.tasks[0]!
  if (takeoff.kind !== 'takeoff') throw new Error('fixture')
  takeoff.timeoutMs = 9960; takeoff.next = 'branch'
  p.tasks.push({ id: 'branch', kind: 'branch', batteryAtLeast: 80, then: 'photo', otherwise: 'photo' }, { id: 'photo', kind: 'payload', channel: 'camera-still', next: 'stage' })
  const e = policy.createTaskMotionMissionEngine(p)
  expect(e.snapshot().runStartedAtMs).toBeNull()
  expect(e.snapshot().taskEnteredAtMs).toBeNull()
  e.step(matrixObservation(600), 'start')
  for (let n = 620; n <= 1100; n += 20) e.step(matrixObservation(n), 'start')
  expect(e.snapshot().taskId).toBe('branch')
  expect(e.snapshot().taskEnteredAtMs).toBe(1100)
  expect(e.step(matrixObservation(1120)).taskEnteredAtMs).toBe(1120)
  expect(e.snapshot().taskId).toBe('photo')
  const edge = e.step(matrixObservation(1140))
  expect(edge.taskId).toBe('stage')
  expect(edge.taskEnteredAtMs).toBe(1140)
  expect(edge.payload).toEqual({ taskId: 'photo', channel: 'camera-still' })
  for (let n = 1160; n <= 4120; n += 20) e.step(matrixObservation(n), 'start')
  expect(e.step(matrixObservation(4140), 'start', { ...matrixRelease(e, 4140), planId: p.id }).reason).toBe('task-timeout')
  expect(e.snapshot().runStartedAtMs).toBe(600)
  expect(e.snapshot().taskEnteredAtMs).toBe(1140)
  expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
})

test('LIVE projects any own-data key order, REPLAY rejects noncanonical order and malformed historical inputs', () => {
  const p = matrixFixture(), reversed = Object.fromEntries(Object.entries(p).reverse())
  const e = policy.createTaskMotionMissionEngine(reversed)
  const live = Object.fromEntries(Object.entries(matrixObservation(600)).reverse())
  Reflect.apply(e.step, undefined, [live, 'start'])
  expect(Object.keys(e.trace().plan)).toEqual(['version', 'id', 'frame', 'altitude', 'terrain', 'origin', 'fence', 'rallyM', 'power', 'start', 'speedMps', 'tasks'])
  expect(Object.keys(e.trace().rows[0]!.observation)).toEqual(Object.keys(matrixObservation(600)))
  expect(Object.keys(e.snapshot())).toEqual(['version', 'evidence', 'physicalFlightEnabled', 'state', 'taskId', 'targetM', 'payload', 'reason', 'elapsedMs', 'runStartedAtMs', 'taskEnteredAtMs'])
  expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
  const defaulted = { ...matrixFixture() }; Reflect.deleteProperty(defaulted, 'speedMps')
  expect(validateTaskMotionMission(defaulted).plan.speedMps).toBe(0.6)
  const trace = e.trace()
  expect(() => policy.replayTaskMotionMission(Object.fromEntries(Object.entries(trace).reverse()))).toThrow('Invalid task-motion mission trace')
  const order = e.trace(); Reflect.set(order.rows[0]!, 'observation', Object.fromEntries(Object.entries(order.rows[0]!.observation).reverse()))
  expect(() => policy.replayTaskMotionMission(order)).toThrow('Invalid task-motion mission trace')
  const wire = e.trace(); Reflect.set(wire.rows[0]!, 'readiness', { ready: true })
  expect(() => policy.replayTaskMotionMission(wire)).toThrow('Invalid task-motion mission trace')
  let calls = 0
  expect(() => Reflect.apply(policy.parseTaskMotionMissionTrace, undefined, [{ toString() { calls++; return '{}' } }])).toThrow('Invalid task-motion mission trace')
  expect(calls).toBe(0)
  expect(() => parseOwnedMissionTrace(JSON.stringify(e.trace()))).toThrow('Unsupported mission trace version')
  expect(() => validateMission(matrixFixture())).toThrow('unsupported mission semantics')
})

test('replay detects inconsistent decisions but does not authenticate consistently edited refusals', () => {
  const e = matrixStaged()
  e.step(matrixObservation(2620), undefined, { ...matrixRelease(e, 2620), observedAtMs: 2619 })
  const edited = e.trace()
  const row = edited.rows.at(-1)!
  const packet = row.readiness
  if (!packet || packet === 'invalid') throw new Error('fixture')
  packet.observedAtMs = 2618
  expect(policy.replayTaskMotionMission(edited).snapshot()).toEqual(e.snapshot())
  const wrong = e.trace(); wrong.rows.at(-1)!.result.taskEnteredAtMs = 1
  expect(() => policy.replayTaskMotionMission(wrong)).toThrow('Task-motion mission trace decision mismatch')
  for (const action of ['pause', 'resume', 'recover']) {
    const trace = e.trace(); Reflect.set(trace.rows.at(-1)!, 'action', action)
    expect(() => policy.replayTaskMotionMission(trace)).toThrow('Invalid task-motion mission trace')
  }
})

test('unrecorded invalid observation or action permanently poisons without committing clocks, visits or rows', () => {
  for (const mode of ['empty', 'clock', 'pause', 'resume', 'recover'] as const) {
    const e = mode === 'empty' ? policy.createTaskMotionMissionEngine(matrixFixture()) : matrixStaged()
    const before = e.snapshot(), prefix = e.trace()
    const error = caught(() => Reflect.apply(e.step, undefined, mode === 'empty' ? [null] : mode === 'clock' ? [matrixObservation(2600)] : [matrixObservation(2620), mode]))
    expect(error).toBeInstanceOf(TypeError)
    expect(error).toEqual(new TypeError('Invalid task-motion mission observation or action'))
    expect(e.trace()).toEqual(prefix)
    expect(e.snapshot()).toEqual({ ...before, state: 'blocked', reason: 'invalid-observation-or-clock', targetM: null, payload: null })
    expect(policy.replayTaskMotionMission(prefix).snapshot()).toEqual(before)
    let reads = 0
    const late = new Proxy({}, { ownKeys() { reads++; throw new Error('private') }, getPrototypeOf() { reads++; throw new Error('private') } })
    expect(caught(() => Reflect.apply(e.step, undefined, [late]))).toBe(error)
    expect(caught(() => e.step(matrixObservation(2640)))).toBe(error)
    expect(e.trace()).toEqual(prefix)
    expect(reads).toBe(0)
  }
})

test('count capacity poisons before next input inspection; exact8MiB parser budget is independent', () => {
  const e = policy.createTaskMotionMissionEngine(matrixFixture())
  e.step(matrixObservation(600), 'start'); e.step(matrixObservation(620), 'abort')
  for (let n = 621; n <= 6619; n++) e.step(matrixObservation(n))
  expect(e.trace().rows).toHaveLength(6001)
  const before = e.snapshot(), prefix = e.trace()
  let reads = 0
  const late = new Proxy({}, { getPrototypeOf() { reads++; throw new Error('private') } })
  const error = caught(() => Reflect.apply(e.step, undefined, [late]))
  expect(error).toEqual(new RangeError('Task-motion mission trace capacity exhausted'))
  expect(e.snapshot()).toEqual({ ...before, state: 'blocked', reason: 'mission-trace-capacity', targetM: null, payload: null })
  expect(e.trace()).toEqual(prefix)
  expect(caught(() => e.step(matrixObservation(6620)))).toBe(error)
  expect(policy.replayTaskMotionMission(prefix).snapshot()).toEqual(before)
  expect(reads).toBe(0)
  const small = JSON.stringify(policy.createTaskMotionMissionEngine(matrixFixture()).trace())
  const exact = small + ' '.repeat(8388608 - Buffer.byteLength(small))
  expect(policy.parseTaskMotionMissionTrace(exact).rows).toHaveLength(0)
  expect(() => policy.parseTaskMotionMissionTrace(exact + ' ')).toThrow(new RangeError('Task-motion mission trace exceeds 8 MiB'))
  expect(Buffer.byteLength(JSON.stringify(prefix) + '\n')).toBeLessThanOrEqual(8388608)
  expect(prefix.rows.every(r => Buffer.byteLength(JSON.stringify(r)) <= 2048)).toBe(true)
}, 70000)

test('strict plan and observation boundaries reject descriptors and out-of-domain values without caller echoes', () => {
  let reads = 0
  const proxy = new Proxy({}, { ownKeys() { reads++; throw new Error('private') } }), revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const input of [proxy, revoked.proxy, null, [], Object.create(null), { ...matrixFixture(), extra: true }, { ...matrixFixture(), speedMps: undefined }, { ...matrixFixture(), tasks: [] }, Object.defineProperty({}, 'version', { enumerable: true, get() { reads++; return 4 } })]) expect(() => validateTaskMotionMission(input)).toThrow(new TypeError('Invalid task-motion mission plan'))
  const low = matrixFixture(); low.power.availableWh = 0.01
  expect(() => validateTaskMotionMission(low)).toThrow('Task-motion mission endurance budget cannot preserve reserve')
  const changed = matrixFixture(), gate = changed.tasks.find(t => t.kind === 'readiness-loiter')!
  Reflect.set(gate, 'timeoutMs', 3001)
  expect(() => validateTaskMotionMission(changed)).toThrow('Invalid task-motion mission plan')
  const e = policy.createTaskMotionMissionEngine(matrixFixture())
  expect(caught(() => Reflect.apply(e.step, undefined, [revoked.proxy]))).toEqual(new TypeError('Invalid task-motion mission observation or action'))
  expect(reads).toBe(0)
})

if (false) {
  const legacy: MissionSnapshot = policy.createMissionEngine({}).snapshot()
  const next: TaskMotionMissionSnapshot = policy.createTaskMotionMissionEngine({}).snapshot()
  const oldPause: MissionAction = 'pause'
  const abort: TaskMotionMissionAction = 'abort'
  // @ts-expect-error New profile has no pause/recovery timer suspension.
  const pause: TaskMotionMissionAction = 'pause'
  // @ts-expect-error Concrete native versions remain disjoint.
  const incompatible: MissionSnapshot = next
  // @ts-expect-error No public generic engine/provider surface.
  policy.createTaskMotionMissionEngine<string>({})
  void legacy; void next; void oldPause; void abort; void pause; void incompatible
}

test('closed declaration and observation domains preserve exact boundary values before refusing overflow', () => {
  const e = matrixStaged(), longId = 'a'.repeat(40), ref = '9'.repeat(20) + ':' + ['9'.repeat(19), '9'.repeat(19), '9'.repeat(19), '9'.repeat(19), '9'.repeat(19)].join(',')
  expect(ref.length).toBe(120)
  const bounded = { ...matrixRelease(e, 2620), planId: longId, taskId: longId, sourceId: longId, reference: ref, observedAtMs: 45000 }
  expect(e.step(matrixObservation(2620), undefined, bounded).taskId).toBe('stage')
  expect(e.trace().rows.at(-1)!.readiness).toEqual(bounded)
  expect(e.step(matrixObservation(2640, { velocityMps: [1e6, 0, 0] }), undefined, matrixRelease(e, 2640)).taskId).toBe('stage')
  const prefix = e.trace()
  expect(caught(() => e.step(matrixObservation(2660, { velocityMps: [1e6 + 1, 0, 0] })))).toEqual(new TypeError('Invalid task-motion mission observation or action'))
  expect(e.trace()).toEqual(prefix)
  for (const bad of [{ ...bounded, sourceId: longId + 'a' }, { ...bounded, reference: ref + '9' }, { ...bounded, observedAtMs: 45001 }, { ...bounded, ready: 'true' }, { ...bounded, sourceId: 'é' }]) {
    const next = matrixStaged()
    expect(next.step(matrixObservation(2620), undefined, bad).reason).toBe('invalid-readiness-release')
    expect(next.trace().rows.at(-1)!.readiness).toBe('invalid')
  }
  expect(policy.replayTaskMotionMission(prefix).snapshot().taskId).toBe('stage')
})


test('task rates remain disjoint from old raw validators and public versions', () => {
  const raw = fixture()
  expect(() => validateReadinessMission({ ...raw, version: 3 })).toThrow('Invalid readiness mission plan')
  expect(() => validateMission({ ...raw, version: 1 })).toThrow()
  const old = matrixFixture(); const withoutRates = old.tasks.map(t => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'speedMps')))
  expect(validateReadinessMission({ ...old, version: 3, tasks: withoutRates }).plan.version).toBe(3)
})

test('non-axis component travel and short remaining distance use independent fixed mathematical bounds', () => {
  const raw = fixture()
  raw.tasks[2] = { id: 'dolly', kind: 'waypoint', speedMps: 0.5, positionM: [0.3, 0.4, -1], timeoutMs: 12000, next: 'land' }
  const e = policy.createTaskMotionMissionEngine(raw)
  e.step(observation(600, [0, 0, -0.1], true), 'start')
  for (let n = 620; n < 2600; n += 20) e.step(observation(n))
  e.step(observation(2600), undefined, release(2600))
  const first = e.step(observation(2620)).targetM!
  near(first[0], 0.006); near(first[1], 0.008); near(first[2], -1)
  near(Math.hypot(first[0], first[1]), 0.01)
  for (let n = 2640; n <= 3620; n += 20) {
    const before = e.snapshot().targetM!, target = e.step(observation(n)).targetM!
    expect(Math.hypot(target[0] - before[0], target[1] - before[1])).toBeLessThanOrEqual(0.01 + 1e-12)
    expect(target[0]).toBeLessThanOrEqual(0.3 + 1e-12)
    expect(target[1]).toBeLessThanOrEqual(0.4 + 1e-12)
  }
  near(e.snapshot().targetM![0], 0.3); near(e.snapshot().targetM![1], 0.4)
  expect(e.snapshot().taskId).toBe('dolly')
  expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
})

test('return and land use their owned rate on the step after native advance', () => {
  const p = matrixFixture()
  for (const t of p.tasks) if ('speedMps' in t) t.speedMps = t.kind === 'waypoint' ? 0.1 : t.kind === 'return' ? 0.3 : t.kind === 'land' ? 0.5 : 0.6
  const e = policy.createTaskMotionMissionEngine(p)
  e.step(matrixObservation(600), 'start')
  for (let n = 620; n < 2600; n += 20) e.step(matrixObservation(n))
  e.step(matrixObservation(2600), undefined, matrixRelease(e, 2600))
  for (let n = 2620; n <= 3100; n += 20) e.step(matrixObservation(n, { positionM: [2, 0, -1.2] }))
  expect(e.snapshot().taskId).toBe('return'); expect(e.snapshot().taskEnteredAtMs).toBe(3100)
  near(e.snapshot().targetM![0], 0.05)
  near(e.step(matrixObservation(3120)).targetM![0], 0.044)
  for (let n = 3140; n <= 3600; n += 20) e.step(matrixObservation(n))
  expect(e.snapshot().taskId).toBe('land'); expect(e.snapshot().taskEnteredAtMs).toBe(3600)
  near(e.step(matrixObservation(3620)).targetM![2], -1.19)
  expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(e.snapshot())
})

test('rate capture resolves omission once, rejects nonspatial or malformed rates and preserves exact task schemas', () => {
  const raw = fixture(); Reflect.deleteProperty(raw, 'speedMps')
  const canonical = validateTaskMotionMission(raw).plan
  expect(canonical.speedMps).toBe(0.6)
  expect(canonical.tasks[1]).toEqual({ id: 'stage', kind: 'readiness-loiter', speedMps: 0.6, positionM: [0, 0, -1], durationMs: 1500, timeoutMs: 3000, sourceId: 'camera-ready', next: 'dolly' })
  for (const rate of [undefined, null, 0.049, 0.601, NaN, Infinity, '0.2']) {
    const p = fixture(); Reflect.set(p.tasks[0]!, 'speedMps', rate)
    expect(() => validateTaskMotionMission(p)).toThrow(new TypeError('Invalid task-motion mission plan'))
  }
  for (const rate of [0.05, 0.6]) { const p = fixture(); p.tasks[0]!.speedMps = rate; expect(validateTaskMotionMission(p).plan.tasks[0]).toHaveProperty('speedMps', rate) }
  for (const task of [{ id: 'extra', kind: 'abort', speedMps: 0.2 }, { id: 'extra', kind: 'payload', channel: 'camera-still', speedMps: 0.2, next: 'stage' }, { id: 'extra', kind: 'branch', batteryAtLeast: 80, then: 'stage', otherwise: 'stage', speedMps: 0.2 }]) {
    const p = fixture(); Reflect.set(p.tasks[0]!, 'next', 'extra'); Reflect.set(p.tasks, String(p.tasks.length), task)
    expect(() => validateTaskMotionMission(p)).toThrow('Invalid task-motion mission plan')
  }
  const p = matrixFixture(), back = p.tasks.find(t => t.kind === 'return')!
  expect(Object.keys(back)).toEqual(['id', 'kind', 'speedMps', 'timeoutMs', 'next'])
  Reflect.set(back, 'positionM', [0, 0, -1.2])
  expect(() => validateTaskMotionMission(p)).toThrow('Invalid task-motion mission plan')
})

test('replay requires resolved canonical rates and detects active unsaturated edits without inventing signatures', () => {
  const e = policy.createTaskMotionMissionEngine(fixture())
  e.step(observation(600, [0, 0, -0.1], true), 'start'); e.step(observation(620))
  const active = e.trace(); Reflect.set(active.plan.tasks[0]!, 'speedMps', 0.2)
  expect(() => policy.replayTaskMotionMission(active)).toThrow('Task-motion mission trace decision mismatch')
  const absent = e.trace(); Reflect.deleteProperty(absent.plan.tasks[0]!, 'speedMps')
  expect(() => policy.replayTaskMotionMission(absent)).toThrow('Invalid task-motion mission trace')
  const reordered = e.trace(); Reflect.set(reordered.plan.tasks, '0', Object.fromEntries(Object.entries(reordered.plan.tasks[0]!).reverse()))
  expect(() => policy.replayTaskMotionMission(reordered)).toThrow('Invalid task-motion mission trace')
  const unused = e.trace(); unused.plan.speedMps = 0.3; Reflect.set(unused.plan.tasks[2]!, 'speedMps', 0.3)
  expect(policy.replayTaskMotionMission(unused).snapshot()).toEqual(e.snapshot())
  for (const changes of [{ version: 3 }, { evidence: 'owned-readiness-mission-simulation' }]) expect(() => policy.replayTaskMotionMission({ ...e.trace(), ...changes })).toThrow('Invalid task-motion mission trace')
})

if (false) {
  const plan = validateTaskMotionMission({}).plan
  const next = policy.createTaskMotionMissionEngine(plan).snapshot()
  // @ts-expect-error Versions are intentionally disjoint.
  const old: policy.ReadinessMissionSnapshot = next
  // @ts-expect-error Canonical spatial tasks require resolved rates.
  const task: import('../../resources/functions/drone/missions/plan').TaskMotionMissionTask = { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 1000 }
  void old; void task
}

test('owned rate capture cannot be replaced by later caller mutations; bounded descriptors never invoke getters', () => {
  const p = fixture(), e = policy.createTaskMotionMissionEngine(p)
  p.tasks[0]!.speedMps = 0.6
  e.step(observation(600, [0, 0, -0.1], true), 'start')
  near(e.step(observation(620)).targetM![2], -0.102)
  let reads = 0
  const accessor = fixture()
  Object.defineProperty(accessor.tasks[0]!, 'speedMps', { enumerable: true, get() { reads++; return 0.1 } })
  expect(() => validateTaskMotionMission(accessor)).toThrow('Invalid task-motion mission plan')
  const hidden = fixture(); Object.defineProperty(hidden.tasks[0]!, 'speedMps', { value: 0.1, enumerable: false })
  expect(() => validateTaskMotionMission(hidden)).toThrow('Invalid task-motion mission plan')
  const hole = fixture(); Reflect.deleteProperty(hole.tasks, '1')
  expect(() => validateTaskMotionMission(hole)).toThrow('Invalid task-motion mission plan')
  expect(reads).toBe(0)
  for (const bad of [null, 'pause', 'resume', 'recover']) {
    const next = policy.createTaskMotionMissionEngine(fixture()), prefix = next.trace()
    const error = caught(() => Reflect.apply(next.step, undefined, [observation(600, [0, 0, -0.1], true), bad]))
    expect(error).toEqual(new TypeError('Invalid task-motion mission observation or action'))
    expect(next.trace()).toEqual(prefix)
    expect(caught(() => next.step(observation(620)))).toBe(error)
  }
  const next = policy.createTaskMotionMissionEngine(fixture()), prefix = next.trace()
  expect(caught(() => next.step({ ...observation(600), origin: { latitudeDeg: 1, longitudeDeg: 0, ellipsoidHeightM: 100 } }))).toEqual(new TypeError('Invalid task-motion mission observation or action'))
  expect(next.trace()).toEqual(prefix)
})

test('v1 retains hidden/inherited/accessor acceptance while v3/v4 rate inputs stay strict', () => {
  const ordinary = exampleMission()
  expect(validateMission(ordinary).plan.version).toBe(1)
  Reflect.set(ordinary.tasks[0]!, 'speedMps', 0.2)
  expect(() => validateMission(ordinary)).toThrow('Invalid mission plan or unsupported mission semantics')
  for (const method of ['hidden', 'inherited', 'accessor'] as const) {
    const p = exampleMission(), task = p.tasks[0]!
    let reads = 0
    if (method === 'hidden') Object.defineProperty(task, 'speedMps', { value: 0.2 })
    if (method === 'inherited') Object.setPrototypeOf(task, { speedMps: 0.2 })
    if (method === 'accessor') Object.defineProperty(task, 'timeoutMs', { enumerable: true, get() { reads++; return 12000 } })
    expect(validateMission(p).plan.version).toBe(1)
    if (method === 'accessor') expect(reads).toBeGreaterThan(0)
  }
  const fractional = fixture(); fractional.tasks[0]!.timeoutMs = 10000.5
  expect(validateTaskMotionMission(fractional).worstCaseMs).toBe(32000.5)
})

test('owned stage rate cannot extend native timeout; explicit abort wins that timeout equality', () => {
  for (const abort of [false, true]) {
    const p = matrixFixture(), stage = p.tasks.find(t => t.kind === 'readiness-loiter')!
    stage.speedMps = 0.05
    const e = policy.createTaskMotionMissionEngine(p)
    e.step(matrixObservation(600), 'start')
    for (let n = 620; n < 4100; n += 20) e.step(matrixObservation(n))
    const result = e.step(matrixObservation(4100), abort ? 'abort' : undefined, matrixRelease(e, 4100))
    expect(result.reason).toBe(abort ? 'operator-abort' : 'task-timeout')
    expect(result.taskEnteredAtMs).toBe(1100)
    expect(result.targetM).toBeNull()
    expect(policy.replayTaskMotionMission(e.trace()).snapshot()).toEqual(result)
  }
})
