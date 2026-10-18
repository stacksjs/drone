import type { AuthorityState } from '../authority/supervisor'
import { authorityStates } from '../authority/supervisor'
import type { EstimatorSnapshot } from '../estimation/estimator'
import type { SensorVector } from '../sensors/types'
import type { GeodeticOrigin } from '../estimation/frames'
import { validVector } from '../controls/model'
import type { MissionPlan } from './plan'
import { missionContains, missionTaskTarget, validateMission } from './plan'

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
/** Pure simulation policy. Authority owns arming, leases, output gating and revocation. */
export function createMissionEngine(input: unknown) {
  const { plan, worstCaseMs } = validateMission(input)
  const tasks = new Map(plan.tasks.map(t => [t.id, t]))
  let state: MissionState = 'ready'
  let taskId = plan.start
  let lastNow: number | null = null
  let startedAt: number | null = null
  let reference: string | null = null
  let taskElapsedMs = 0
  let settledMs = 0
  let holdM: SensorVector | null = null
  let targetM: SensorVector | null = null
  let payload: MissionSnapshot['payload'] = null
  let reason = 'awaiting-operator-start'
  const rows: MissionTraceRow[] = []
  function snapshot(): MissionSnapshot {
    return { version: 1, evidence: 'owned-mission-simulation', physicalFlightEnabled: false, state, taskId, targetM: targetM ? [...targetM] : null, payload: payload ? { ...payload } : null, reason, elapsedMs: startedAt === null || lastNow === null ? 0 : lastNow - startedAt }
  }
  function block(why: string) { state = 'blocked'; reason = why; targetM = null; payload = null }
  function advance(next: string) { taskId = next; taskElapsedMs = 0; settledMs = 0; reason = 'task-entered' }
  return {
    snapshot,
    trace(): MissionTrace { return structuredClone({ version: 1, evidence: 'owned-mission-simulation', plan, rows }) },
    step(observation: MissionObservation, action?: MissionAction): MissionSnapshot {
      if (rows.length >= missionLimits.rows) { block('mission-trace-capacity'); throw new RangeError('Mission trace capacity exhausted') }
      const o = structuredClone(observation)
      if (!o || !exactKeys(o, ['kind', 'nowMs', 'reference', 'origin', 'healthy', 'positionM', 'velocityMps', 'authority', 'batteryPercent', 'onGround']) || !o.origin || !exactKeys(o.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM']) || o.kind !== 'simulation' || !Number.isSafeInteger(o.nowMs) || o.nowMs < 0 || (lastNow !== null && o.nowMs <= lastNow) || typeof o.reference !== 'string' || o.reference.length > 120 || !/^[1-9][0-9]{0,19}:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(o.reference)
        || !validVector(o.positionM) || !validVector(o.velocityMps) || !sameOrigin(o.origin, plan.origin) || typeof o.healthy !== 'boolean' || typeof o.onGround !== 'boolean' || !authorityStates.includes(o.authority) || !Number.isFinite(o.batteryPercent) || o.batteryPercent < 0 || o.batteryPercent > 100
        || (action !== undefined && !['start', 'pause', 'resume', 'abort', 'recover'].includes(action))) { block('invalid-observation-or-clock'); throw new TypeError('Invalid mission observation or clock') }
      const dt = lastNow === null ? 0 : o.nowMs - lastNow
      const previousState = state
      lastNow = o.nowMs; payload = null
      if (active(state)) {
        if (dt > missionLimits.schedulerGapMs && action !== 'recover') block('mission-schedule-gap')
        else if (reference !== o.reference) block('estimator-reference-changed')
        else if (!o.healthy) block('estimator-loss')
        else if (!missionContains(plan, o.positionM)) block('mission-fence-breach')
        else if (o.authority !== 'autonomous') block('authority-revoked')
        else if (o.batteryPercent <= plan.power.reservePercent) block('mission-battery-reserve')
        else if (o.nowMs - startedAt! > worstCaseMs || plan.power.hoverW * (o.nowMs - startedAt!) / 3600000 > plan.power.availableWh * (1 - plan.power.reservePercent / 100)) block('mission-endurance-exhausted')
      }
      if (action === 'abort' && (active(state) || state === 'ready')) { state = 'aborted'; reason = 'operator-abort'; targetM = null }
      else if (action === 'start' && state === 'ready') {
        const takeoff = missionTaskTarget(plan, tasks.get(taskId)!)!
        const neededPercent = plan.power.reservePercent + 100 * plan.power.hoverW * worstCaseMs / 3600000 / plan.power.availableWh
        if (!o.healthy || o.authority !== 'autonomous' || !o.onGround || !missionContains(plan, o.positionM) || Math.hypot(o.positionM[0] - takeoff[0], o.positionM[1] - takeoff[1]) > missionLimits.acceptanceM || Math.abs(o.positionM[2]) > 0.2 || o.batteryPercent < neededPercent) block('mission-start-interlocks')
        else { state = 'running'; startedAt = o.nowMs; reference = o.reference; holdM = [...o.positionM]; targetM = [...o.positionM]; reason = 'operator-start' }
      }
      else if ((action === 'pause' && state === 'running') || (action === 'recover' && active(state))) { state = 'paused'; holdM = [...o.positionM]; settledMs = 0; reason = action === 'recover' ? 'checkpoint-recovered-awaiting-resume' : 'operator-pause' }
      else if (action === 'resume' && state === 'paused') { state = 'running'; settledMs = 0; reason = 'operator-resume' }
      if (state === 'paused') targetM = holdM ? [...holdM] : null
      if (state === 'running') {
        const t = tasks.get(taskId)!
        const executionDt = previousState === 'ready' || previousState === 'paused' ? 0 : dt
        taskElapsedMs += executionDt
        if ('timeoutMs' in t && taskElapsedMs >= t.timeoutMs) block('task-timeout')
        else if (t.kind === 'abort') { state = 'aborted'; targetM = null; reason = 'mission-abort-task' }
        else if (t.kind === 'branch') { advance(o.batteryPercent >= t.batteryAtLeast ? t.then : t.otherwise); reason = 'battery-branch' }
        else if (t.kind === 'payload') { payload = { taskId: t.id, channel: t.channel }; advance(t.next); reason = 'simulated-payload-trigger' }
        else {
          const goal = missionTaskTarget(plan, t)!
          const previous = targetM ?? o.positionM
          const distance = Math.hypot(...goal.map((n, i) => n - previous[i]!))
          const scale = distance === 0 ? 1 : Math.min(1, (plan.speedMps ?? 0.6) * executionDt / 1000 / distance)
          targetM = goal.map((n, i) => previous[i]! + (n - previous[i]!) * scale) as SensorVector
          const reached = Math.hypot(...o.positionM.map((n, i) => n - goal[i]!)) <= missionLimits.acceptanceM && Math.hypot(...o.velocityMps) < 0.3 && (t.kind !== 'land' || o.onGround)
          settledMs = reached ? settledMs + executionDt : 0
          if (settledMs >= (t.kind === 'loiter' ? t.durationMs : missionLimits.settleMs)) {
            holdM = [...goal]
            if (t.kind === 'land') { state = 'completed'; targetM = null; reason = 'landed' }
            else advance(t.next!)
          }
        }
      }
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
/** Recovery verifies a prefix and requires a new operator resume on a fresh compatible observation. */
export function recoverMission(trace: MissionTrace, observation: MissionObservation): MissionEngine {
  const engine = replayMission(trace)
  if (!['running', 'paused'].includes(engine.snapshot().state)) throw new TypeError('Mission checkpoint is not resumable')
  const result = engine.step(observation, 'recover')
  if (result.state !== 'paused') throw new TypeError('Mission checkpoint reference or authority is no longer valid')
  return engine
}
