import { types as nodeTypes } from 'node:util'
import type { AuthorityState } from '../authority/supervisor'
import { authorityStates } from '../authority/supervisor'
import type { EstimatorSnapshot } from '../estimation/estimator'
import type { SensorVector } from '../sensors/types'
import type { GeodeticOrigin } from '../estimation/frames'
import { validVector } from '../controls/model'
import type { MissionPlan, MissionTask, ReadinessMissionPlan, ReadinessMissionTask } from './plan'
import { validateMission, validateReadinessMission } from './plan'

export type MissionAction = 'start' | 'pause' | 'resume' | 'abort' | 'recover'
export type MissionState = 'ready' | 'running' | 'paused' | 'completed' | 'aborted' | 'blocked'
export interface MissionObservation {
  kind: 'simulation'
  nowMs: number
  reference: string
  origin: GeodeticOrigin
  healthy: boolean
  positionM: SensorVector
  velocityMps: SensorVector
  authority: AuthorityState
  batteryPercent: number
  onGround: boolean
}
export interface MissionSnapshot {
  version: 1
  evidence: 'owned-mission-simulation'
  physicalFlightEnabled: false
  state: MissionState
  taskId: string
  targetM: SensorVector | null
  payload: { taskId: string, channel: 'camera-still' } | null
  reason: string
  elapsedMs: number
}
export interface MissionTraceRow { observation: MissionObservation, action: MissionAction | null, result: MissionSnapshot }
export interface MissionTrace { version: 1, evidence: 'owned-mission-simulation', plan: MissionPlan, rows: MissionTraceRow[] }
export const missionLimits = Object.freeze({ rows: 6001, bytes: 8 * 1024 * 1024, schedulerGapMs: 40, acceptanceM: 0.2, settleMs: 500 })
const sameOrigin = (a: GeodeticOrigin, b: GeodeticOrigin) => a?.latitudeDeg === b.latitudeDeg && a?.longitudeDeg === b.longitudeDeg && a?.ellipsoidHeightM === b.ellipsoidHeightM
const exactKeys = (o: object, fields: string[]) => Object.keys(o).length === fields.length && Object.keys(o).every(k => fields.includes(k))
const active = (s: MissionState) => s === 'running' || s === 'paused'
/** Normalize the actual estimator contract. No plant position is supplied to the mission policy. */
export function observeMission(input: { estimate: EstimatorSnapshot, authority: AuthorityState, batteryPercent: number, onGround: boolean }, altitudeDatum: 'WGS84_ELLIPSOID' | 'LOCAL_WATER_SURFACE' = 'WGS84_ELLIPSOID'): MissionObservation {
  const e = input.estimate
  const p = e.localPosition
  const a = e.attitude
  const fresh = (at: number | null | undefined, limit: number) => at !== null && at !== undefined && Number.isFinite(at) && at <= e.nowMs && e.nowMs - at <= limit
  return {
    kind: 'simulation', nowMs: e.nowMs, reference: `${e.bootId}:${Object.values(e.resets).join(',')}`, origin: p?.origin ?? { latitudeDeg: NaN, longitudeDeg: NaN, ellipsoidHeightM: NaN },
    healthy: e.evidence === 'fixture' && e.physicalFlightEnabled === false && e.health.tilt && e.health.localPosition && !!a && a.reference === 'GRAVITY_ALIGNED_RELATIVE_YAW' && p?.frame === 'LOCAL_NED' && p.altitudeDatum === altitudeDatum && fresh(a.capturedAtMs, 60) && fresh(p.capturedAtMs, 200) && fresh(p.predictedToMs, 40),
    positionM: p ? [...p.positionM] as SensorVector : [NaN, NaN, NaN], velocityMps: p ? [...p.velocityMps] as SensorVector : [NaN, NaN, NaN], authority: input.authority, batteryPercent: input.batteryPercent, onGround: input.onGround,
  }
}
type PolicyTask = MissionTask | ReadinessMissionTask
type PolicyPlan = Omit<MissionPlan, 'version' | 'tasks'> & { tasks: PolicyTask[] }
type PolicyReason = ReadinessMissionReason | 'operator-pause' | 'operator-resume' | 'checkpoint-recovered-awaiting-resume'
interface PolicyState { state: MissionState, taskId: string, lastNow: number | null, startedAt: number | null, taskEnteredAt: number | null, reference: string | null, taskElapsedMs: number, settledMs: number, holdM: SensorVector | null, targetM: SensorVector | null, payload: MissionSnapshot['payload'], reason: PolicyReason }
function initialPolicy(plan: PolicyPlan): PolicyState { return { state: 'ready', taskId: plan.start, lastNow: null, startedAt: null, taskEnteredAt: null, reference: null, taskElapsedMs: 0, settledMs: 0, holdM: null, targetM: null, payload: null, reason: 'awaiting-operator-start' } }
function blockedPolicy(s: PolicyState, reason: PolicyReason): PolicyState { return { ...s, state: 'blocked', reason, targetM: null, payload: null } }
function policyContains(plan: PolicyPlan, p: SensorVector) {
  return Math.hypot(p[0], p[1]) <= plan.fence.radiusM && p[2] >= plan.fence.minDownM && p[2] <= 0
}
function policyTarget(plan: PolicyPlan, task: PolicyTask): SensorVector | null { return task.kind === 'return' ? [...plan.rallyM] : 'positionM' in task ? [...task.positionM] : null }
/** One pure finite transition; wrappers own validation, capacity and versioned projection. */
function transitionPolicy(plan: PolicyPlan, worstCaseMs: number, previous: PolicyState, o: MissionObservation, action: MissionAction | undefined, readiness: ReadinessMissionWire): PolicyState {
  let { state, taskId, lastNow, startedAt, taskEnteredAt, reference, taskElapsedMs, settledMs, holdM, targetM, payload, reason } = structuredClone(previous)
  const tasks = new Map(plan.tasks.map(t => [t.id, t]))
  function block(why: PolicyReason) { state = 'blocked'; reason = why; targetM = null; payload = null }
  function advance(next: string) { taskId = next; taskElapsedMs = 0; settledMs = 0; taskEnteredAt = o.nowMs; reason = 'task-entered' }
  const dt = lastNow === null ? 0 : o.nowMs - lastNow
  const previousState = state
  lastNow = o.nowMs; payload = null
  if (active(state)) {
    if (dt > missionLimits.schedulerGapMs && action !== 'recover') block('mission-schedule-gap')
    else if (reference !== o.reference) block('estimator-reference-changed')
    else if (!o.healthy) block('estimator-loss')
    else if (!policyContains(plan, o.positionM)) block('mission-fence-breach')
    else if (o.authority !== 'autonomous') block('authority-revoked')
    else if (o.batteryPercent <= plan.power.reservePercent) block('mission-battery-reserve')
    else if (o.nowMs - startedAt! > worstCaseMs || plan.power.hoverW * (o.nowMs - startedAt!) / 3600000 > plan.power.availableWh * (1 - plan.power.reservePercent / 100)) block('mission-endurance-exhausted')
  }
  if (action === 'abort' && (active(state) || state === 'ready')) { state = 'aborted'; reason = 'operator-abort'; targetM = null }
  else if (action === 'start' && state === 'ready') {
    const takeoff = policyTarget(plan, tasks.get(taskId)!)!
    const neededPercent = plan.power.reservePercent + 100 * plan.power.hoverW * worstCaseMs / 3600000 / plan.power.availableWh
    if (!o.healthy || o.authority !== 'autonomous' || !o.onGround || !policyContains(plan, o.positionM) || Math.hypot(o.positionM[0] - takeoff[0], o.positionM[1] - takeoff[1]) > missionLimits.acceptanceM || Math.abs(o.positionM[2]) > 0.2 || o.batteryPercent < neededPercent) block('mission-start-interlocks')
    else { state = 'running'; startedAt = o.nowMs; taskEnteredAt = o.nowMs; reference = o.reference; holdM = [...o.positionM]; targetM = [...o.positionM]; reason = 'operator-start' }
  }
  else if ((action === 'pause' && state === 'running') || (action === 'recover' && active(state))) { state = 'paused'; holdM = [...o.positionM]; settledMs = 0; reason = action === 'recover' ? 'checkpoint-recovered-awaiting-resume' : 'operator-pause' }
  else if (action === 'resume' && state === 'paused') { state = 'running'; settledMs = 0; reason = 'operator-resume' }
  if (state === 'paused') targetM = holdM ? [...holdM] : null
  if (state === 'running') {
    const t = tasks.get(taskId)!
    const executionDt = previousState === 'ready' || previousState === 'paused' ? 0 : dt
    taskElapsedMs += executionDt
    if ('timeoutMs' in t && taskElapsedMs >= t.timeoutMs) block('task-timeout')
    else if (t.kind === 'readiness-loiter' && readiness === 'invalid') block('invalid-readiness-release')
    else if (t.kind === 'abort') { state = 'aborted'; targetM = null; reason = 'mission-abort-task' }
    else if (t.kind === 'branch') { advance(o.batteryPercent >= t.batteryAtLeast ? t.then : t.otherwise); reason = 'battery-branch' }
    else if (t.kind === 'payload') { payload = { taskId: t.id, channel: t.channel }; advance(t.next); reason = 'simulated-payload-trigger' }
    else {
      const goal = policyTarget(plan, t)!
      const previous = targetM ?? o.positionM
      const distance = Math.hypot(...goal.map((n, i) => n - previous[i]!))
      const scale = distance === 0 ? 1 : Math.min(1, (plan.speedMps ?? 0.6) * executionDt / 1000 / distance)
      targetM = goal.map((n, i) => previous[i]! + (n - previous[i]!) * scale) as SensorVector
      const reached = Math.hypot(...o.positionM.map((n, i) => n - goal[i]!)) <= missionLimits.acceptanceM && Math.hypot(...o.velocityMps) < 0.3 && (t.kind !== 'land' || o.onGround)
      settledMs = reached ? settledMs + executionDt : 0
      if (settledMs >= (t.kind === 'loiter' || t.kind === 'readiness-loiter' ? t.durationMs : missionLimits.settleMs) && (t.kind !== 'readiness-loiter' || readiness !== null && readiness !== 'invalid' && readiness.ready && readiness.planId === plan.id && readiness.runStartedAtMs === startedAt && readiness.taskId === taskId && readiness.taskEnteredAtMs === taskEnteredAt && readiness.sourceId === t.sourceId && readiness.reference === reference && readiness.observedAtMs === o.nowMs)) {
        holdM = [...goal]
        if (t.kind === 'land') { state = 'completed'; targetM = null; reason = 'landed' }
        else advance(t.next!)
      }
    }
  }

  return { state, taskId, lastNow, startedAt, taskEnteredAt, reference, taskElapsedMs, settledMs, holdM, targetM, payload, reason }
}
function legacySnapshot(s: PolicyState): MissionSnapshot { return { version: 1, evidence: 'owned-mission-simulation', physicalFlightEnabled: false, state: s.state, taskId: s.taskId, targetM: s.targetM ? [...s.targetM] : null, payload: s.payload ? { ...s.payload } : null, reason: s.reason, elapsedMs: s.startedAt === null || s.lastNow === null ? 0 : s.lastNow - s.startedAt } }
/** Pure simulation policy. Authority owns arming, leases, output gating and revocation. */
export function createMissionEngine(input: unknown) {
  const { plan, worstCaseMs } = validateMission(input)
  let current = initialPolicy(plan)
  const rows: MissionTraceRow[] = []
  function snapshot(): MissionSnapshot { return legacySnapshot(current) }
  return {
    snapshot,
    trace(): MissionTrace { return structuredClone({ version: 1, evidence: 'owned-mission-simulation', plan, rows }) },
    step(observation: MissionObservation, action?: MissionAction): MissionSnapshot {
      if (rows.length >= missionLimits.rows) { current = blockedPolicy(current, 'mission-trace-capacity'); throw new RangeError('Mission trace capacity exhausted') }
      const o = structuredClone(observation)
      if (!o || !exactKeys(o, ['kind', 'nowMs', 'reference', 'origin', 'healthy', 'positionM', 'velocityMps', 'authority', 'batteryPercent', 'onGround']) || !o.origin || !exactKeys(o.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM']) || o.kind !== 'simulation' || !Number.isSafeInteger(o.nowMs) || o.nowMs < 0 || (current.lastNow !== null && o.nowMs <= current.lastNow) || typeof o.reference !== 'string' || o.reference.length > 120 || !/^[1-9][0-9]{0,19}:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(o.reference)
        || !validVector(o.positionM) || !validVector(o.velocityMps) || !sameOrigin(o.origin, plan.origin) || typeof o.healthy !== 'boolean' || typeof o.onGround !== 'boolean' || !authorityStates.includes(o.authority) || !Number.isFinite(o.batteryPercent) || o.batteryPercent < 0 || o.batteryPercent > 100
        || (action !== undefined && !['start', 'pause', 'resume', 'abort', 'recover'].includes(action))) { current = blockedPolicy(current, 'invalid-observation-or-clock'); throw new TypeError('Invalid mission observation or clock') }
      current = transitionPolicy(plan, worstCaseMs, current, o, action, null)
      const result = snapshot()
      rows.push({ observation: o, action: action ?? null, result: structuredClone(result) })
      return result
    },
  }
}
export type MissionEngine = ReturnType<typeof createMissionEngine>
/** Recompute all decisions, including payload identities and branch choices. Never opens a transport. */
export function replayMission(trace: MissionTrace): MissionEngine {
  if (!trace || trace.version !== 1 || trace.evidence !== 'owned-mission-simulation' || !Array.isArray(trace.rows) || trace.rows.length > missionLimits.rows) throw new TypeError('Invalid mission trace')
  const engine = createMissionEngine(trace.plan)
  for (const row of trace.rows) {
    if (!row || (row.action !== null && !['start', 'pause', 'resume', 'abort', 'recover'].includes(row.action))) throw new TypeError('Invalid mission trace row')
    const result = engine.step(row.observation, row.action ?? undefined)
    if (JSON.stringify(result) !== JSON.stringify(row.result)) throw new TypeError('Mission trace decision mismatch')
  }
  return engine
}
export function parseMissionTrace(text: string): MissionTrace {
  if (new TextEncoder().encode(text).length > missionLimits.bytes) throw new RangeError('Mission trace exceeds 8 MiB')
  let trace: MissionTrace
  try { trace = JSON.parse(text) }
  catch { throw new TypeError('Invalid mission trace JSON') }
  return replayMission(trace).trace()
}
/** Extract an exact active decision prefix after verifying the entire source recording. */
export function checkpointMission(trace: MissionTrace, atMs: number): MissionTrace {
  const verified = replayMission(trace).trace()
  if (!Number.isSafeInteger(atMs) || atMs < 0 || !verified.rows.some(row => row.observation.nowMs === atMs)) throw new RangeError('Checkpoint epoch must match a recorded observation')
  verified.rows = verified.rows.filter(row => row.observation.nowMs <= atMs)
  if (!active(replayMission(verified).snapshot().state)) throw new TypeError('Mission checkpoint is not resumable')
  return verified
}
/** Recovery verifies a prefix and requires a new operator resume on a fresh compatible observation. */
export function recoverMission(trace: MissionTrace, observation: MissionObservation): MissionEngine {
  const engine = replayMission(trace)
  if (!['running', 'paused'].includes(engine.snapshot().state)) throw new TypeError('Mission checkpoint is not resumable')
  const result = engine.step(observation, 'recover')
  if (result.state !== 'paused') throw new TypeError('Mission checkpoint reference or authority is no longer valid')
  return engine
}
/** Explicit operator resume. A scheduling outage requires recovery first, then a fresh resume epoch. */
export function resumeMission(trace: MissionTrace, observation: MissionObservation): MissionEngine {
  const engine = replayMission(trace)
  if (engine.snapshot().state !== 'paused') throw new TypeError('Mission resume requires a paused checkpoint')
  const result = engine.step(observation, 'resume')
  const plannedAbort = result.state === 'aborted' && result.reason === 'mission-abort-task'
  if (result.state !== 'running' && !plannedAbort) throw new TypeError(`Mission resume rejected: ${result.reason}`)
  return engine
}

export type ReadinessMissionAction = 'start' | 'abort'
export interface ReadinessMissionObservation { kind: 'simulation', nowMs: number, reference: string, origin: GeodeticOrigin, healthy: boolean, positionM: SensorVector, velocityMps: SensorVector, authority: AuthorityState, batteryPercent: number, onGround: boolean }
export interface ReadinessMissionDeclaration { version: 1, planId: string, runStartedAtMs: number, taskId: string, taskEnteredAtMs: number, sourceId: string, reference: string, observedAtMs: number, ready: boolean }
export type ReadinessMissionWire = null | 'invalid' | ReadinessMissionDeclaration
const readinessReasons = ['awaiting-operator-start', 'operator-start', 'task-entered', 'battery-branch', 'simulated-payload-trigger', 'mission-abort-task', 'landed', 'mission-schedule-gap', 'estimator-reference-changed', 'estimator-loss', 'mission-fence-breach', 'authority-revoked', 'mission-battery-reserve', 'mission-endurance-exhausted', 'invalid-observation-or-clock', 'mission-start-interlocks', 'task-timeout', 'invalid-readiness-release', 'mission-trace-capacity', 'operator-abort'] as const
export type ReadinessMissionReason = typeof readinessReasons[number]
export interface ReadinessMissionSnapshot { version: 3, evidence: 'owned-readiness-mission-simulation', physicalFlightEnabled: false, state: Exclude<MissionState, 'paused'>, taskId: string, targetM: SensorVector | null, payload: MissionSnapshot['payload'], reason: ReadinessMissionReason, elapsedMs: number, runStartedAtMs: number | null, taskEnteredAtMs: number | null }
export interface ReadinessMissionTraceRow { observation: ReadinessMissionObservation, action: ReadinessMissionAction | null, readiness: ReadinessMissionWire, result: ReadinessMissionSnapshot }
export interface ReadinessMissionTrace { version: 3, evidence: 'owned-readiness-mission-simulation', plan: ReadinessMissionPlan, rows: ReadinessMissionTraceRow[] }
function readinessInvalid(): never { throw new TypeError('Invalid readiness mission trace') }
function readinessData(value: unknown, fields: string[], canonical = false): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return readinessInvalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length || keys.some((k, i) => typeof k !== 'string' || (canonical ? k !== fields[i] : !fields.includes(k)))) return readinessInvalid()
  const ds = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = {}
  for (const key of fields) { const d = ds[key]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) return readinessInvalid(); out[key] = d.value }
  return out
}
function readinessArray(value: unknown, maximum: number): unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return readinessInvalid()
  const ds = Object.getOwnPropertyDescriptors(value), out: unknown[] = []
  for (let i = 0; i < value.length; i++) { const d = ds[i]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) return readinessInvalid(); out.push(d.value) }
  return out
}
function readinessNumber(value: unknown, min = -1e6, max = 1e6): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || JSON.stringify(value).length > 32) return readinessInvalid(); return value }
function readinessEpoch(value: unknown): number { const n = readinessNumber(value, 0, 45000); if (!Number.isSafeInteger(n)) return readinessInvalid(); return n }
function readinessId(value: unknown): string { if (typeof value !== 'string' || value.length > 40 || !/^[a-z][a-z0-9-]{0,39}$/.test(value)) return readinessInvalid(); return value }
function readinessReference(value: unknown): string { if (typeof value !== 'string' || value.length > 120 || !/^[1-9][0-9]{0,19}:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(value)) return readinessInvalid(); return value }
function readinessBoolean(value: unknown): boolean { if (typeof value !== 'boolean') return readinessInvalid(); return value }
function readinessVector(value: unknown): SensorVector { const a = readinessArray(value, 3); if (a.length !== 3) return readinessInvalid(); return [readinessNumber(a[0]), readinessNumber(a[1]), readinessNumber(a[2])] }
function captureReadinessObservation(value: unknown, canonical = false): ReadinessMissionObservation {
  const d = readinessData(value, ['kind', 'nowMs', 'reference', 'origin', 'healthy', 'positionM', 'velocityMps', 'authority', 'batteryPercent', 'onGround'], canonical)
  if (d.kind !== 'simulation') return readinessInvalid()
  const o = readinessData(d.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM'], canonical)
  const authority = authorityStates.find(s => s === d.authority)
  if (!authority) return readinessInvalid()
  return { kind: 'simulation', nowMs: readinessEpoch(d.nowMs), reference: readinessReference(d.reference), origin: { latitudeDeg: readinessNumber(o.latitudeDeg, -90, 90), longitudeDeg: readinessNumber(o.longitudeDeg, -180, 180), ellipsoidHeightM: readinessNumber(o.ellipsoidHeightM, -500, 10000) }, healthy: readinessBoolean(d.healthy), positionM: readinessVector(d.positionM), velocityMps: readinessVector(d.velocityMps), authority, batteryPercent: readinessNumber(d.batteryPercent, 0, 100), onGround: readinessBoolean(d.onGround) }
}
function captureReadiness(value: unknown, canonical = false): ReadinessMissionWire {
  if (value === null || value === undefined && !canonical) return null
  if (value === 'invalid') return 'invalid'
  try {
    const d = readinessData(value, ['version', 'planId', 'runStartedAtMs', 'taskId', 'taskEnteredAtMs', 'sourceId', 'reference', 'observedAtMs', 'ready'], canonical)
    if (d.version !== 1) return readinessInvalid()
    return { version: 1, planId: readinessId(d.planId), runStartedAtMs: readinessEpoch(d.runStartedAtMs), taskId: readinessId(d.taskId), taskEnteredAtMs: readinessEpoch(d.taskEnteredAtMs), sourceId: readinessId(d.sourceId), reference: readinessReference(d.reference), observedAtMs: readinessEpoch(d.observedAtMs), ready: readinessBoolean(d.ready) }
  }
  catch { if (canonical) return readinessInvalid(); return 'invalid' }
}
function readinessSnapshot(s: PolicyState): ReadinessMissionSnapshot {
  const reason = readinessReasons.find(r => r === s.reason)
  if (!reason || s.state === 'paused') return readinessInvalid()
  return { version: 3, evidence: 'owned-readiness-mission-simulation', physicalFlightEnabled: false, state: s.state, taskId: s.taskId, targetM: s.targetM ? [...s.targetM] : null, payload: s.payload ? { ...s.payload } : null, reason, elapsedMs: s.startedAt === null || s.lastNow === null ? 0 : s.lastNow - s.startedAt, runStartedAtMs: s.startedAt, taskEnteredAtMs: s.taskEnteredAt }
}
const readinessBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
/** Concrete v3 wrapper: preview/encode before committing any accepted policy state. */
export function createReadinessMissionEngine(input: unknown) {
  const { plan, worstCaseMs } = validateReadinessMission(input)
  let current = initialPolicy(plan), poison: TypeError | RangeError | null = null
  const rows: ReadinessMissionTraceRow[] = []
  let encodedBytes = readinessBytes({ version: 3, evidence: 'owned-readiness-mission-simulation', plan, rows: [] }) + 1
  function snapshot(): ReadinessMissionSnapshot { return readinessSnapshot(current) }
  function unavailable(kind: 'invalid' | 'capacity'): never {
    poison = kind === 'invalid' ? new TypeError('Invalid readiness mission observation or action') : new RangeError('Readiness mission trace capacity exhausted')
    current = blockedPolicy(current, kind === 'invalid' ? 'invalid-observation-or-clock' : 'mission-trace-capacity')
    throw poison
  }
  return {
    snapshot,
    trace(): ReadinessMissionTrace {
      const out: ReadinessMissionTrace = { version: 3, evidence: 'owned-readiness-mission-simulation', plan: structuredClone(plan), rows: structuredClone(rows) }
      if (readinessBytes(out) + 1 !== encodedBytes || encodedBytes > missionLimits.bytes) throw new RangeError('Readiness mission trace capacity exhausted')
      return out
    },
    step(observation: ReadinessMissionObservation, action?: ReadinessMissionAction, readiness?: unknown): ReadinessMissionSnapshot {
      if (poison) throw poison
      if (rows.length >= missionLimits.rows) return unavailable('capacity')
      let o: ReadinessMissionObservation
      try {
        o = captureReadinessObservation(observation)
        if (current.lastNow !== null && o.nowMs <= current.lastNow || !sameOrigin(o.origin, plan.origin) || action !== undefined && action !== 'start' && action !== 'abort') return unavailable('invalid')
      }
      catch { if (poison) throw poison; return unavailable('invalid') }
      const release = captureReadiness(readiness), next = transitionPolicy(plan, worstCaseMs, current, o, action, release), result = readinessSnapshot(next)
      const row: ReadinessMissionTraceRow = { observation: o, action: action ?? null, readiness: release, result }
      const rowBytes = readinessBytes(row), addition = rowBytes + (rows.length ? 1 : 0)
      if (rowBytes > 2048 || addition > missionLimits.bytes - encodedBytes) return unavailable('capacity')
      current = next; rows.push(row); encodedBytes += addition
      return structuredClone(result)
    },
  }
}
export type ReadinessMissionEngine = ReturnType<typeof createReadinessMissionEngine>
/** Assert order only after bounded semantic capture; no serialization of untrusted objects. */
function readinessOrder(value: unknown, template: unknown): void {
  if (template === null || typeof template !== 'object') return
  if (Array.isArray(template)) {
    const a = readinessArray(value, template.length)
    if (a.length !== template.length) return readinessInvalid()
    for (let i = 0; i < a.length; i++) readinessOrder(a[i], template[i])
    return
  }
  const d = readinessData(value, Object.keys(template), true), ds = Object.getOwnPropertyDescriptors(template)
  for (const key of Object.keys(ds)) if (ds[key]!.value !== null && typeof ds[key]!.value === 'object') readinessOrder(d[key], ds[key]!.value)
}
function captureReadinessSnapshot(value: unknown): ReadinessMissionSnapshot {
  const d = readinessData(value, ['version', 'evidence', 'physicalFlightEnabled', 'state', 'taskId', 'targetM', 'payload', 'reason', 'elapsedMs', 'runStartedAtMs', 'taskEnteredAtMs'], true)
  if (d.version !== 3 || d.evidence !== 'owned-readiness-mission-simulation' || d.physicalFlightEnabled !== false) return readinessInvalid()
  const state = (['ready', 'running', 'completed', 'aborted', 'blocked'] as const).find(s => s === d.state), reason = readinessReasons.find(r => r === d.reason)
  if (!state || !reason) return readinessInvalid()
  let payload: ReadinessMissionSnapshot['payload'] = null
  if (d.payload !== null) { const p = readinessData(d.payload, ['taskId', 'channel'], true); if (p.channel !== 'camera-still') return readinessInvalid(); payload = { taskId: readinessId(p.taskId), channel: 'camera-still' } }
  return { version: 3, evidence: 'owned-readiness-mission-simulation', physicalFlightEnabled: false, state, taskId: readinessId(d.taskId), targetM: d.targetM === null ? null : readinessVector(d.targetM), payload, reason, elapsedMs: readinessEpoch(d.elapsedMs), runStartedAtMs: d.runStartedAtMs === null ? null : readinessEpoch(d.runStartedAtMs), taskEnteredAtMs: d.taskEnteredAtMs === null ? null : readinessEpoch(d.taskEnteredAtMs) }
}
/** Replay checks canonical data first, then recomputes every actual decision. Unsigned evidence. */
export function replayReadinessMission(input: unknown): ReadinessMissionEngine {
  let trace: ReadinessMissionTrace
  try {
    const d = readinessData(input, ['version', 'evidence', 'plan', 'rows'], true)
    if (d.version !== 3 || d.evidence !== 'owned-readiness-mission-simulation') return readinessInvalid()
    const plan = validateReadinessMission(d.plan).plan; readinessOrder(d.plan, plan)
    const rows = readinessArray(d.rows, missionLimits.rows).map((value): ReadinessMissionTraceRow => {
      const r = readinessData(value, ['observation', 'action', 'readiness', 'result'], true)
      if (r.action !== null && r.action !== 'start' && r.action !== 'abort') return readinessInvalid()
      return { observation: captureReadinessObservation(r.observation, true), action: r.action, readiness: captureReadiness(r.readiness, true), result: captureReadinessSnapshot(r.result) }
    })
    trace = { version: 3, evidence: 'owned-readiness-mission-simulation', plan, rows }
    if (trace.rows.some(r => readinessBytes(r) > 2048) || readinessBytes(trace) + 1 > missionLimits.bytes) throw new RangeError('Readiness mission trace exceeds 8 MiB')
  }
  catch (error) { if (error instanceof RangeError && error.message === 'Readiness mission trace exceeds 8 MiB') throw error; return readinessInvalid() }
  const engine = createReadinessMissionEngine(trace.plan)
  for (const row of trace.rows) {
    let result: ReadinessMissionSnapshot
    try { result = engine.step(row.observation, row.action ?? undefined, row.readiness) }
    catch { return readinessInvalid() }
    if (JSON.stringify(result) !== JSON.stringify(row.result)) throw new TypeError('Readiness mission trace decision mismatch')
  }
  return engine
}
export function parseReadinessMissionTrace(text: string): ReadinessMissionTrace {
  if (typeof text !== 'string') return readinessInvalid()
  if (new TextEncoder().encode(text).length > missionLimits.bytes) throw new RangeError('Readiness mission trace exceeds 8 MiB')
  let value: unknown
  try { value = JSON.parse(text) }
  catch { return readinessInvalid() }
  return replayReadinessMission(value).trace()
}
