import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { replayTaskMotionMission } from '../../resources/functions/drone/missions/engine'
import { validateTaskMotionMission } from '../../resources/functions/drone/missions/plan'
import * as simulation from '../../resources/functions/drone/missions/simulation'

test('the owned task-motion world exposes a concrete public entrypoint', () => {
  expect(simulation).toHaveProperty('simulateTaskMotionMission')
})

function fixture() {
  return {
    version: 4, id: 'cinema-dolly-task-motion-v1', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE',
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.6,
    tasks: [
      { id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 10000, next: 'stage' },
      { id: 'stage', kind: 'readiness-loiter', positionM: [0, 0, -1.2], durationMs: 1500, timeoutMs: 3000, sourceId: 'cinema-stage-readiness-v1', next: 'dolly' },
      { id: 'dolly', kind: 'waypoint', speedMps: 0.2, positionM: [2, 0, -1.2], timeoutMs: 12000, next: 'return' },
      { id: 'return', kind: 'return', timeoutMs: 12000, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 7000 },
    ],
  }
}
function release(context: simulation.TaskMotionMissionSimulationContext) {
  const m = context.mission
  if (m.state !== 'running' || m.taskId !== 'stage' || m.taskEnteredAtMs === null || m.runStartedAtMs === null || context.nowMs < m.taskEnteredAtMs + 1800) return null
  return { version: 1 as const, planId: 'cinema-dolly-task-motion-v1', runStartedAtMs: m.runStartedAtMs, taskId: m.taskId, taskEnteredAtMs: m.taskEnteredAtMs, sourceId: 'cinema-stage-readiness-v1', reference: `${context.estimate.bootId}:${Object.values(context.estimate.resets).join(',')}`, observedAtMs: context.nowMs, ready: true }
}
function preserveFirstResult(run: simulation.TaskMotionMissionSimulationRun) {
  const directory = process.env.TASK_MOTION_WORLD_EVIDENCE
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  const bigintPaths: string[][] = []
  function copy(value: unknown, path: string[]): unknown {
    if (typeof value === 'bigint') { bigintPaths.push(path); return value.toString() }
    if (Array.isArray(value)) return value.map((v, i) => copy(v, [...path, String(i)]))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v, [...path, k])]))
    return value
  }
  // Full actual result is retained BEFORE every assertion. Metadata restores exact BigInt types losslessly.
  writeFileSync(join(directory, 'result.json'), JSON.stringify(copy(run, [])) + '\n', { flag: 'wx', mode: 0o600 })
  writeFileSync(join(directory, 'encoding.json'), JSON.stringify({ encoding: 'Complete actual result JSON plus one LF; exact decimal strings replace only BigInt values at bigintPaths. Restore those values with BigInt(decimal). This is local evidence, not a whole-run application JSON DTO.', bigintPaths }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

test('one real task-motion world holds, releases, traverses the full five-task flight, lands and replays', () => {
  const rawPlan = fixture(), directory = process.env.TASK_MOTION_WORLD_EVIDENCE
  if (directory) {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'raw-plan.json'), JSON.stringify(rawPlan) + '\n', { flag: 'wx', mode: 0o600 })
    writeFileSync(join(directory, 'validated-plan-budget.json'), JSON.stringify(validateTaskMotionMission(rawPlan)) + '\n', { flag: 'wx', mode: 0o600 })
    writeFileSync(join(directory, 'limits.json'), JSON.stringify({ worldMs: 45000, bodyTickMs: 4, firstPolicyMs: 600, policyTickMs: 20, readinessAfterActualStageEntryMs: 1800, decisions: 2221, transitions: 2221, triggers: 32, path: 224, nativeRows: 6001, nativeBytes: 8388608, nativePlanBytes: 32768, nativeRowBytes: 2048, physicalFlightEnabled: false, realCameraReadiness: false }) + '\n', { flag: 'wx', mode: 0o600 })
  }
  let run: simulation.TaskMotionMissionSimulationRun
  try {
    run = simulation.simulateTaskMotionMission({ plan: rawPlan, instrument: { render() {}, observe: release } })
  }
  catch (error) {
    const directory = process.env.TASK_MOTION_WORLD_EVIDENCE
    if (directory) {
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'fatal.json'), JSON.stringify({ name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : 'unknown' }) + '\n', { flag: 'wx', mode: 0o600 })
    }
    throw error
  }
  preserveFirstResult(run)
  console.log(JSON.stringify({ label: 'actual-task-motion-world-vertical', state: run.mission.state, reason: run.mission.reason, taskId: run.mission.taskId, lastEpochMs: run.trace.rows.at(-1)?.observation.nowMs, transitions: run.transitions }))
  expect(run.mission.state).toBe('completed')
  expect(run.mission.reason).toBe('landed')
  expect(run.version).toBe(4)
  expect(run.trace.version).toBe(4)
  expect(run.evidence).toBe('owned-task-motion-mission-physics-simulation')
  expect(Object.keys(run)).toEqual(['version', 'evidence', 'physicalFlightEnabled', 'boardOutputsInhibited', 'mission', 'budget', 'transitions', 'triggers', 'path', 'trace', 'authority', 'board', 'finalTruthPositionM'])
  expect(run.trace.plan).toEqual(validateTaskMotionMission(fixture()).plan)
  expect(run.trace.plan.tasks.map(t => 'speedMps' in t ? t.speedMps : null)).toEqual([0.6, 0.6, 0.2, 0.6, 0.6])
  expect(run.budget.worstCaseMs).toBe(44000)
  expect(run.transitions.filter(t => t.state === 'running').map(t => t.taskId)).toEqual(['takeoff', 'stage', 'dolly', 'return', 'land'])
  const e = run.trace.rows.find(r => r.result.taskId === 'stage')!
  const d = run.trace.rows.find(r => r.result.taskId === 'dolly')!
  const home = run.trace.rows.find(r => r.result.taskId === 'return')!
  const land = run.trace.rows.find(r => r.result.taskId === 'land')!
  expect(e.result.runStartedAtMs).toBe(600)
  expect(e.result.taskEnteredAtMs).toBe(e.observation.nowMs)
  expect(d.observation.nowMs).toBeGreaterThanOrEqual(e.observation.nowMs + 1800)
  expect(d.observation.nowMs).toBeLessThan(e.observation.nowMs + 3000)
  expect(d.readiness).toMatchObject({ observedAtMs: d.observation.nowMs, taskEnteredAtMs: e.observation.nowMs, ready: true })
  expect(Math.hypot(home.observation.positionM[0] - 2, home.observation.positionM[1], home.observation.positionM[2] + 1.2)).toBeLessThanOrEqual(0.2)
  expect(Math.hypot(land.observation.positionM[0], land.observation.positionM[1], land.observation.positionM[2] + 1.2)).toBeLessThanOrEqual(0.2)
  expect(run.trace.rows.at(-1)?.observation.onGround).toBe(true)
  expect(run.finalTruthPositionM[2]).toBe(-0.1)
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
  expect(run.board.fault).toBeNull()
  expect(run.authority.state).toBe('disarmed')
  expect(replayTaskMotionMission(run.trace).snapshot()).toEqual(run.mission)
  expect(run.trace.rows.length).toBeLessThanOrEqual(2221)
  expect(run.transitions.length).toBeLessThanOrEqual(2221)
  expect(run.triggers.length).toBeLessThanOrEqual(32)
  expect(run.path.length).toBeLessThanOrEqual(224)
  expect(run.path.every(row => [row.estimatedPositionM, row.truthPositionM, row.targetM].every(v => v === null || v.length === 3 && v.every(Number.isFinite)))).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(run.trace) + '\n')).toBeLessThanOrEqual(8388608)
  expect(Buffer.byteLength(JSON.stringify(run.trace.plan) + '\n')).toBeLessThanOrEqual(32768)
  expect(run.trace.rows.every(row => Buffer.byteLength(JSON.stringify(row)) <= 2048)).toBe(true)
})

test('legacy instruments retain live options, getters and method receivers across replacement', () => {
  const calls: string[] = [], receivers: boolean[] = []
  const replacement: simulation.MissionSimulationInstrument = {
    render() { receivers.push(this === replacement) },
    observe(context) { receivers.push(this === replacement); calls.push(`replacement:${context.nowMs}`); return 'abort' },
  }
  const original: simulation.MissionSimulationInstrument = {
    render() { receivers.push(this === original) },
    observe(context) { receivers.push(this === original); calls.push(`original:${context.nowMs}`); active = replacement },
  }
  let active = original, reads = 0
  const options = { get instrument() { reads++; return active } }
  const run = simulation.simulateMission(options)
  expect(run.mission.state).toBe('aborted')
  expect(run.mission.reason).toBe('operator-abort')
  expect(run.trace.rows.at(-1)?.observation.nowMs).toBe(620)
  expect(calls).toEqual(['original:600', 'replacement:620'])
  expect(receivers).toEqual([true, true, true, true])
  expect(reads).toBeGreaterThan(4)
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
})

// Reflect.apply is intentional at the public runtime boundary: hostile JS data is not a typed provider.
function unchecked(options: unknown): simulation.TaskMotionMissionSimulationRun {
  return Reflect.apply(simulation.simulateTaskMotionMission, undefined, [options])
}
function supplied(observe: (context: simulation.TaskMotionMissionSimulationContext) => unknown, render: (state: unknown, atMs: number) => unknown = () => {}, observation?: (atMs: number) => unknown) {
  return unchecked({ plan: fixture(), instrument: { render, observe, ...(observation ? { observation } : {}) } })
}
function neutralReplay(run: simulation.TaskMotionMissionSimulationRun) {
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
  expect(run.board.fault).toBeNull()
  expect(replayTaskMotionMission(run.trace).snapshot()).toEqual(run.mission)
}

test('strict world setup rejects bounded malformed own-data configuration without invoking traps', () => {
  let traps = 0
  const getter = Object.defineProperty({}, 'plan', { enumerable: true, get() { traps++; return fixture() } })
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw new Error('private') }, ownKeys() { traps++; throw new Error('private') }, get() { traps++; throw new Error('private') } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const hidden = Object.defineProperty({}, 'plan', { value: fixture() })
  const inherited = Object.create({ plan: fixture() })
  const foreign = fixture(); foreign.origin.latitudeDeg = 1
  const ready3 = { ...fixture(), version: 3 }
  const valid = { render() {}, observe() {} }
  const accessorInstrument = Object.defineProperty({ render() {} }, 'observe', { enumerable: true, get() { traps++; return () => {} } })
  for (const bad of [undefined, null, [], 'private', {}, proxy, revoked.proxy, getter, hidden, inherited, { plan: fixture(), [Symbol('private')]: true }, { plan: fixture(), scenario: 'nominal' }, { plan: foreign }, { plan: ready3 }, ...[undefined, 7, 46, 8.5, Infinity, '45'].map(seconds => ({ plan: fixture(), seconds })), ...[undefined, null, proxy, {}, { observe() {} }, { render() {} }, accessorInstrument, { ...valid, disturbance() {} }, { ...valid, observation: undefined }, { ...valid, render: new Proxy(() => {}, {}) }].map(instrument => ({ plan: fixture(), instrument }))]) {
    expect(() => unchecked(bad)).toThrow(new TypeError('task-motion-mission-simulation-input'))
  }
  expect(traps).toBe(0)
  expect(simulation).not.toHaveProperty('simulateReadinessMission')
})

test('new callbacks are captured once with undefined receivers and isolated prior-native contexts', () => {
  const receivers: unknown[] = [], priors: { nowMs: number, state: string, version: number }[] = [], truthX: number[] = []
  const instrument: simulation.TaskMotionMissionSimulationInstrument = {
    render(state) { receivers.push(this); truthX.push(state.positionM[0]); state.positionM[0] = 999; instrument.observe = () => 'abort' },
    observe(context) {
      receivers.push(this)
      expect(Object.keys(context)).toEqual(['nowMs', 'estimate', 'sensors', 'mission', 'authority', 'battery', 'link'])
      expect(Object.hasOwn(context, 'truth')).toBe(false)
      priors.push({ nowMs: context.nowMs, state: context.mission.state, version: context.mission.version })
      context.mission.taskId = 'mutated-copy'
      context.sensors.sensors.length = 0
      return context.nowMs === 640 ? 'abort' : null
    },
  }
  const run = simulation.simulateTaskMotionMission({ instrument, plan: fixture(), seconds: 8 })
  expect(priors).toEqual([{ nowMs: 600, state: 'ready', version: 4 }, { nowMs: 620, state: 'running', version: 4 }, { nowMs: 640, state: 'running', version: 4 }])
  expect(receivers.every(value => value === undefined)).toBe(true)
  expect(truthX.every(value => Math.abs(value) < 1)).toBe(true)
  expect(run.mission.taskId).toBe('takeoff')
  expect(run.mission.reason).toBe('operator-abort')
  expect(run.trace.rows.map(row => row.observation.nowMs)).toEqual([600, 620, 640])
  neutralReplay(run)
})

test('missing null false foreign stale and one early truth cannot release the real native stage', () => {
  for (const kind of ['missing', 'null', 'false', 'foreign', 'stale', 'early'] as const) {
    const run = supplied(context => {
      const declaration = release(context), m = context.mission
      if (kind === 'missing') return undefined
      if (kind === 'null') return null
      if (kind === 'early') {
        if (m.taskId !== 'stage' || m.taskEnteredAtMs === null || m.runStartedAtMs === null || context.nowMs !== m.taskEnteredAtMs + 20) return null
        return { version: 1, planId: 'cinema-dolly-task-motion-v1', runStartedAtMs: m.runStartedAtMs, taskId: m.taskId, taskEnteredAtMs: m.taskEnteredAtMs, sourceId: 'cinema-stage-readiness-v1', reference: `${context.estimate.bootId}:${Object.values(context.estimate.resets).join(',')}`, observedAtMs: context.nowMs, ready: true }
      }
      if (!declaration) return null
      if (kind === 'false') return { ...declaration, ready: false }
      if (kind === 'foreign') return { ...declaration, sourceId: 'foreign' }
      return { ...declaration, observedAtMs: context.nowMs - 20 }
    })
    const entry = run.trace.rows.find(row => row.result.taskId === 'stage')!
    expect(run.mission.state).toBe('blocked')
    expect(run.mission.taskId).toBe('stage')
    expect(run.mission.reason).toBe('task-timeout')
    expect(run.trace.rows.at(-1)?.observation.nowMs).toBe(entry.result.taskEnteredAtMs! + 3000)
    expect(run.transitions.some(row => row.taskId === 'dolly')).toBe(false)
    neutralReplay(run)
  }
})

test('same-epoch native safety precedes abort and abort precedes timeout and readiness in the real loop', () => {
  for (const kind of ['timeout', 'abort', 'safety'] as const) {
    let deadline: number | null = null
    const run = supplied(context => {
      const m = context.mission
      if (m.taskId !== 'stage' || m.taskEnteredAtMs === null) return null
      deadline = m.taskEnteredAtMs + 3000
      if (context.nowMs !== deadline) return null
      return kind === 'timeout' ? release(context) : 'abort'
    }, () => {}, atMs => kind === 'safety' && atMs === deadline ? { link: { capturedAtMs: atMs, connected: false } } : {})
    expect(run.mission.reason).toBe(kind === 'timeout' ? 'task-timeout' : kind === 'abort' ? 'operator-abort' : 'authority-revoked')
    expect(run.trace.rows.at(-1)?.observation.nowMs).toBe(deadline!)
    expect(run.trace.rows.at(-1)?.action).toBe(kind === 'timeout' ? null : 'abort')
    expect(run.transitions.some(row => row.taskId === 'dolly')).toBe(false)
    neutralReplay(run)
  }
})

test('foreign synchronous readiness stays uncoerced and trap-free until native gated rejection', () => {
  let traps = 0
  const proxy = new Proxy({}, { get() { traps++; throw new Error('private') }, getPrototypeOf() { traps++; throw new Error('private') }, ownKeys() { traps++; throw new Error('private') } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const thenable = Object.defineProperty({}, 'then', { enumerable: true, get() { traps++; throw new Error('private') } })
  for (const value of [proxy, revoked.proxy, thenable, [], true, 1, 'private', {}, new Date(0)]) {
    const run = supplied(() => value)
    expect(run.mission.reason).toBe('invalid-readiness-release')
    expect(run.mission.taskId).toBe('stage')
    expect(run.trace.rows.at(-1)?.readiness).toBe('invalid')
    expect(run.trace.rows.at(-1)?.action).toBeNull()
    neutralReplay(run)
  }
  expect(traps).toBe(0)
})

test('callback throws and genuine Promise results abort synchronously without observe after failed render', () => {
  for (const callback of ['throw', 'fulfilled', 'rejected'] as const) {
    let observations = 0
    const result = () => {
      if (callback === 'throw') throw new Error('private callback detail')
      return callback === 'fulfilled' ? Promise.resolve(null) : Promise.reject(new Error('private rejection detail'))
    }
    const renderRun = supplied(() => { observations++; return null }, result)
    expect(observations).toBe(0)
    expect(renderRun.mission.reason).toBe('operator-abort')
    expect(renderRun.trace.rows).toHaveLength(1)
    expect(renderRun.trace.rows[0]?.readiness).toBeNull()
    neutralReplay(renderRun)
    const observeRun = supplied(result)
    expect(observeRun.mission.reason).toBe('operator-abort')
    expect(observeRun.trace.rows).toHaveLength(1)
    neutralReplay(observeRun)
  }
  let thenReads = 0, observes = 0
  const inert = Object.defineProperty({}, 'then', { get() { thenReads++; throw new Error('private') } })
  for (const value of [null, false, 1, {}, inert]) {
    const run = supplied(() => { observes++; return null }, () => value)
    expect(run.mission.reason).toBe('operator-abort')
    neutralReplay(run)
  }
  expect(thenReads).toBe(0)
  expect(observes).toBe(0)
})

test('invalid supplied resources withdraw authority without leaking callback data', () => {
  let traps = 0
  const hostile = Object.defineProperty({}, 'link', { enumerable: true, get() { traps++; throw new Error('private') } })
  const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw new Error('private') }, ownKeys() { traps++; throw new Error('private') } })
  for (const value of [hostile, proxy, null, { link: { capturedAtMs: 620, connected: 'yes' } }, { link: { capturedAtMs: 621, connected: true } }, { battery: { capturedAtMs: 620, remainingPercent: 100 } }]) {
    const run = supplied(() => null, () => {}, atMs => atMs === 620 ? value : {})
    expect(run.mission.reason).toBe('authority-revoked')
    expect(run.trace.rows.at(-1)?.observation.nowMs).toBe(620)
    expect(run.trace.rows.at(-1)?.observation.batteryPercent).toBe(0)
    neutralReplay(run)
  }
  expect(traps).toBe(0)
})

if (false) {
  const run = simulation.simulateTaskMotionMission({ plan: fixture() })
  const contextMission: simulation.TaskMotionMissionSimulationContext['mission'] = run.mission
  const trace: import('../../resources/functions/drone/missions/engine').TaskMotionMissionTrace = run.trace
  const vector: import('../../resources/functions/drone/sensors/types').SensorVector = run.finalTruthPositionM
  // @ts-expect-error World four is not a legacy or readiness world result.
  const old: ReturnType<typeof simulation.simulateMission> = run
  // @ts-expect-error Actual native-four trace is disjoint from pure readiness-three.
  const ready: import('../../resources/functions/drone/missions/engine').ReadinessMissionTrace = run.trace
  // @ts-expect-error Public simulator is concrete, not generic.
  simulation.simulateTaskMotionMission<unknown>({ plan: fixture() })
  // @ts-expect-error New instrumentation has no disturbance hook.
  const injected: simulation.TaskMotionMissionSimulationInstrument = { render() {}, observe() {}, disturbance() {} }
  void contextMission; void trace; void vector; void old; void ready; void injected
}

test('new observation Promise and throw paths abort under native resource priority without late continuation', () => {
  for (const kind of ['throw', 'fulfilled', 'rejected'] as const) {
    const run = supplied(() => null, () => {}, atMs => {
      if (atMs !== 620) return {}
      if (kind === 'throw') throw new Error('private observation detail')
      return kind === 'fulfilled' ? Promise.resolve({}) : Promise.reject(new Error('private observation rejection'))
    })
    expect(run.mission.reason).toBe('authority-revoked')
    expect(run.trace.rows.at(-1)?.observation.nowMs).toBe(620)
    expect(run.trace.rows.at(-1)?.action).toBe('abort')
    neutralReplay(run)
  }
})

test('omitted new resource fields retain original samples and cannot refresh their clocks', () => {
  for (const kind of ['battery', 'link'] as const) {
    const clocks: number[] = []
    const run = supplied(context => { if (context.nowMs === 620) clocks.push(context[kind].capturedAtMs); return null }, () => {}, atMs => atMs !== 600 ? {} : kind === 'battery' ? { battery: { capturedAtMs: atMs, remainingPercent: 80 } } : { link: { capturedAtMs: atMs, connected: true } })
    expect(clocks).toEqual([600])
    expect(run.trace.rows.at(-1)?.observation.nowMs).toBe(kind === 'battery' ? 1120 : 760)
    expect(run.mission.reason).toBe('authority-revoked')
    neutralReplay(run)
  }
})
