import { expect, test } from 'bun:test'
import * as policy from '../../resources/functions/drone/missions/engine'
import type { ReadinessMissionPlan } from '../../resources/functions/drone/missions/plan'
import { validateMission, validateReadinessMission } from '../../resources/functions/drone/missions/plan'
import type { MissionAction, MissionSnapshot, ReadinessMissionAction, ReadinessMissionDeclaration, ReadinessMissionObservation, ReadinessMissionSnapshot } from '../../resources/functions/drone/missions/engine'
import { parseOwnedMissionTrace } from '../../resources/functions/drone/missions/recording'

// Public pure-policy seam: declared readiness can defer a native edge; this is not a flight.
test('readiness hold needs native dwell and a fresh selected declaration, with exact replay', () => {
  expect(policy.createReadinessMissionEngine).toBeFunction()
  const plan = { version: 3, id: 'ready-demo', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.2, tasks: [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 10000, next: 'stage' }, { id: 'stage', kind: 'readiness-loiter', positionM: [0, 0, -1.2], durationMs: 1500, timeoutMs: 3000, sourceId: 'camera-ready', next: 'dolly' }, { id: 'dolly', kind: 'waypoint', positionM: [2, 0, -1.2], timeoutMs: 12000, next: 'return' }, { id: 'return', kind: 'return', timeoutMs: 12000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 7000 }] }
  const engine = policy.createReadinessMissionEngine(plan)
  const observe = (nowMs: number) => ({ kind: 'simulation' as const, nowMs, reference: '55:0,0,0,0,0', origin: plan.origin, healthy: true, positionM: [0, 0, nowMs === 600 ? -0.1 : -1.2] as [number, number, number], velocityMps: [0, 0, 0] as [number, number, number], authority: 'autonomous' as const, batteryPercent: 100, onGround: nowMs === 600 })
  engine.step(observe(600), 'start')
  for (let n = 620; n <= 2800; n += 20) engine.step(observe(n))
  expect(engine.snapshot().taskId).toBe('stage')
  expect(engine.snapshot().taskEnteredAtMs).toBe(1100)
  expect(engine.snapshot().runStartedAtMs).toBe(600)
  const declaration = { version: 1, planId: 'ready-demo', runStartedAtMs: 600, taskId: 'stage', taskEnteredAtMs: 1100, sourceId: 'camera-ready', reference: '55:0,0,0,0,0', observedAtMs: 2820, ready: true }
  expect(engine.step(observe(2820), undefined, declaration).taskId).toBe('dolly')
  expect(engine.snapshot().taskEnteredAtMs).toBe(2820)
  expect(policy.replayReadinessMission(engine.trace()).snapshot()).toEqual(engine.snapshot())
  expect(policy.parseReadinessMissionTrace(JSON.stringify(engine.trace()))).toEqual(engine.trace())
})

function fixture(): ReadinessMissionPlan {
  return { version: 3, id: 'ready-demo', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.2, tasks: [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 10000, next: 'stage' }, { id: 'stage', kind: 'readiness-loiter', positionM: [0, 0, -1.2], durationMs: 1500, timeoutMs: 3000, sourceId: 'camera-ready', next: 'dolly' }, { id: 'dolly', kind: 'waypoint', positionM: [2, 0, -1.2], timeoutMs: 12000, next: 'return' }, { id: 'return', kind: 'return', timeoutMs: 12000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 7000 }] }
}
function observation(nowMs: number, overrides: Partial<ReadinessMissionObservation> = {}): ReadinessMissionObservation { return { kind: 'simulation', nowMs, reference: '55:0,0,0,0,0', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, healthy: true, positionM: [0, 0, nowMs === 600 ? -0.1 : -1.2], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: nowMs === 600, ...overrides } }
function staged(until = 2600) {
  const engine = policy.createReadinessMissionEngine(fixture())
  engine.step(observation(600), 'start')
  for (let n = 620; n <= until; n += 20) engine.step(observation(n))
  return engine
}
function release(engine: policy.ReadinessMissionEngine, nowMs: number): ReadinessMissionDeclaration { const s = engine.snapshot(); return { version: 1, planId: 'ready-demo', runStartedAtMs: s.runStartedAtMs!, taskId: s.taskId, taskEnteredAtMs: s.taskEnteredAtMs!, sourceId: 'camera-ready', reference: '55:0,0,0,0,0', observedAtMs: nowMs, ready: true } }
function caught(fn: () => unknown): unknown { try { fn() } catch (error) { return error }; throw new Error('Expected refusal') }

test('early truth is not latched, false/missing withhold, native reach loss resets dwell', () => {
  const exact = staged(2560)
  expect(exact.step(observation(2580), undefined, release(exact, 2580)).taskId).toBe('stage')
  expect(exact.step(observation(2600), undefined, release(exact, 2600)).taskId).toBe('dolly')
  const e = staged(1100)
  e.step(observation(1120), undefined, release(e, 1120))
  for (let n = 1140; n <= 2600; n += 20) e.step(observation(n))
  expect(e.snapshot().taskId).toBe('stage')
  e.step(observation(2620), undefined, { ...release(e, 2620), ready: false })
  expect(e.snapshot().taskId).toBe('stage')
  e.step(observation(2640), undefined, release(e, 2640))
  expect(e.snapshot().taskId).toBe('dolly')
  const reset = staged(2480)
  reset.step(observation(2500, { positionM: [1, 0, -1.2] }))
  for (let n = 2520; n <= 2600; n += 20) reset.step(observation(n), undefined, release(reset, n))
  expect(reset.snapshot().taskId).toBe('stage')
  expect(policy.replayReadinessMission(reset.trace()).snapshot()).toEqual(reset.snapshot())
})

test('every bounded binding mismatch is retained, refuses only that step, and does not steal the edge', () => {
  const variants = [{ planId: 'other' }, { runStartedAtMs: 601 }, { taskId: 'dolly' }, { taskEnteredAtMs: 1101 }, { sourceId: 'foreign' }, { reference: '56:0,0,0,0,0' }, { observedAtMs: 2619 }, { observedAtMs: 2621 }]
  for (const variant of variants) {
    const e = staged(), foreign = { ...release(e, 2620), ...variant }
    expect(e.step(observation(2620), undefined, foreign).taskId).toBe('stage')
    expect(e.trace().rows.at(-1)!.readiness).toEqual(foreign)
    expect(e.step(observation(2640), undefined, release(e, 2640)).taskId).toBe('dolly')
    expect(e.snapshot().taskEnteredAtMs).toBe(2640)
    expect(policy.replayReadinessMission(e.trace()).snapshot()).toEqual(e.snapshot())
  }
})

test('canonical invalid readiness blocks only the live gated task and remains replayable', () => {
  let reads = 0
  const proxy = new Proxy({}, { ownKeys() { reads++; throw new Error('private') }, getPrototypeOf() { reads++; throw new Error('private') } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const getter = Object.defineProperty({}, 'ready', { enumerable: true, get() { reads++; return true } })
  for (const bad of [proxy, revoked.proxy, getter, [], true, 'private', {}, { extra: true }, { ready: true }, 'invalid']) {
    const e = staged()
    const s = e.step(observation(2620), undefined, bad)
    expect(s.state).toBe('blocked')
    expect(s.reason).toBe('invalid-readiness-release')
    expect(s.targetM).toBeNull()
    expect(e.trace().rows.at(-1)!.readiness).toBe('invalid')
    e.step(observation(2640), undefined, proxy)
    expect(policy.replayReadinessMission(e.trace()).snapshot()).toEqual(e.snapshot())
  }
  expect(reads).toBe(0)
  const e = policy.createReadinessMissionEngine(fixture())
  expect(e.step(observation(580, { positionM: [0, 0, -0.1], onGround: true }), undefined, proxy).state).toBe('ready')
  expect(e.step(observation(600), 'start', proxy).state).toBe('running')
  expect(e.snapshot().reason).toBe('operator-start')
  expect(e.step(observation(620), 'abort', proxy).reason).toBe('operator-abort')
  expect(e.step(observation(640), 'start', proxy).state).toBe('aborted')
  expect(e.snapshot().runStartedAtMs).toBe(600)
  expect(policy.replayReadinessMission(e.trace()).snapshot()).toEqual(e.snapshot())
  expect(reads).toBe(0)
})

test('native safety and explicit abort beat release or malformed readiness, timeout wins its exact tie', () => {
  const cases: [Partial<ReadinessMissionObservation>, policy.ReadinessMissionReason][] = [[{ reference: '56:0,0,0,0,0' }, 'estimator-reference-changed'], [{ healthy: false }, 'estimator-loss'], [{ positionM: [13, 0, -1.2] }, 'mission-fence-breach'], [{ authority: 'manual' }, 'authority-revoked'], [{ batteryPercent: 30 }, 'mission-battery-reserve']]
  for (const readiness of ['selected', 'invalid'] as const) for (const [overrides, reason] of cases) {
    const e = staged(), packet = readiness === 'selected' ? release(e, 2620) : 'invalid'
    expect(e.step(observation(2620, overrides), 'abort', packet).reason).toBe(reason)
    expect(e.snapshot().targetM).toBeNull()
    expect(e.snapshot().taskId).toBe('stage')
    expect(policy.replayReadinessMission(e.trace()).snapshot()).toEqual(e.snapshot())
  }
  const gap = staged()
  expect(gap.step(observation(2660), 'abort', release(gap, 2660)).reason).toBe('mission-schedule-gap')
  const aborted = staged()
  expect(aborted.step(observation(2620), 'abort', release(aborted, 2620)).reason).toBe('operator-abort')
  for (const ready of ['selected', 'invalid'] as const) {
    const e = staged(4080)
    const s = e.step(observation(4100), undefined, ready === 'selected' ? release(e, 4100) : 'invalid')
    expect(s.reason).toBe('task-timeout')
    expect(s.taskId).toBe('stage')
    expect(s.taskEnteredAtMs).toBe(1100)
  }
})

test('ordinary, branch and payload edges expose true native epochs; repeated start cannot reset timers', () => {
  const p = fixture(), takeoff = p.tasks[0]!
  if (takeoff.kind !== 'takeoff') throw new Error('fixture')
  takeoff.timeoutMs = 9960; takeoff.next = 'branch'
  p.tasks.push({ id: 'branch', kind: 'branch', batteryAtLeast: 80, then: 'photo', otherwise: 'photo' }, { id: 'photo', kind: 'payload', channel: 'camera-still', next: 'stage' })
  const e = policy.createReadinessMissionEngine(p)
  expect(e.snapshot().runStartedAtMs).toBeNull()
  expect(e.snapshot().taskEnteredAtMs).toBeNull()
  e.step(observation(600), 'start')
  for (let n = 620; n <= 1100; n += 20) e.step(observation(n), 'start')
  expect(e.snapshot().taskId).toBe('branch')
  expect(e.snapshot().taskEnteredAtMs).toBe(1100)
  expect(e.step(observation(1120)).taskEnteredAtMs).toBe(1120)
  expect(e.snapshot().taskId).toBe('photo')
  const edge = e.step(observation(1140))
  expect(edge.taskId).toBe('stage')
  expect(edge.taskEnteredAtMs).toBe(1140)
  expect(edge.payload).toEqual({ taskId: 'photo', channel: 'camera-still' })
  for (let n = 1160; n <= 4120; n += 20) e.step(observation(n), 'start')
  expect(e.step(observation(4140), 'start', { ...release(e, 4140), planId: p.id }).reason).toBe('task-timeout')
  expect(e.snapshot().runStartedAtMs).toBe(600)
  expect(e.snapshot().taskEnteredAtMs).toBe(1140)
  expect(policy.replayReadinessMission(e.trace()).snapshot()).toEqual(e.snapshot())
})

test('LIVE projects any own-data key order, REPLAY rejects noncanonical order and malformed historical inputs', () => {
  const p = fixture(), reversed = Object.fromEntries(Object.entries(p).reverse())
  const e = policy.createReadinessMissionEngine(reversed)
  const live = Object.fromEntries(Object.entries(observation(600)).reverse())
  Reflect.apply(e.step, undefined, [live, 'start'])
  expect(Object.keys(e.trace().plan)).toEqual(['version', 'id', 'frame', 'altitude', 'terrain', 'origin', 'fence', 'rallyM', 'power', 'start', 'speedMps', 'tasks'])
  expect(Object.keys(e.trace().rows[0]!.observation)).toEqual(Object.keys(observation(600)))
  expect(Object.keys(e.snapshot())).toEqual(['version', 'evidence', 'physicalFlightEnabled', 'state', 'taskId', 'targetM', 'payload', 'reason', 'elapsedMs', 'runStartedAtMs', 'taskEnteredAtMs'])
  expect(policy.replayReadinessMission(e.trace()).snapshot()).toEqual(e.snapshot())
  const defaulted = { ...fixture() }; Reflect.deleteProperty(defaulted, 'speedMps')
  expect(validateReadinessMission(defaulted).plan.speedMps).toBe(0.6)
  const trace = e.trace()
  expect(() => policy.replayReadinessMission(Object.fromEntries(Object.entries(trace).reverse()))).toThrow('Invalid readiness mission trace')
  const order = e.trace(); Reflect.set(order.rows[0]!, 'observation', Object.fromEntries(Object.entries(order.rows[0]!.observation).reverse()))
  expect(() => policy.replayReadinessMission(order)).toThrow('Invalid readiness mission trace')
  const wire = e.trace(); Reflect.set(wire.rows[0]!, 'readiness', { ready: true })
  expect(() => policy.replayReadinessMission(wire)).toThrow('Invalid readiness mission trace')
  let calls = 0
  expect(() => Reflect.apply(policy.parseReadinessMissionTrace, undefined, [{ toString() { calls++; return '{}' } }])).toThrow('Invalid readiness mission trace')
  expect(calls).toBe(0)
  expect(() => parseOwnedMissionTrace(JSON.stringify(e.trace()))).toThrow('Unsupported mission trace version')
  expect(() => validateMission(fixture())).toThrow('unsupported mission semantics')
})

test('replay detects inconsistent decisions but does not authenticate consistently edited refusals', () => {
  const e = staged()
  e.step(observation(2620), undefined, { ...release(e, 2620), observedAtMs: 2619 })
  const edited = e.trace()
  const row = edited.rows.at(-1)!
  const packet = row.readiness
  if (!packet || packet === 'invalid') throw new Error('fixture')
  packet.observedAtMs = 2618
  expect(policy.replayReadinessMission(edited).snapshot()).toEqual(e.snapshot())
  const wrong = e.trace(); wrong.rows.at(-1)!.result.taskEnteredAtMs = 1
  expect(() => policy.replayReadinessMission(wrong)).toThrow('Readiness mission trace decision mismatch')
  for (const action of ['pause', 'resume', 'recover']) {
    const trace = e.trace(); Reflect.set(trace.rows.at(-1)!, 'action', action)
    expect(() => policy.replayReadinessMission(trace)).toThrow('Invalid readiness mission trace')
  }
})

test('unrecorded invalid observation or action permanently poisons without committing clocks, visits or rows', () => {
  for (const mode of ['empty', 'clock', 'pause', 'resume', 'recover'] as const) {
    const e = mode === 'empty' ? policy.createReadinessMissionEngine(fixture()) : staged()
    const before = e.snapshot(), prefix = e.trace()
    const error = caught(() => Reflect.apply(e.step, undefined, mode === 'empty' ? [null] : mode === 'clock' ? [observation(2600)] : [observation(2620), mode]))
    expect(error).toBeInstanceOf(TypeError)
    expect(error).toEqual(new TypeError('Invalid readiness mission observation or action'))
    expect(e.trace()).toEqual(prefix)
    expect(e.snapshot()).toEqual({ ...before, state: 'blocked', reason: 'invalid-observation-or-clock', targetM: null, payload: null })
    expect(policy.replayReadinessMission(prefix).snapshot()).toEqual(before)
    let reads = 0
    const late = new Proxy({}, { ownKeys() { reads++; throw new Error('private') }, getPrototypeOf() { reads++; throw new Error('private') } })
    expect(caught(() => Reflect.apply(e.step, undefined, [late]))).toBe(error)
    expect(caught(() => e.step(observation(2640)))).toBe(error)
    expect(e.trace()).toEqual(prefix)
    expect(reads).toBe(0)
  }
})

test('count capacity poisons before next input inspection; exact8MiB parser budget is independent', () => {
  const e = policy.createReadinessMissionEngine(fixture())
  e.step(observation(600), 'start'); e.step(observation(620), 'abort')
  for (let n = 621; n <= 6619; n++) e.step(observation(n))
  expect(e.trace().rows).toHaveLength(6001)
  const before = e.snapshot(), prefix = e.trace()
  let reads = 0
  const late = new Proxy({}, { getPrototypeOf() { reads++; throw new Error('private') } })
  const error = caught(() => Reflect.apply(e.step, undefined, [late]))
  expect(error).toEqual(new RangeError('Readiness mission trace capacity exhausted'))
  expect(e.snapshot()).toEqual({ ...before, state: 'blocked', reason: 'mission-trace-capacity', targetM: null, payload: null })
  expect(e.trace()).toEqual(prefix)
  expect(caught(() => e.step(observation(6620)))).toBe(error)
  expect(policy.replayReadinessMission(prefix).snapshot()).toEqual(before)
  expect(reads).toBe(0)
  const small = JSON.stringify(policy.createReadinessMissionEngine(fixture()).trace())
  const exact = small + ' '.repeat(8388608 - Buffer.byteLength(small))
  expect(policy.parseReadinessMissionTrace(exact).rows).toHaveLength(0)
  expect(() => policy.parseReadinessMissionTrace(exact + ' ')).toThrow(new RangeError('Readiness mission trace exceeds 8 MiB'))
  expect(Buffer.byteLength(JSON.stringify(prefix) + '\n')).toBeLessThanOrEqual(8388608)
  expect(prefix.rows.every(r => Buffer.byteLength(JSON.stringify(r)) <= 2048)).toBe(true)
}, 70000)

test('strict plan and observation boundaries reject descriptors and out-of-domain values without caller echoes', () => {
  let reads = 0
  const proxy = new Proxy({}, { ownKeys() { reads++; throw new Error('private') } }), revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const input of [proxy, revoked.proxy, null, [], Object.create(null), { ...fixture(), extra: true }, { ...fixture(), speedMps: undefined }, { ...fixture(), tasks: [] }, Object.defineProperty({}, 'version', { enumerable: true, get() { reads++; return 3 } })]) expect(() => validateReadinessMission(input)).toThrow(new TypeError('Invalid readiness mission plan'))
  const low = fixture(); low.power.availableWh = 0.01
  expect(() => validateReadinessMission(low)).toThrow('Readiness mission endurance budget cannot preserve reserve')
  const changed = fixture(), gate = changed.tasks.find(t => t.kind === 'readiness-loiter')!
  Reflect.set(gate, 'timeoutMs', 3001)
  expect(() => validateReadinessMission(changed)).toThrow('Invalid readiness mission plan')
  const e = policy.createReadinessMissionEngine(fixture())
  expect(caught(() => Reflect.apply(e.step, undefined, [revoked.proxy]))).toEqual(new TypeError('Invalid readiness mission observation or action'))
  expect(reads).toBe(0)
})

if (false) {
  const legacy: MissionSnapshot = policy.createMissionEngine({}).snapshot()
  const next: ReadinessMissionSnapshot = policy.createReadinessMissionEngine({}).snapshot()
  const oldPause: MissionAction = 'pause'
  const abort: ReadinessMissionAction = 'abort'
  // @ts-expect-error New profile has no pause/recovery timer suspension.
  const pause: ReadinessMissionAction = 'pause'
  // @ts-expect-error Concrete native versions remain disjoint.
  const incompatible: MissionSnapshot = next
  // @ts-expect-error No public generic engine/provider surface.
  policy.createReadinessMissionEngine<string>({})
  void legacy; void next; void oldPause; void abort; void pause; void incompatible
}

test('closed declaration and observation domains preserve exact boundary values before refusing overflow', () => {
  const e = staged(), longId = 'a'.repeat(40), ref = '9'.repeat(20) + ':' + ['9'.repeat(19), '9'.repeat(19), '9'.repeat(19), '9'.repeat(19), '9'.repeat(19)].join(',')
  expect(ref.length).toBe(120)
  const bounded = { ...release(e, 2620), planId: longId, taskId: longId, sourceId: longId, reference: ref, observedAtMs: 45000 }
  expect(e.step(observation(2620), undefined, bounded).taskId).toBe('stage')
  expect(e.trace().rows.at(-1)!.readiness).toEqual(bounded)
  expect(e.step(observation(2640, { velocityMps: [1e6, 0, 0] }), undefined, release(e, 2640)).taskId).toBe('stage')
  const prefix = e.trace()
  expect(caught(() => e.step(observation(2660, { velocityMps: [1e6 + 1, 0, 0] })))).toEqual(new TypeError('Invalid readiness mission observation or action'))
  expect(e.trace()).toEqual(prefix)
  for (const bad of [{ ...bounded, sourceId: longId + 'a' }, { ...bounded, reference: ref + '9' }, { ...bounded, observedAtMs: 45001 }, { ...bounded, ready: 'true' }, { ...bounded, sourceId: 'é' }]) {
    const next = staged()
    expect(next.step(observation(2620), undefined, bad).reason).toBe('invalid-readiness-release')
    expect(next.trace().rows.at(-1)!.readiness).toBe('invalid')
  }
  expect(policy.replayReadinessMission(prefix).snapshot().taskId).toBe('stage')
})
