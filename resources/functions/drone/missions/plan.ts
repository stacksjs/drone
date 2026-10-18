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
  tasks: MissionTask[]
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v)
const numberIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const keys = (v: object, fields: string[]) => Object.keys(v).every(k => fields.includes(k))
export function missionContains(plan: MissionPlan, position: unknown): position is SensorVector {
  return validVector(position) && Math.hypot(position[0], position[1]) <= plan.fence.radiusM && position[2] >= plan.fence.minDownM && position[2] <= 0
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
  if (!object(input) || !keys(input, ['version', 'id', 'frame', 'altitude', 'terrain', 'origin', 'fence', 'rallyM', 'power', 'start', 'tasks']) || input.version !== 1 || !identifier(input.id) || input.frame !== 'LOCAL_NED' || input.altitude !== 'ORIGIN_RELATIVE_DOWN' || input.terrain !== 'FLAT_ORIGIN_PLANE' || !identifier(input.start)) invalid()
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
