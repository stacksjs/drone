import { describe, expect, test } from 'bun:test'
import { exampleMission, validateMission } from '../../resources/functions/drone/missions/plan'

describe('owned mission planning', () => {
  test('rejects incompatible frames, fences and insufficient endurance before execution', () => {
    expect(validateMission(exampleMission()).worstCaseMs).toBeGreaterThan(0)
    const wrongFrame = { ...exampleMission(), frame: 'BODY_FRD' }
    expect(() => validateMission(wrongFrame)).toThrow('mission')
    const outside = exampleMission()
    outside.rallyM = [30, 0, -1]
    expect(() => validateMission(outside)).toThrow('mission')
    const empty = exampleMission()
    empty.power.availableWh = 0.1
    expect(() => validateMission(empty)).toThrow('endurance')
  })
})

import { createMissionEngine } from '../../resources/functions/drone/missions/engine'
import type { MissionObservation } from '../../resources/functions/drone/missions/engine'
function observation(atMs: number): MissionObservation {
  return { kind: 'simulation', nowMs: atMs, reference: '55:0,0,0,0,0', origin: exampleMission().origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true }
}
test('operator start is required and cancellation cannot restart or emit another target', () => {
  const engine = createMissionEngine(exampleMission())
  expect(engine.step(observation(600)).state).toBe('ready')
  expect(engine.step(observation(620), 'start').state).toBe('running')
  expect(engine.step(observation(640), 'abort').state).toBe('aborted')
  expect(engine.step(observation(660), 'start').targetM).toBeNull()
})

import { parseMissionTrace, recoverMission, replayMission } from '../../resources/functions/drone/missions/engine'
import { simulateMission } from '../../resources/functions/drone/missions/simulation'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'

test('owned raw sensors, estimator, controls and authority complete the graph and land', () => {
  const run = simulateMission()
  expect(run.mission.state).toBe('completed')
  expect(run.finalTruthPositionM[2]).toBe(-0.1)
  expect(Math.hypot(...run.finalTruthPositionM.slice(0, 2))).toBeLessThan(0.05)
  expect(run.transitions.map(t => t.taskId)).toEqual(['takeoff', 'survey-point', 'dwell', 'budget-check', 'photo', 'return', 'land', 'land'])
  expect(run.triggers.map(t => t.taskId)).toEqual(['photo'])
  expect(run.authority.state).toBe('disarmed')
  expect(run.board.motorsN).toEqual([0, 0, 0, 0])
  expect(replayMission(parseMissionTrace(JSON.stringify(run.trace))).snapshot()).toEqual(run.mission)
})

test('pause and checkpoint recovery require resume, hold position and preserve one payload identity', () => {
  const paused = simulateMission({ scenario: 'pause-resume' })
  const recovered = simulateMission({ scenario: 'recovery' })
  expect(paused.mission.state).toBe('completed')
  expect(recovered.mission.state).toBe('completed')
  expect(recovered.recovered).toBe(true)
  const pauseRows = recovered.trace.rows.filter(r => r.observation.nowMs >= 5000 && r.observation.nowMs < 7000)
  expect(pauseRows.every(r => r.result.state === 'paused')).toBe(true)
  expect(pauseRows.at(-1)?.result.targetM).toEqual(pauseRows[0]?.result.targetM)
  expect(recovered.triggers).toHaveLength(1)
  expect(replayMission(recovered.trace).snapshot()).toEqual(recovered.mission)
  expect(recovered.finalTruthPositionM).toEqual(paused.finalTruthPositionM)
  // A fresh observation after a longer mission-process outage can recover paused,
  // provided the independent supervisor still reports authority and the reference matches.
  const prefix = structuredClone(recovered.trace)
  prefix.rows = prefix.rows.filter(r => r.observation.nowMs < 5000)
  const fresh = structuredClone(pauseRows[0]!.observation)
  fresh.nowMs = 6000
  const engine = recoverMission(prefix, fresh)
  expect(engine.snapshot().state).toBe('paused')
  fresh.nowMs += 20
  expect(engine.step(fresh).state).toBe('paused')
  fresh.nowMs += 20
  expect(engine.step(fresh, 'resume').state).toBe('running')
})

test('branching, cancellation, authority takeover and reserves are proven by replayable traces', () => {
  const branch = simulateMission({ scenario: 'branch-return' })
  expect(branch.mission.state).toBe('completed')
  expect(branch.triggers).toHaveLength(0)
  for (const scenario of ['abort', 'rc-override', 'reserve'] as const) {
    const run = simulateMission({ scenario })
    expect(run.mission.state).toBe(scenario === 'abort' ? 'aborted' : 'blocked')
    expect(run.mission.targetM).toBeNull()
    expect(run.triggers).toHaveLength(0)
    expect(run.board.motorsN).toEqual([0, 0, 0, 0])
    expect(replayMission(run.trace).snapshot()).toEqual(run.mission)
  }
})

test('reference changes, schedule gaps, invalid clocks and trace tampering fail closed', () => {
  const run = simulateMission()
  const prefix = structuredClone(run.trace)
  prefix.rows = prefix.rows.filter(r => r.observation.nowMs < 5000)
  const next = structuredClone(run.trace.rows.find(r => r.observation.nowMs === 5000)!.observation)
  const reset = replayMission(prefix)
  expect(reset.step({ ...next, reference: '56:0,0,0,0,0' }).reason).toBe('estimator-reference-changed')
  expect(reset.step({ ...next, nowMs: 5020 }, 'resume').targetM).toBeNull()
  expect(() => recoverMission(prefix, { ...next, reference: '56:0,0,0,0,0' })).toThrow('checkpoint')
  const gap = replayMission(prefix)
  expect(gap.step({ ...next, nowMs: 5100 }).reason).toBe('mission-schedule-gap')
  const clock = replayMission(prefix)
  expect(() => clock.step({ ...next, nowMs: 4980 })).toThrow('clock')
  expect(clock.snapshot().targetM).toBeNull()
  const corrupt = structuredClone(run.trace)
  corrupt.rows.find(r => r.result.payload)!.result.payload!.taskId = 'forged'
  expect(() => replayMission(corrupt)).toThrow('mismatch')
  expect(() => parseMissionTrace('{bad secret-token-json')).toThrow('Invalid mission trace JSON')
})

test('invalid graphs and unsupported task semantics are rejected before arming', () => {
  for (const mutate of [
    (p: ReturnType<typeof exampleMission>) => { p.tasks[1] = { id: 'cycle', kind: 'return', next: 'cycle', timeoutMs: 10000 } },
    (p: ReturnType<typeof exampleMission>) => { p.tasks.push({ id: 'unreachable', kind: 'abort' }) },
    (p: ReturnType<typeof exampleMission>) => { p.tasks.at(-1)!.kind = 'waypoint' },
    (p: ReturnType<typeof exampleMission>) => { p.rallyM[2] = 0 },
    (p: ReturnType<typeof exampleMission>) => { p.tasks[1] = { id: 'survey-point', kind: 'waypoint', positionM: [13, 0, -1], timeoutMs: 10000, next: 'dwell' } },
  ]) { const plan = exampleMission(); mutate(plan); expect(() => validateMission(plan)).toThrow() }
  expect(() => validateMission({ ...exampleMission(), terrain: 'FOLLOW_DEM' })).toThrow()
  expect(() => validateMission({ ...exampleMission(), tokens: 'private' })).toThrow()
  const body = createRigidBody({ positionM: [0, 0, -0.1], groundDownM: -0.1 })
  expect(body.step([0, 0, 0, 0], 0.004).groundContact).toBe(true)
  expect(() => createRigidBody({ groundDownM: NaN })).toThrow()
})

import { command as cliCommand } from '@stacksjs/testing'
import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'
test('private recorded traces survive the native CLI validate, simulate and replay round trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-mission-'))
  try {
    const planPath = join(root, 'plan.json')
    await writeFile(planPath, JSON.stringify(exampleMission()))
    const validated = await cliCommand(['missions:validate', planPath]).withTimeout(60000)
    expect(validated.exitCode).toBe(0)
    expect(JSON.parse(validated.stdout).worstCaseMs).toBe(60040)
    const recorded = await cliCommand(['missions:simulate', '--scenario', 'recovery', '--plan', planPath, '--output', join(root, 'recording')]).withTimeout(60000)
    expect(recorded.exitCode).toBe(0)
    const path = JSON.parse(recorded.stdout).tracePath
    const trace = parseMissionTrace(await readMissionFile(path))
    expect(trace.rows.at(-1)!.result.state).toBe('completed')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const replayed = await cliCommand(['missions:replay', path, '--at-ms', '6000']).withTimeout(60000)
    expect(replayed.exitCode).toBe(0)
    expect(JSON.parse(replayed.stdout).state).toBe('paused')
    expect((await cliCommand(['missions:replay', path, '--at-ms', 'nan']).withTimeout(60000)).exitCode).toBe(1)
    expect((await cliCommand(['missions:simulate', '--seconds', 'nan']).withTimeout(60000)).exitCode).toBe(1)
    await expect(writeMissionTrace(join(root, 'recording'), trace)).rejects.toThrow()
    await symlink(path, join(root, 'link'))
    await expect(readMissionFile(join(root, 'link'))).rejects.toThrow()
    await expect(readMissionFile('/dev/null')).rejects.toThrow('regular')
    await writeFile(join(root, 'broken.json'), '{secret not valid JSON')
    const broken = await cliCommand(['missions:validate', join(root, 'broken.json')]).withTimeout(60000)
    expect(broken.exitCode).toBe(1)
    expect(broken.stderr).not.toContain('secret')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)

test('task timeout, terminal abort tasks, takeoff interlocks and startup battery budget prevent progression', () => {
  const plan = exampleMission()
  plan.tasks = [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1], timeoutMs: 1000, next: 'stop' }, { id: 'stop', kind: 'abort' }]
  const engine = createMissionEngine(plan)
  engine.step(observation(600), 'start')
  for (let at = 620; at <= 1600; at += 20) engine.step(observation(at))
  expect(engine.snapshot().reason).toBe('task-timeout')
  const ending = createMissionEngine(plan)
  ending.step(observation(600), 'start')
  for (let at = 620; at <= 1120; at += 20) ending.step({ ...observation(at), onGround: false, positionM: [0, 0, -1] })
  expect(ending.snapshot().state).toBe('aborted')
  for (const changes of [{ batteryPercent: 31 }, { onGround: false }, { authority: 'manual' as const }, { positionM: [1, 1, 0] as [number, number, number] }]) {
    expect(createMissionEngine(exampleMission()).step({ ...observation(600), ...changes }, 'start').state).toBe('blocked')
  }
})

test('every movement task requires a bounded timeout before its cost is computed', () => {
  for (const task of exampleMission().tasks.filter(t => 'timeoutMs' in t)) {
    const plan = JSON.parse(JSON.stringify(exampleMission()))
    delete plan.tasks.find((t: { id: string }) => t.id === task.id).timeoutMs
    expect(() => validateMission(plan)).toThrow('mission')
  }
})

test('trace capacity latches release and preflight waiting cannot advance the target ramp', () => {
  const waiting = createMissionEngine(exampleMission())
  waiting.step(observation(0))
  expect(waiting.step(observation(10000), 'start').targetM).toEqual([0, 0, 0])
  const next = waiting.step(observation(10020))
  expect(Math.abs(next.targetM![2])).toBeCloseTo(0.012, 8)
  const full = createMissionEngine(exampleMission())
  full.step(observation(600), 'start')
  for (let i = 1; i <= 6000; i++) full.step(observation(600 + i))
  expect(() => full.step(observation(6601))).toThrow('capacity')
  expect(full.snapshot().state).toBe('blocked')
  expect(full.snapshot().targetM).toBeNull()
  expect(full.snapshot().payload).toBeNull()
})

test('inapplicable repeated start or resume cannot suppress the task timeout', () => {
  for (const action of ['start', 'resume'] as const) {
    const plan = exampleMission()
    plan.tasks = [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1], timeoutMs: 1000, next: 'stop' }, { id: 'stop', kind: 'abort' }]
    const engine = createMissionEngine(plan)
    engine.step(observation(600), 'start')
    for (let at = 620; at <= 1600; at += 20) engine.step(observation(at), action)
    expect(engine.snapshot().reason).toBe('task-timeout')
  }
})
