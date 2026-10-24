import { expect, test } from 'bun:test'
import { createAirProfile } from '../../resources/functions/drone/vehicles/air'
import { createGroundProfile } from '../../resources/functions/drone/vehicles/ground'
import { createSurfaceProfile } from '../../resources/functions/drone/vehicles/surface'
import { createSubseaProfile } from '../../resources/functions/drone/vehicles/subsea'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { checkpointVehicleMission, recoverVehicleMission, replayVehicleMission, resumeVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Actual owned physics plus public mission APIs catch unsafe portable policy
// continuation. They do not restore a vehicle loop, board or physical payload.
test('all v2 vehicle profiles extract, recover paused and explicitly resume verified mission decisions', () => {
  for (const profile of [createAirProfile(), createGroundProfile(), createSurfaceProfile(), createSubseaProfile()]) {
    const run = runVehicleSimulation(profile, { seconds: 180 })
    expect(run.status).toBe('completed')
    const source = structuredClone(run.trace)
    const at = source.rows[10]!.observation.nowMs
    const checkpoint = checkpointVehicleMission(source, at)
    expect(checkpoint.rows).toHaveLength(11)
    const fresh = source.rows[20]!.observation
    const recovered = recoverVehicleMission(checkpoint, fresh)
    expect(recovered.snapshot().state).toBe('paused')
    expect(recovered.snapshot().targetM).toEqual(fresh.positionM)
    const resumed = resumeVehicleMission(recovered.trace(), source.rows[21]!.observation)
    expect(resumed.snapshot().state).toBe('running')
    expect(resumed.snapshot().vehicle).toBe(profile.mission.vehicle)
    expect(resumed.snapshot().physicalFlightEnabled).toBe(false)
    expect(replayVehicleMission(resumed.trace()).snapshot()).toEqual(resumed.snapshot())
    expect(source).toEqual(run.trace)
    const corrupt = structuredClone(source)
    corrupt.rows.at(-1)!.result.reason = 'forged-future'
    expect(() => checkpointVehicleMission(corrupt, at)).toThrow('mismatch')
    for (const epoch of [NaN, -1, at + 1, source.rows.at(-1)!.observation.nowMs])
      expect(() => checkpointVehicleMission(source, epoch)).toThrow()
  }
}, 60000)

import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOwnedMissionTrace, replayOwnedMission } from '../../resources/functions/drone/missions/recording'

test('native mission commands persist v2 simulation, checkpoint, paused recovery and explicit resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-v2-checkpoint-'))
  const cli = (args: string[]) => command(args).withTimeout(60000)
  try {
    const simulated = await cli(['missions:simulate', '--profile', 'ground', '--scenario', 'logistics', '--seconds', '120', '--output', join(root, 'source')])
    expect(simulated.exitCode).toBe(0)
    const sourcePath = JSON.parse(simulated.stdout).tracePath
    const original = await readFile(sourcePath, 'utf8')
    const source = parseOwnedMissionTrace(original)
    expect(source.version).toBe(2)
    const at = source.rows[10]!.observation.nowMs
    const saved = await cli(['missions:checkpoint', sourcePath, '--at-ms', String(at), '--output', join(root, 'checkpoint')])
    expect(saved.exitCode).toBe(0)
    const checkpointPath = JSON.parse(saved.stdout).tracePath
    const observationPath = join(root, 'observation.json')
    await writeFile(observationPath, JSON.stringify(source.rows[20]!.observation))
    const recovered = await cli(['missions:recover', checkpointPath, observationPath, '--output', join(root, 'recovered')])
    expect(recovered.exitCode).toBe(0)
    expect(JSON.parse(recovered.stdout).state).toBe('paused')
    await writeFile(observationPath, JSON.stringify(source.rows[21]!.observation))
    const resumed = await cli(['missions:resume', JSON.parse(recovered.stdout).tracePath, observationPath, '--output', join(root, 'resumed')])
    expect(resumed.exitCode).toBe(0)
    const result = JSON.parse(resumed.stdout)
    expect(result.state).toBe('running')
    expect(result.vehicle).toBe('ground')
    expect(result.physicalFlightEnabled).toBe(false)
    const trace = parseOwnedMissionTrace(await readFile(result.tracePath, 'utf8'))
    expect(replayOwnedMission(trace).snapshot().state).toBe('running')
    const replayed = await cli(['missions:replay', result.tracePath])
    expect(replayed.exitCode).toBe(0)
    expect(JSON.parse(replayed.stdout).state).toBe('running')
    expect((await stat(result.tracePath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'resumed'))).mode & 0o777).toBe(0o700)
    expect(await readFile(sourcePath, 'utf8')).toBe(original)
    const duplicate = await cli(['missions:resume', JSON.parse(recovered.stdout).tracePath, observationPath, '--output', join(root, 'resumed')])
    expect(duplicate.exitCode).toBe(1)
    const unsolicited = structuredClone(source.rows.find(row => 'payloadAck' in row.observation && row.observation.payloadAck !== null)!.observation)
    for (const change of [{ payloadAck: 'payloadAck' in unsolicited ? unsolicited.payloadAck : null }, { authority: 'manual' }, { payloadAck: { eventId: 'unsolicited' } }, { reference: '56:0,0,0,0,0' }, { batteryPercent: 0 }, { nowMs: source.rows[20]!.observation.nowMs + 41 }]) {
      await writeFile(observationPath, JSON.stringify({ ...source.rows[21]!.observation, ...change }))
      const rejected = await cli(['missions:resume', JSON.parse(recovered.stdout).tracePath, observationPath, '--output', join(root, 'rejected')])
      expect(rejected.exitCode).toBe(1)
      if ('payloadAck' in change && change.payloadAck && 'taskId' in change.payloadAck) expect(rejected.stderr).toContain('unsolicited-payload-ack')
      expect(await stat(join(root, 'rejected')).catch(() => null)).toBeNull()
    }
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)

import type { VehicleMissionObservation } from '../../resources/functions/drone/vehicles/types'
import { createVehicleMissionEngine, validateVehicleMission } from '../../resources/functions/drone/missions/vehicle'

test('resume records immediate terminal release and never retries a pending or already acknowledged payload', () => {
  const profile = createGroundProfile('logistics')
  const source = runVehicleSimulation(profile, { seconds: 120 }).trace
  const pending = source.rows.findIndex(row => row.result.payload !== null)
  expect(pending).toBeGreaterThan(0)
  expect(() => checkpointVehicleMission(source, source.rows[pending]!.observation.nowMs)).toThrow('payload')
  const unsafe = structuredClone(source)
  unsafe.rows = unsafe.rows.slice(0, pending + 1)
  expect(() => recoverVehicleMission(unsafe, source.rows[pending + 1]!.observation)).toThrow()
  const confirmed = source.rows.findIndex(row => row.result.reason === 'payload-confirmed')
  const checkpoint = checkpointVehicleMission(source, source.rows[confirmed]!.observation.nowMs)
  const recovered = recoverVehicleMission(checkpoint, source.rows[confirmed + 1]!.observation)
  const resumed = resumeVehicleMission(recovered.trace(), source.rows[confirmed + 2]!.observation)
  for (const row of source.rows.slice(confirmed + 3)) resumed.step(row.observation, row.action ?? undefined)
  expect(resumed.snapshot().state).toBe('completed')
  const commands = resumed.trace().rows.flatMap(row => row.result.payload ? [row.result.payload.eventId] : [])
  expect(new Set(commands).size).toBe(1)
  expect(resumed.trace().rows.filter(row => row.result.reason === 'payload-confirmed')).toHaveLength(1)
  expect(replayVehicleMission(resumed.trace()).snapshot()).toEqual(resumed.snapshot())

  for (const terminal of ['abort', 'stop'] as const) {
    const plan = structuredClone(profile.mission)
    plan.start = 'begin'
    plan.tasks = [{ id: 'begin', kind: 'start', next: terminal === 'abort' ? 'choice' : 'finish' }, terminal === 'abort' ? { id: 'finish', kind: 'abort' } : { id: 'finish', kind: 'stop', positionM: [0, 0, 0], acceptanceM: 0.2, maxArrivalSpeedMps: 0.1, settleMs: 0, timeoutMs: 1000 }]
    if (terminal === 'abort') plan.tasks.splice(1, 0, { id: 'choice', kind: 'branch', batteryAtLeast: 80, then: 'finish', otherwise: 'finish' })
    const engine = createVehicleMissionEngine(plan)
    const observation: VehicleMissionObservation = { kind: 'simulation', nowMs: 1000, reference: '55:0,0,0,0,0', origin: plan.origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true, payloadAck: null }
    // Pause before a stop or branch, then record the terminal resume decision.
    engine.step(observation, 'start')
    engine.step({ ...observation, nowMs: 1020 }, 'pause')
    const resumed = resumeVehicleMission(engine.trace(), { ...observation, nowMs: 1040 })
    expect(resumed.snapshot().state).toBe(terminal === 'abort' ? 'aborted' : 'completed')
    expect(resumed.snapshot().targetM).toBeNull()
    expect(resumed.snapshot().payload).toBeNull()
    expect(replayVehicleMission(resumed.trace()).snapshot()).toEqual(resumed.snapshot())
  }
})

import { parseMissionTrace } from '../../resources/functions/drone/missions/engine'
import { simulateMission } from '../../resources/functions/drone/missions/simulation'
import { replayOwnedMissionAt } from '../../resources/functions/drone/missions/recording'

test('recording dispatch preserves version budgets and verifies future rows before partial playback', () => {
  const v1 = simulateMission().trace
  expect(parseOwnedMissionTrace(JSON.stringify(v1))).toEqual(parseMissionTrace(JSON.stringify(v1)))
  const v2 = runVehicleSimulation(createGroundProfile(), { seconds: 120 }).trace
  expect(replayOwnedMissionAt(v2, v2.rows[10]!.observation.nowMs).trace().rows).toHaveLength(11)
  const corrupt = structuredClone(v2)
  corrupt.rows.at(-1)!.result.reason = 'forged-after-playback'
  expect(() => replayOwnedMissionAt(corrupt, corrupt.rows[10]!.observation.nowMs)).toThrow('mismatch')
  expect(() => parseOwnedMissionTrace('{private-invalid-json')).toThrow('Invalid mission trace JSON')
  expect(() => parseOwnedMissionTrace(JSON.stringify({ ...v2, version: 4 }))).toThrow('version')
  const padding = ' '.repeat(8 * 1024 * 1024)
  expect(() => parseOwnedMissionTrace(JSON.stringify(v1) + padding)).toThrow('8 MiB')
  expect(parseOwnedMissionTrace(JSON.stringify(v2) + padding).version).toBe(2)
  expect(() => parseOwnedMissionTrace(' '.repeat(16 * 1024 * 1024 + 1))).toThrow('16 MiB')
  expect(() => replayOwnedMissionAt(v2, NaN)).toThrow('epoch')
})

test('v2 recovery rejects incompatible authority, estimation, references, fence, budgets and clocks', () => {
  const profile = createGroundProfile()
  const source = runVehicleSimulation(profile, { seconds: 120 }).trace
  const checkpoint = checkpointVehicleMission(source, source.rows[10]!.observation.nowMs)
  const fresh = source.rows[20]!.observation
  const { worstCaseMs } = validateVehicleMission(source.plan)
  for (const change of [
    { origin: { ...fresh.origin, ellipsoidHeightM: fresh.origin.ellipsoidHeightM + 1 } },
    { reference: '56:0,0,0,0,0' }, { healthy: false }, { authority: 'manual' as const },
    { positionM: [source.plan.fence.radiusM + 1, 0, 0] as [number, number, number] },
    { batteryPercent: source.plan.power.reservePercent },
    { nowMs: source.rows[0]!.observation.nowMs + worstCaseMs + 1 },
    { nowMs: checkpoint.rows.at(-1)!.observation.nowMs },
    { nowMs: checkpoint.rows.at(-1)!.observation.nowMs - 1 },
  ]) expect(() => recoverVehicleMission(checkpoint, { ...fresh, ...change })).toThrow()
  for (const trace of [createVehicleMissionEngine(profile.mission).trace(), checkpoint, source])
    expect(() => resumeVehicleMission(trace, fresh)).toThrow('paused')
  expect(replayVehicleMission(checkpoint).snapshot().state).toBe('running')
})

test('version dispatch accepts the full v2 row budget and rejects one extra row', () => {
  const plan = createGroundProfile().mission
  const engine = createVehicleMissionEngine(plan)
  const observation: VehicleMissionObservation = { kind: 'simulation', nowMs: 0, reference: '55:0,0,0,0,0', origin: plan.origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'manual', batteryPercent: 100, onGround: true, payloadAck: null }
  for (let nowMs = 0; nowMs < 9001; nowMs++) engine.step({ ...observation, nowMs })
  const trace = engine.trace()
  expect(parseOwnedMissionTrace(JSON.stringify(trace)).rows).toHaveLength(9001)
  trace.rows.push(structuredClone(trace.rows.at(-1)!))
  expect(() => parseOwnedMissionTrace(JSON.stringify(trace))).toThrow('Invalid vehicle mission trace')
})

// Returned decisions are caller-owned. Mutating one must not rewrite history.
test('unavailable-navigation decisions remain detached from retained version-3 history', () => {
  const plan = createGroundProfile().mission, engine = createVehicleMissionEngine(plan)
  const observation: VehicleMissionObservation = { kind: 'simulation', nowMs: 0, reference: '55:0,0,0,0,0', origin: plan.origin, healthy: false, positionM: null, velocityMps: null, authority: 'autonomous', batteryPercent: 100, onGround: false, payloadAck: null }
  const result = engine.step(observation), retained = JSON.stringify(engine.trace()), decision = engine.snapshot()
  expect(result.state).toBe('blocked')
  expect(result.reason).toBe('estimator-loss')
  expect(engine.trace().version).toBe(3)
  result.state = 'completed'
  result.reason = 'caller-mutated'
  result.targetM = [123, 0, 0]
  expect(engine.snapshot()).toEqual(decision)
  expect(JSON.stringify(engine.trace())).toBe(retained)
  expect(replayVehicleMission(engine.trace()).snapshot()).toEqual(decision)
})

import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'

// The native replay boundary must read the same loss artifact that we persist.
test('native replay reads a persisted version-3 navigation-loss recording', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-v3-navigation-loss-'))
  try {
    const plan = createGroundProfile().mission, engine = createVehicleMissionEngine(plan)
    const observation: VehicleMissionObservation = { kind: 'simulation', nowMs: 0, reference: '55:0,0,0,0,0', origin: plan.origin, healthy: true, positionM: [0, 0, 0], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: true, payloadAck: null }
    expect(engine.step(observation, 'start').state).toBe('running')
    engine.step({ ...observation, nowMs: 20, healthy: false, positionM: null, velocityMps: null })
    const trace = engine.trace()
    expect(trace.version).toBe(3)
    const path = await writeMissionTrace(join(root, 'loss'), trace)
    const text = await readMissionFile(path, { maxBytes: 16 * 1024 * 1024 })
    expect(parseOwnedMissionTrace(text)).toEqual(trace)
    expect(replayOwnedMission(parseOwnedMissionTrace(text)).snapshot()).toEqual(engine.snapshot())
    expect(() => parseOwnedMissionTrace(JSON.stringify({ ...trace, version: 2 }))).toThrow()
    const replayed = await command(['missions:replay', path]).withTimeout(60000)
    expect(replayed.exitCode).toBe(0)
    expect(JSON.parse(replayed.stdout)).toMatchObject({ state: 'blocked', reason: 'estimator-loss', rows: 2, physicalFlightEnabled: false })
    expect(await readFile(path, 'utf8')).toBe(text)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
