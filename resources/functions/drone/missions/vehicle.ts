import type { VehicleMissionAction, VehicleMissionObservation, VehicleMissionPlan, VehicleMissionSnapshot, VehicleMissionTask, VehiclePayloadAck, VehiclePayloadCommand } from '../vehicles/types'
import type { MissionState } from './engine'
import { authorityStates } from '../authority/supervisor'
import { validVector } from '../controls/model'
import { missionGraphBudget } from './graph'
export const vehicleMissionLimits = Object.freeze({ rows: 9001, bytes: 16 * 1024 * 1024, maximumMs: 180000, scheduleGapMs: 40 })
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v))
const keys = (v: object, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v)
const number = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const active = (s: MissionState) => s === 'running' || s === 'paused'
export function vehicleMissionContains(plan: VehicleMissionPlan, p: unknown) {
  return validVector(p) && Math.hypot(p[0], p[1]) <= plan.fence.radiusM && p[2] >= plan.fence.minDownM && p[2] <= plan.fence.maxDownM
}
export function vehicleTaskTarget(plan: VehicleMissionPlan, task: VehicleMissionTask) { return task.kind === 'return' ? [...plan.rallyM] : 'positionM' in task ? [...task.positionM] : null }
export function validateVehicleMission(input: unknown): { plan: VehicleMissionPlan, worstCaseMs: number, requiredWh: number } {
  const invalid = (): never => { throw new TypeError('Invalid vehicle mission or unsupported profile') }
  if (!object(input) || !keys(input, ['version', 'vehicle', 'id', 'frame', 'altitude', 'terrain', 'origin', 'fence', 'rallyM', 'power', 'start', 'tasks']) || input.version !== 2 || !['fixed-wing', 'ground', 'surface'].includes(input.vehicle as string) || !id(input.id) || input.frame !== 'LOCAL_NED' || input.altitude !== 'ORIGIN_RELATIVE_DOWN' || input.terrain !== 'DECLARED_MODEL_SURFACE' || !id(input.start)) invalid()
  const p = input as unknown as VehicleMissionPlan
  if (!object(p.origin) || !keys(p.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM']) || !number(p.origin.latitudeDeg, -90, 90) || !number(p.origin.longitudeDeg, -180, 180) || !number(p.origin.ellipsoidHeightM, -500, 10000)
    || !object(p.fence) || !keys(p.fence, ['radiusM', 'minDownM', 'maxDownM']) || !number(p.fence.radiusM, 1, 5000) || !number(p.fence.minDownM, -1000, 0) || !number(p.fence.maxDownM, 0, 10) || p.fence.minDownM >= p.fence.maxDownM || !vehicleMissionContains(p, p.rallyM)
    || !object(p.power) || !keys(p.power, ['availableWh', 'maxW', 'reservePercent']) || !number(p.power.availableWh, 0.01, 10000) || !number(p.power.maxW, 1, 100000) || !number(p.power.reservePercent, 26, 80) || !Array.isArray(p.tasks) || p.tasks.length < 2 || p.tasks.length > 32) invalid()
  const nodes: { id: string, durationMs: number, edges: string[] }[] = []
  for (const t of p.tasks) {
    if (!object(t) || !id(t.id)) invalid()
    let fields = ['id', 'kind'], edges: string[] = [], durationMs = 20
    if (t.kind === 'start') { fields.push('next'); if (t.id !== p.start || !id(t.next)) invalid(); edges = [t.next] }
    else if (t.kind === 'abort') { /* Terminal release, never an emergency landing. */ }
    else if (t.kind === 'branch') {
      fields.push('batteryAtLeast', 'then', 'otherwise')
      if (!number(t.batteryAtLeast, p.power.reservePercent + 1, 100) || !id(t.then) || !id(t.otherwise)) invalid()
      edges = [t.then, t.otherwise]
    }
    else if (t.kind === 'payload') {
      fields.push('operation', 'containerId', 'timeoutMs', 'next')
      const supported = p.vehicle === 'fixed-wing' ? ['camera-still'] : p.vehicle === 'ground' ? ['camera-still', 'material-drop', 'mower-enable', 'mower-disable'] : ['camera-still', 'water-sample']
      if (!supported.includes(t.operation) || (t.containerId !== null && !id(t.containerId)) || (t.operation === 'water-sample' && !id(t.containerId)) || !number(t.timeoutMs, 100, 10000) || !id(t.next)) invalid()
      durationMs = t.timeoutMs; edges = [t.next]
    }
    else if (['takeoff', 'waypoint', 'land', 'stop', 'loiter', 'return'].includes(t.kind)) {
      fields = [...fields, 'acceptanceM', 'maxArrivalSpeedMps', 'settleMs', 'timeoutMs', 'next']
      if (t.kind !== 'return') { fields.push('positionM'); if (!vehicleMissionContains(p, (t as { positionM?: unknown }).positionM)) invalid() }
      if (!('acceptanceM' in t) || !number(t.acceptanceM, 0.05, 150) || !number(t.maxArrivalSpeedMps, 0.05, 50) || !number(t.settleMs, 0, 10000) || !number(t.timeoutMs, 1000, 60000) || t.settleMs >= t.timeoutMs) invalid()
      if ((t.kind === 'takeoff' || t.kind === 'land') && p.vehicle !== 'fixed-wing') invalid()
      if (t.kind === 'stop' && (p.vehicle === 'fixed-wing' || t.maxArrivalSpeedMps > 0.5)) invalid()
      if (t.kind === 'land' && t.maxArrivalSpeedMps > 2) invalid()
      const terminal = t.kind === 'land' || t.kind === 'stop'
      if (!terminal && !id(t.next)) invalid()
      if (t.next !== undefined && !id(t.next)) invalid()
      durationMs = t.timeoutMs; edges = t.next === undefined ? [] : [t.next]
    }
    else invalid()
    if (!keys(t, fields)) invalid()
    nodes.push({ id: t.id, durationMs, edges })
  }
  if (p.tasks.find(t => t.id === p.start)?.kind !== 'start') invalid()
  const worstCaseMs = missionGraphBudget(nodes, p.start, vehicleMissionLimits.maximumMs)
  const requiredWh = p.power.maxW * worstCaseMs / 3600000
  if (requiredWh > p.power.availableWh * (1 - p.power.reservePercent / 100)) throw new RangeError('Vehicle mission cannot preserve energy reserve')
  return { plan: structuredClone(p), worstCaseMs, requiredWh }
}
export interface VehicleMissionTrace { version: 2, evidence: 'owned-vehicle-mission-simulation', plan: VehicleMissionPlan, rows: { observation: VehicleMissionObservation, action: VehicleMissionAction | null, result: VehicleMissionSnapshot }[] }
function validAck(value: unknown): value is VehiclePayloadAck {
  if (!object(value) || !keys(value, ['eventId', 'taskId', 'operation', 'containerId', 'capturedAtMs', 'reference', 'positionM', 'outcome', 'metadata']) || typeof value.eventId !== 'string' || value.eventId.length > 200 || !id(value.taskId) || !['camera-still', 'water-sample', 'material-drop', 'mower-enable', 'mower-disable'].includes(value.operation as string) || (value.containerId !== null && !id(value.containerId)) || !Number.isSafeInteger(value.capturedAtMs) || (value.capturedAtMs as number) < 0 || typeof value.reference !== 'string' || value.reference.length > 120 || !validVector(value.positionM) || !['confirmed', 'rejected', 'uncertain'].includes(value.outcome as string)) return false
  if (value.metadata !== undefined && (!object(value.metadata) || Object.keys(value.metadata).length > 32 || Object.entries(value.metadata).some(([key, item]) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(key) || !(typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 160))))) return false
  return true
}
/** V2 mission policy shared by all vehicle profiles. It has no transport or arming capability. */
export function createVehicleMissionEngine(input: unknown) {
  const { plan, worstCaseMs } = validateVehicleMission(input)
  const tasks = new Map(plan.tasks.map(t => [t.id, t]))
  let state: MissionState = 'ready', taskId = plan.start, reason = 'awaiting-operator-start'
  let lastNow: number | null = null, startedAt: number | null = null, reference: string | null = null, taskElapsedMs = 0, settledMs = 0
  let targetM: VehicleMissionSnapshot['targetM'] = null, holdM: VehicleMissionSnapshot['targetM'] = null, pending: VehiclePayloadCommand | null = null
  const rows: VehicleMissionTrace['rows'] = []
  function snapshot(): VehicleMissionSnapshot { return { version: 2, vehicle: plan.vehicle, evidence: 'owned-vehicle-mission-simulation', physicalFlightEnabled: false, state, taskId, taskKind: tasks.get(taskId)!.kind, targetM: targetM ? [...targetM] : null, payload: pending ? structuredClone(pending) : null, reason, elapsedMs: startedAt === null || lastNow === null ? 0 : lastNow - startedAt } }
  function block(why: string) { state = 'blocked'; reason = why; targetM = null; pending = null }
  function advance(next: string) {
    taskId = next; taskElapsedMs = 0; settledMs = 0; pending = null; reason = 'task-entered'
    const task = tasks.get(next)!
    const goal = vehicleTaskTarget(plan, task)
    if (goal) targetM = goal as VehicleMissionSnapshot['targetM']
    if (task.kind === 'abort') { state = 'aborted'; targetM = null; reason = 'mission-abort-task' }
  }
  return {
    snapshot,
    trace(): VehicleMissionTrace { return structuredClone({ version: 2, evidence: 'owned-vehicle-mission-simulation', plan, rows }) },
    step(inputObservation: VehicleMissionObservation, action?: VehicleMissionAction): VehicleMissionSnapshot {
      if (rows.length >= vehicleMissionLimits.rows) { block('mission-trace-capacity'); throw new RangeError('Vehicle mission trace exhausted') }
      const o = structuredClone(inputObservation)
      if (!object(o) || !keys(o, ['kind', 'nowMs', 'reference', 'origin', 'healthy', 'positionM', 'velocityMps', 'authority', 'batteryPercent', 'onGround', 'payloadAck']) || Object.keys(o).length !== 11 || o.kind !== 'simulation' || !Number.isSafeInteger(o.nowMs) || o.nowMs < 0 || (lastNow !== null && o.nowMs <= lastNow) || typeof o.reference !== 'string' || !/^[1-9][0-9]{0,19}:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(o.reference) || !object(o.origin) || !keys(o.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM']) || o.origin.latitudeDeg !== plan.origin.latitudeDeg || o.origin.longitudeDeg !== plan.origin.longitudeDeg || o.origin.ellipsoidHeightM !== plan.origin.ellipsoidHeightM || typeof o.healthy !== 'boolean' || typeof o.onGround !== 'boolean' || !validVector(o.positionM) || !validVector(o.velocityMps) || !authorityStates.includes(o.authority) || !number(o.batteryPercent, 0, 100) || (o.payloadAck !== null && !validAck(o.payloadAck)) || (action !== undefined && !['start', 'pause', 'resume', 'abort', 'recover'].includes(action))) { block('invalid-observation-or-clock'); throw new TypeError('Invalid vehicle mission observation') }
      const dt = lastNow === null ? 0 : o.nowMs - lastNow, previousState = state
      lastNow = o.nowMs
      if (active(state)) {
        if (dt > vehicleMissionLimits.scheduleGapMs && action !== 'recover') block('mission-schedule-gap')
        else if (o.reference !== reference) block('estimator-reference-changed')
        else if (!o.healthy) block('estimator-loss')
        else if (!vehicleMissionContains(plan, o.positionM)) block('mission-fence-breach')
        else if (o.authority !== 'autonomous') block('authority-revoked')
        else if (o.batteryPercent <= plan.power.reservePercent) block('mission-battery-reserve')
        else if (o.nowMs - startedAt! > worstCaseMs) block('mission-endurance-exhausted')
        else if (o.payloadAck !== null && pending === null) block('unsolicited-payload-ack')
      }
      if (action === 'abort' && (active(state) || state === 'ready')) { state = 'aborted'; reason = 'operator-abort'; targetM = null; pending = null }
      else if (action === 'start' && state === 'ready') {
        const needed = plan.power.reservePercent + 100 * plan.power.maxW * worstCaseMs / 3600000 / plan.power.availableWh
        if (!o.healthy || o.authority !== 'autonomous' || !o.onGround || Math.hypot(...o.velocityMps) > 0.1 || !vehicleMissionContains(plan, o.positionM) || o.batteryPercent < needed || o.payloadAck !== null) block('mission-start-interlocks')
        else { state = 'running'; startedAt = o.nowMs; reference = o.reference; holdM = [...o.positionM]; targetM = [...o.positionM]; reason = 'operator-start' }
      }
      else if ((action === 'pause' && state === 'running') || (action === 'recover' && active(state))) {
        if (pending) block('payload-recovery-uncertain')
        else { state = 'paused'; holdM = [...o.positionM]; settledMs = 0; reason = action === 'recover' ? 'checkpoint-recovered-awaiting-resume' : 'operator-pause' }
      }
      else if (action === 'resume' && state === 'paused') { state = 'running'; settledMs = 0; reason = 'operator-resume' }
      if (state === 'paused') targetM = holdM ? [...holdM] : null
      if (state === 'running') {
        const t = tasks.get(taskId)!, executionDt = previousState === 'ready' || previousState === 'paused' ? 0 : dt
        taskElapsedMs += executionDt
        if ('timeoutMs' in t && taskElapsedMs >= t.timeoutMs) block(t.kind === 'payload' ? 'payload-outcome-uncertain' : 'task-timeout')
        else if (t.kind === 'abort') { state = 'aborted'; reason = 'mission-abort-task'; targetM = null }
        else if (t.kind === 'start') advance(t.next)
        else if (t.kind === 'branch') { advance(o.batteryPercent >= t.batteryAtLeast ? t.then : t.otherwise); reason = 'battery-branch' }
        else if (t.kind === 'payload') {
          pending ??= { eventId: `${plan.id}:${reference}:${t.id}`, taskId: t.id, operation: t.operation, containerId: t.containerId, issuedAtMs: o.nowMs, expiresAtMs: o.nowMs + t.timeoutMs - taskElapsedMs, positionM: [...o.positionM], reference: reference! }
          const ack = o.payloadAck
          if (ack) {
            if (ack.eventId !== pending.eventId || ack.taskId !== pending.taskId || ack.operation !== pending.operation || ack.containerId !== pending.containerId || ack.reference !== pending.reference || ack.capturedAtMs < pending.issuedAtMs || ack.capturedAtMs >= pending.expiresAtMs || ack.capturedAtMs > o.nowMs || o.nowMs - ack.capturedAtMs > 200 || Math.hypot(...ack.positionM.map((n, i) => n - pending!.positionM[i]!)) > 1 || ack.outcome !== 'confirmed') block('payload-outcome-uncertain')
            else { advance(t.next); reason = 'payload-confirmed' }
          }
        }
        else {
          const goal = vehicleTaskTarget(plan, t)!
          targetM = goal as VehicleMissionSnapshot['targetM']
          const reached = Math.hypot(...o.positionM.map((n, i) => n - goal[i]!)) <= t.acceptanceM && Math.hypot(...o.velocityMps) <= t.maxArrivalSpeedMps && (!['land', 'stop'].includes(t.kind) || o.onGround)
          settledMs = reached ? settledMs + executionDt : 0
          if (reached && settledMs >= t.settleMs) {
            holdM = [...goal] as VehicleMissionSnapshot['targetM']
            if (t.next) advance(t.next)
            else { state = 'completed'; reason = t.kind === 'land' ? 'landed' : 'stopped'; targetM = null }
          }
        }
      }
      const result = snapshot()
      rows.push({ observation: o, action: action ?? null, result: structuredClone(result) })
      return result
    },
  }
}
export function replayVehicleMission(trace: VehicleMissionTrace) {
  if (!object(trace) || !keys(trace, ['version', 'evidence', 'plan', 'rows']) || trace.version !== 2 || trace.evidence !== 'owned-vehicle-mission-simulation' || !Array.isArray(trace.rows) || trace.rows.length > vehicleMissionLimits.rows) throw new TypeError('Invalid vehicle mission trace')
  const engine = createVehicleMissionEngine(trace.plan)
  for (const row of trace.rows) {
    if (!object(row) || !keys(row, ['observation', 'action', 'result']) || (row.action !== null && !['start', 'pause', 'resume', 'abort', 'recover'].includes(row.action))) throw new TypeError('Invalid vehicle mission trace row')
    if (JSON.stringify(engine.step(row.observation, row.action ?? undefined)) !== JSON.stringify(row.result)) throw new TypeError('Vehicle mission trace decision mismatch')
  }
  return engine
}
export function parseVehicleMissionTrace(text: string): VehicleMissionTrace {
  if (new TextEncoder().encode(text).length > vehicleMissionLimits.bytes) throw new RangeError('Vehicle mission trace exceeds 16 MiB')
  let trace: VehicleMissionTrace
  try { trace = JSON.parse(text) }
  catch { throw new TypeError('Invalid vehicle mission trace JSON') }
  return replayVehicleMission(trace).trace()
}
export function recoverVehicleMission(trace: VehicleMissionTrace, observation: VehicleMissionObservation) {
  const engine = replayVehicleMission(trace)
  if (!active(engine.snapshot().state) || engine.step(observation, 'recover').state !== 'paused') throw new TypeError('Vehicle checkpoint cannot recover without supervised compatible authority')
  return engine
}
