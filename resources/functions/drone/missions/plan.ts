import { types as nodeTypes } from 'node:util'
import type { SensorVector } from '../sensors/types'
import type { GeodeticOrigin } from '../estimation/frames'
import { authorityPolicy } from '../authority/supervisor'
import { validVector } from '../controls/model'
import { missionGraphBudget } from './graph'

export type MissionTask =
  | { id: string, kind: 'takeoff' | 'waypoint' | 'land', positionM: SensorVector, timeoutMs: number, next?: string }
  | { id: string, kind: 'loiter', positionM: SensorVector, durationMs: number, timeoutMs: number, next: string }
  | { id: string, kind: 'return', timeoutMs: number, next: string }
  | { id: string, kind: 'payload', channel: 'camera-still', next: string }
  | { id: string, kind: 'branch', batteryAtLeast: number, then: string, otherwise: string }
  | { id: string, kind: 'abort' }
export interface MissionPlan {
  version: 1
  id: string
  frame: 'LOCAL_NED'
  altitude: 'ORIGIN_RELATIVE_DOWN'
  terrain: 'FLAT_ORIGIN_PLANE'
  origin: GeodeticOrigin
  fence: { radiusM: number, minDownM: number }
  rallyM: SensorVector
  power: { availableWh: number, hoverW: number, reservePercent: number }
  start: string
  /** Optional bounded target ramp; omitted v1 plans preserve 0.6 m/s. */
  speedMps?: number
  tasks: MissionTask[]
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v)
const numberIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const keys = (v: object, fields: string[]) => Object.keys(v).every(k => fields.includes(k))
export function missionContains(plan: MissionPlan, position: unknown): position is SensorVector {
  return containsGeometry(plan, position)
}
export function missionTaskTarget(plan: MissionPlan, task: MissionTask): SensorVector | null {
  return task.kind === 'return' ? [...plan.rallyM] : 'positionM' in task ? [...task.positionM] : null
}
export function missionEdges(task: MissionTask): string[] {
  return task.kind === 'branch' ? [task.then, task.otherwise] : 'next' in task && task.next ? [task.next] : []
}
/** Strict v1 simulation profile. Convex fence and flat terrain make every straight segment checkable. */
export function validateMission(input: unknown): { plan: MissionPlan, worstCaseMs: number, requiredWh: number } {
  const invalid = () => { throw new TypeError('Invalid mission plan or unsupported mission semantics') }
  if (!object(input) || !keys(input, ['version', 'id', 'frame', 'altitude', 'terrain', 'origin', 'fence', 'rallyM', 'power', 'start', 'speedMps', 'tasks']) || input.version !== 1 || !identifier(input.id) || input.frame !== 'LOCAL_NED' || input.altitude !== 'ORIGIN_RELATIVE_DOWN' || input.terrain !== 'FLAT_ORIGIN_PLANE' || !identifier(input.start) || input.speedMps !== undefined && !numberIn(input.speedMps, 0.05, 0.6)) invalid()
  const p = input as unknown as MissionPlan
  if (!object(p.origin) || !keys(p.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM']) || !numberIn(p.origin.latitudeDeg, -90, 90) || !numberIn(p.origin.longitudeDeg, -180, 180) || !numberIn(p.origin.ellipsoidHeightM, -500, 10000)
    || !object(p.fence) || !keys(p.fence, ['radiusM', 'minDownM']) || !numberIn(p.fence.radiusM, 1, authorityPolicy.fenceRadiusM - 1) || !numberIn(p.fence.minDownM, authorityPolicy.minDownM + 0.5, -1)
    || !missionContains(p, p.rallyM) || p.rallyM[2] > -0.5 || !object(p.power) || !keys(p.power, ['availableWh', 'hoverW', 'reservePercent']) || !numberIn(p.power.availableWh, 0.01, 1000) || !numberIn(p.power.hoverW, 100, 2000) || !numberIn(p.power.reservePercent, authorityPolicy.reservePercent + 1, 80)
    || !Array.isArray(p.tasks) || p.tasks.length < 2 || p.tasks.length > 32) invalid()
  const tasks = new Map<string, MissionTask>()
  for (const t of p.tasks) {
    if (!object(t) || !identifier(t.id) || tasks.has(t.id)) invalid()
    const fields = ['id', 'kind']
    switch (t.kind) {
      case 'takeoff': case 'waypoint': case 'land':
        fields.push('positionM', 'timeoutMs', 'next')
        if (!missionContains(p, t.positionM) || (t.kind === 'land' ? t.positionM[2] !== 0 || t.next !== undefined : t.positionM[2] > -0.5 || !identifier(t.next))) invalid()
        break
      case 'loiter':
        fields.push('positionM', 'durationMs', 'timeoutMs', 'next')
        if (!missionContains(p, t.positionM) || t.positionM[2] > -0.5 || !numberIn(t.durationMs, 100, 10000) || !identifier(t.next)) invalid()
        break
      case 'return': fields.push('timeoutMs', 'next'); if (!identifier(t.next)) invalid(); break
      case 'payload': fields.push('channel', 'next'); if (t.channel !== 'camera-still' || !identifier(t.next)) invalid(); break
      case 'branch': fields.push('batteryAtLeast', 'then', 'otherwise'); if (!numberIn(t.batteryAtLeast, p.power.reservePercent + 1, 100) || !identifier(t.then) || !identifier(t.otherwise)) invalid(); break
      case 'abort': break
      default: invalid()
    }
    if (!keys(t, fields) || (['takeoff', 'waypoint', 'land', 'loiter', 'return'].includes(t.kind) && !numberIn((t as { timeoutMs?: number }).timeoutMs, 1000, 20000)) || (t.kind === 'loiter' && t.durationMs + 500 > t.timeoutMs)) invalid()
    tasks.set(t.id, t)
  }
  if (tasks.get(p.start)?.kind !== 'takeoff' || p.tasks.some(t => t.id !== p.start && t.kind === 'takeoff')) invalid()
  // The same bounded graph accounting is used by the explicit vehicle v2 profile.
  const worstCaseMs = missionGraphBudget(p.tasks.map(t => ({ id: t.id, durationMs: 'timeoutMs' in t ? t.timeoutMs : 20, edges: missionEdges(t) })), p.start, 120000)
  const requiredWh = p.power.hoverW * worstCaseMs / 3600000
  if (requiredWh > p.power.availableWh * (1 - p.power.reservePercent / 100)) throw new RangeError('Mission endurance budget cannot preserve reserve')
  return { plan: structuredClone(p), worstCaseMs, requiredWh }
}
export function exampleMission(): MissionPlan {
  return {
    version: 1, id: 'local-survey-demo', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE',
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff',
    tasks: [
      { id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1], timeoutMs: 12000, next: 'survey-point' },
      { id: 'survey-point', kind: 'waypoint', positionM: [2, 1, -1.5], timeoutMs: 12000, next: 'dwell' },
      { id: 'dwell', kind: 'loiter', positionM: [2, 1, -1.5], durationMs: 1000, timeoutMs: 12000, next: 'budget-check' },
      { id: 'budget-check', kind: 'branch', batteryAtLeast: 80, then: 'photo', otherwise: 'return' },
      { id: 'photo', kind: 'payload', channel: 'camera-still', next: 'return' },
      { id: 'return', kind: 'return', timeoutMs: 12000, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 12000 },
    ],
  }
}

export function parseMissionPlan(text: string): ReturnType<typeof validateMission> {
  let input: unknown
  try { input = JSON.parse(text) }
  catch { throw new TypeError('Invalid mission plan JSON') }
  return validateMission(input)
}


export type ReadinessMissionTask =
  | { id: string, kind: 'takeoff' | 'waypoint', positionM: SensorVector, timeoutMs: number, next: string }
  | { id: string, kind: 'land', positionM: SensorVector, timeoutMs: number }
  | { id: string, kind: 'loiter', positionM: SensorVector, durationMs: number, timeoutMs: number, next: string }
  | { id: string, kind: 'readiness-loiter', positionM: SensorVector, durationMs: 1500, timeoutMs: 3000, sourceId: string, next: string }
  | { id: string, kind: 'return', timeoutMs: number, next: string }
  | { id: string, kind: 'payload', channel: 'camera-still', next: string }
  | { id: string, kind: 'branch', batteryAtLeast: number, then: string, otherwise: string }
  | { id: string, kind: 'abort' }
export type ReadinessMissionPlan = Omit<MissionPlan, 'version' | 'speedMps' | 'tasks'> & { version: 3, speedMps: number, tasks: ReadinessMissionTask[] }
function containsGeometry(plan: { fence: MissionPlan['fence'] }, position: unknown): position is SensorVector {
  return validVector(position) && Math.hypot(position[0], position[1]) <= plan.fence.radiusM && position[2] >= plan.fence.minDownM && position[2] <= 0
}
/** Disjoint v3 policy input. Legacy validation and its input acceptance are unchanged. */
export function validateReadinessMission(input: unknown): { plan: ReadinessMissionPlan, worstCaseMs: number, requiredWh: number } {
  const invalid = (): never => { throw new TypeError('Invalid readiness mission plan') }
  const data = (value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid()
    const own = Reflect.ownKeys(value)
    if (own.length > fields.length || own.some(k => typeof k !== 'string' || !fields.includes(k))) return invalid()
    const descriptors = Object.getOwnPropertyDescriptors(value), out: Record<string, unknown> = {}
    for (const k of fields) {
      const d = descriptors[k]
      if (!d) { if (optional.includes(k)) continue; return invalid() }
      if (!d.enumerable || !Object.hasOwn(d, 'value')) return invalid()
      out[k] = d.value
    }
    return out
  }
  const numeric = (v: unknown, min: number, max: number): number => {
    if (!numberIn(v, min, max) || Math.abs(v) > 1e6 || JSON.stringify(v).length > 32) return invalid()
    return v
  }
  const id = (v: unknown): string => { if (!identifier(v)) return invalid(); return v }
  const vector = (v: unknown): SensorVector => {
    if (nodeTypes.isProxy(v) || !Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length !== 3 || Reflect.ownKeys(v).length !== 4) return invalid()
    const d = Object.getOwnPropertyDescriptors(v)
    for (const k of ['0', '1', '2']) if (!d[k]?.enumerable || !Object.hasOwn(d[k]!, 'value')) return invalid()
    return [numeric(d[0]!.value, -1e6, 1e6), numeric(d[1]!.value, -1e6, 1e6), numeric(d[2]!.value, -1e6, 1e6)]
  }
  const raw = data(input, ['version', 'id', 'frame', 'altitude', 'terrain', 'origin', 'fence', 'rallyM', 'power', 'start', 'speedMps', 'tasks'], ['speedMps'])
  if (raw.version !== 3 || raw.frame !== 'LOCAL_NED' || raw.altitude !== 'ORIGIN_RELATIVE_DOWN' || raw.terrain !== 'FLAT_ORIGIN_PLANE') return invalid()
  const o = data(raw.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM']), f = data(raw.fence, ['radiusM', 'minDownM']), p = data(raw.power, ['availableWh', 'hoverW', 'reservePercent'])
  const origin = { latitudeDeg: numeric(o.latitudeDeg, -90, 90), longitudeDeg: numeric(o.longitudeDeg, -180, 180), ellipsoidHeightM: numeric(o.ellipsoidHeightM, -500, 10000) }
  const fence = { radiusM: numeric(f.radiusM, 1, authorityPolicy.fenceRadiusM - 1), minDownM: numeric(f.minDownM, authorityPolicy.minDownM + 0.5, -1) }
  const rallyM = vector(raw.rallyM), power = { availableWh: numeric(p.availableWh, 0.01, 1000), hoverW: numeric(p.hoverW, 100, 2000), reservePercent: numeric(p.reservePercent, authorityPolicy.reservePercent + 1, 80) }
  if (!containsGeometry({ fence }, rallyM) || rallyM[2] > -0.5) return invalid()
  const list = raw.tasks
  if (nodeTypes.isProxy(list) || !Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype || list.length < 2 || list.length > 32 || Reflect.ownKeys(list).length !== list.length + 1) return invalid()
  const taskDescriptors = Object.getOwnPropertyDescriptors(list), tasks: ReadinessMissionTask[] = []
  for (let i = 0; i < list.length; i++) {
    const descriptor = taskDescriptors[i]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return invalid()
    const v = descriptor.value
    const captured = data(v, ['id', 'kind', 'positionM', 'timeoutMs', 'durationMs', 'sourceId', 'next', 'channel', 'batteryAtLeast', 'then', 'otherwise'], ['positionM', 'timeoutMs', 'durationMs', 'sourceId', 'next', 'channel', 'batteryAtLeast', 'then', 'otherwise'])
    const k = captured.kind
    let t: ReadinessMissionTask
    if (k === 'abort') { const d = data(captured, ['id', 'kind']); t = { id: id(d.id), kind: k } }
    else if (k === 'branch') { const d = data(captured, ['id', 'kind', 'batteryAtLeast', 'then', 'otherwise']); t = { id: id(d.id), kind: k, batteryAtLeast: numeric(d.batteryAtLeast, power.reservePercent + 1, 100), then: id(d.then), otherwise: id(d.otherwise) } }
    else if (k === 'payload') { const d = data(captured, ['id', 'kind', 'channel', 'next']); if (d.channel !== 'camera-still') return invalid(); t = { id: id(d.id), kind: k, channel: 'camera-still', next: id(d.next) } }
    else if (k === 'return') { const d = data(captured, ['id', 'kind', 'timeoutMs', 'next']); t = { id: id(d.id), kind: k, timeoutMs: numeric(d.timeoutMs, 1000, 20000), next: id(d.next) } }
    else if (k === 'takeoff' || k === 'waypoint' || k === 'land' || k === 'loiter' || k === 'readiness-loiter') {
      const fields = ['id', 'kind', 'positionM', ...(k === 'loiter' || k === 'readiness-loiter' ? ['durationMs'] : []), 'timeoutMs', ...(k === 'readiness-loiter' ? ['sourceId'] : []), ...(k === 'land' ? [] : ['next'])]
      const d = data(captured, fields), positionM = vector(d.positionM), timeoutMs = numeric(d.timeoutMs, 1000, 20000)
      if (!containsGeometry({ fence }, positionM) || (k === 'land' ? positionM[2] !== 0 : positionM[2] > -0.5)) return invalid()
      if (k === 'land') t = { id: id(d.id), kind: k, positionM, timeoutMs }
      else if (k === 'takeoff' || k === 'waypoint') t = { id: id(d.id), kind: k, positionM, timeoutMs, next: id(d.next) }
      else if (k === 'readiness-loiter') { if (d.durationMs !== 1500 || timeoutMs !== 3000) return invalid(); t = { id: id(d.id), kind: k, positionM, durationMs: 1500, timeoutMs: 3000, sourceId: id(d.sourceId), next: id(d.next) } }
      else { const durationMs = numeric(d.durationMs, 100, 10000); if (durationMs + 500 > timeoutMs) return invalid(); t = { id: id(d.id), kind: k, positionM, durationMs, timeoutMs, next: id(d.next) } }
    }
    else return invalid()
    tasks.push(t)
  }
  const plan: ReadinessMissionPlan = { version: 3, id: id(raw.id), frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin, fence, rallyM, power, start: id(raw.start), speedMps: Object.hasOwn(raw, 'speedMps') ? numeric(raw.speedMps, 0.05, 0.6) : 0.6, tasks }
  if (tasks.filter(t => t.kind === 'readiness-loiter').length !== 1 || tasks.find(t => t.id === plan.start)?.kind !== 'takeoff' || tasks.some(t => t.id !== plan.start && t.kind === 'takeoff')) return invalid()
  let worstCaseMs: number
  try { worstCaseMs = missionGraphBudget(tasks.map(t => ({ id: t.id, durationMs: 'timeoutMs' in t ? t.timeoutMs : 20, edges: t.kind === 'branch' ? [t.then, t.otherwise] : 'next' in t ? [t.next] : [] })), plan.start, 44000) }
  catch { return invalid() }
  const requiredWh = power.hoverW * worstCaseMs / 3600000
  if (requiredWh > power.availableWh * (1 - power.reservePercent / 100)) throw new RangeError('Readiness mission endurance budget cannot preserve reserve')
  if (new TextEncoder().encode(JSON.stringify(plan)).length > 32768) return invalid()
  return { plan, worstCaseMs, requiredWh }
}
