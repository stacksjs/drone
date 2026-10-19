import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkpointMission, createMissionEngine, parseMissionTrace, recoverMission, replayMission, resumeMission } from '../../resources/functions/drone/missions/engine'
import { exampleMission } from '../../resources/functions/drone/missions/plan'
import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'
import { simulateMission } from '../../resources/functions/drone/missions/simulation'

// Public decision replay and real CLI persistence catch unsafe resume and artifact
// publication. They do not restore or qualify a physical controller or board session.
function pausedAbortTask() {
  const plan = exampleMission()
  plan.tasks = [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1], timeoutMs: 2000, next: 'stop' }, { id: 'stop', kind: 'abort' }]
  const engine = createMissionEngine(plan)
  const observation = { kind: 'simulation' as const, nowMs: 600, reference: '55:0,0,0,0,0', origin: plan.origin, healthy: true, positionM: [0, 0, 0] as [number, number, number], velocityMps: [0, 0, 0] as [number, number, number], authority: 'autonomous' as const, batteryPercent: 100, onGround: true }
  engine.step(observation, 'start')
  for (let at = 620; at <= 1100; at += 20)
    engine.step({ ...observation, nowMs: at, positionM: [0, 0, -1], onGround: false })
  const fresh = { ...observation, nowMs: 1120, positionM: [0, 0, -1] as [number, number, number], onGround: false }
  engine.step(fresh, 'pause')
  return { trace: engine.trace(), fresh: { ...fresh, nowMs: 1140 } }
}

test('resuming at a planned abort records the legitimate terminal release', () => {
  const { trace, fresh } = pausedAbortTask()
  expect(trace.rows.at(-1)!.result.state).toBe('paused')
  expect(trace.rows.at(-1)!.result.taskId).toBe('stop')
  const resumed = resumeMission(trace, fresh)
  expect(resumed.snapshot().state).toBe('aborted')
  expect(resumed.snapshot().reason).toBe('mission-abort-task')
  expect(resumed.snapshot().targetM).toBeNull()
  expect(replayMission(resumed.trace()).snapshot()).toEqual(resumed.snapshot())
})

test('explicit resume verifies a paused prefix and retains mission decisions and payload identities', () => {
  const source = simulateMission({ scenario: 'recovery' }).trace
  const prefix = checkpointMission(source, 4980)
  const observation = source.rows.find(row => row.observation.nowMs === 6000)!.observation
  const recovered = recoverMission(prefix, observation).trace()
  const fresh = structuredClone(source.rows.find(row => row.observation.nowMs === 6020)!.observation)
  const before = structuredClone(recovered)
  const resumed = resumeMission(recovered, fresh)
  expect(resumed.snapshot().state).toBe('running')
  expect(resumed.snapshot().reason).toBe('operator-resume')
  expect(resumed.snapshot().targetM).toEqual(recovered.rows.at(-1)!.result.targetM)
  expect(resumed.trace().rows.at(-1)!.action).toBe('resume')
  expect(replayMission(resumed.trace()).snapshot()).toEqual(resumed.snapshot())
  expect(recovered).toEqual(before)
  for (const row of source.rows.filter(row => row.observation.nowMs > fresh.nowMs)) {
    const result = resumed.step(row.observation, row.action ?? undefined)
    if (result.state === 'completed') break
  }
  expect(resumed.snapshot().state).toBe('completed')
  expect(resumed.trace().rows.filter(row => row.result.payload)).toHaveLength(1)
  for (const changes of [{ nowMs: 6000 }, { nowMs: 6060 }, { authority: 'manual' as const }, { healthy: false }, { reference: '56:0,0,0,0,0' }, { batteryPercent: 0 }, { positionM: [30, 0, -1] as [number, number, number] }])
    expect(() => resumeMission(recovered, { ...fresh, ...changes })).toThrow()
  expect(() => resumeMission(prefix, fresh)).toThrow('paused')
  expect(() => resumeMission(source, fresh)).toThrow('paused')
  const corrupt = structuredClone(recovered)
  corrupt.rows[0]!.result.reason = 'forged'
  expect(() => resumeMission(corrupt, fresh)).toThrow('mismatch')
})

test('native resume writes a separate private replayable trace and publishes nothing for rejected observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-mission-resume-'))
  try {
    const source = simulateMission({ scenario: 'recovery' }).trace
    const at = (epoch: number) => structuredClone(source.rows.find(row => row.observation.nowMs === epoch)!.observation)
    const paused = recoverMission(checkpointMission(source, 4980), at(6000)).trace()
    const path = await writeMissionTrace(join(root, 'paused'), paused)
    const before = await readFile(path, 'utf8')
    const observationPath = join(root, 'observation.json')
    const invoke = (output: string) => command(['missions:resume', path, observationPath, '--output', output]).withTimeout(60000)
    await writeFile(observationPath, JSON.stringify(at(6020)))
    const output = join(root, 'resumed')
    const result = await invoke(output)
    expect(result.exitCode).toBe(0)
    const summary = JSON.parse(result.stdout)
    expect(summary.state).toBe('running')
    expect(summary.reason).toBe('operator-resume')
    expect(summary.physicalFlightEnabled).toBe(false)
    const trace = parseMissionTrace(await readMissionFile(summary.tracePath))
    expect(trace.rows.at(-1)!.action).toBe('resume')
    expect((await stat(summary.tracePath)).mode & 0o777).toBe(0o600)
    expect((await stat(output)).mode & 0o777).toBe(0o700)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await invoke(output)).exitCode).toBe(1)
    for (const changes of [{ nowMs: 6000 }, { nowMs: 6060 }, { authority: 'manual' }, { healthy: false }, { reference: '56:0,0,0,0,0' }, { batteryPercent: 0 }]) {
      await writeFile(observationPath, JSON.stringify({ ...at(6020), ...changes }))
      const rejected = join(root, 'rejected')
      expect((await invoke(rejected)).exitCode).toBe(1)
      expect(await stat(rejected).catch(() => null)).toBeNull()
    }
    await writeFile(observationPath, '{private-invalid-observation')
    const invalid = await invoke(join(root, 'invalid'))
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr).toContain('Invalid mission observation JSON')
    expect(invalid.stderr).not.toContain('private-invalid-observation')
    expect((await command(['missions:resume', path, observationPath]).withTimeout(60000)).exitCode).toBe(1)
    const abort = pausedAbortTask()
    const abortPath = await writeMissionTrace(join(root, 'abort-paused'), abort.trace)
    await writeFile(observationPath, JSON.stringify(abort.fresh))
    const ending = await command(['missions:resume', abortPath, observationPath, '--output', join(root, 'abort-resumed')]).withTimeout(60000)
    expect(ending.exitCode).toBe(0)
    const terminal = JSON.parse(ending.stdout)
    expect(terminal.state).toBe('aborted')
    expect(terminal.reason).toBe('mission-abort-task')
    expect(terminal.targetM).toBeNull()
    expect(parseMissionTrace(await readMissionFile(terminal.tracePath)).rows.at(-1)!.result.state).toBe('aborted')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)
