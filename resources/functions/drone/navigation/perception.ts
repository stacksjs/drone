import type { SensorVector } from '../sensors/types'
import type { Quaternion } from '../estimation/frames'
import { validVector } from '../controls/model'
import { rotateBodyToNed } from '../controls/physics'
export interface RangePacket {
  version: 1
  evidence: 'modeled-range'
  frame: 'BODY_FRD'
  sequence: number
  reference: string
  capturedAtMs: number
  receivedAtMs: number
  clockUncertaintyMs: number
  rangeSigmaM: number
  coverage: 'complete-360-model'
  maxRangeM: number
  clusters: { id: string, pointsBodyM: [SensorVector, SensorVector, SensorVector] }[]
  groundBodyM: [SensorVector, SensorVector, SensorVector]
  landing: { id: string, pointBodyM: SensorVector } | null
}
export interface NavigationPose { reference: string, atMs: number, positionM: SensorVector, quaternionWxyz: Quaternion, positionSigmaM: number }
export interface NavigationMap {
  version: 1
  evidence: 'modeled-range'
  sequence: number
  reference: string
  capturedAtMs: number
  receivedAtMs: number
  latencyMs: number
  clockUncertaintyMs: number
  uncertaintyM: number
  coverage: { centerM: SensorVector, radiusM: number }
  obstacles: { id: string, northM: number, eastM: number, radiusM: number }[]
  terrain: { northSlope: number, eastSlope: number, downAtOriginM: number }
  landing: { id: string, positionM: SensorVector } | null
}
const id = (s: unknown) => typeof s === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(s)
/** A calibrated synthetic range detector. Three visible arc samples fit a cylindrical exclusion column. */
export function detectNavigationMap(packet: RangePacket, pose: NavigationPose): NavigationMap {
  const fail = () => { throw new TypeError('Unqualified navigation range or capture pose') }
  if (!packet || packet.version !== 1 || packet.evidence !== 'modeled-range' || packet.frame !== 'BODY_FRD' || packet.coverage !== 'complete-360-model' || !Number.isSafeInteger(packet.sequence) || packet.sequence < 1 || packet.sequence > 0xFFFFFFFF || typeof packet.reference !== 'string' || packet.reference !== pose?.reference
    || !Number.isSafeInteger(packet.capturedAtMs) || packet.capturedAtMs < 0 || !Number.isSafeInteger(packet.receivedAtMs) || packet.receivedAtMs < packet.capturedAtMs || packet.receivedAtMs - packet.capturedAtMs > 200 || !Number.isFinite(packet.clockUncertaintyMs) || packet.clockUncertaintyMs < 0 || packet.clockUncertaintyMs > 5
    || !Number.isFinite(packet.rangeSigmaM) || packet.rangeSigmaM <= 0 || packet.rangeSigmaM > 0.1 || !Number.isFinite(packet.maxRangeM) || packet.maxRangeM < 2 || packet.maxRangeM > 20 || !Array.isArray(packet.clusters) || packet.clusters.length > 8
    || pose.atMs !== packet.capturedAtMs || !validVector(pose.positionM) || !Array.isArray(pose.quaternionWxyz) || pose.quaternionWxyz.length !== 4 || !pose.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...pose.quaternionWxyz) - 1) > 1e-6 || !Number.isFinite(pose.positionSigmaM) || pose.positionSigmaM <= 0 || pose.positionSigmaM > 0.1) fail()
  function world(p: SensorVector): SensorVector {
    if (!validVector(p) || Math.hypot(...p) > packet.maxRangeM) return fail()
    const v = rotateBodyToNed(pose.quaternionWxyz, p)
    return v.map((n, i) => n + pose.positionM[i]!) as SensorVector
  }
  const seen = new Set<string>()
  const obstacles = packet.clusters.map(c => {
    if (!c || !id(c.id) || seen.has(c.id) || !Array.isArray(c.pointsBodyM) || c.pointsBodyM.length !== 3) return fail()
    seen.add(c.id)
    const [a, b, d] = c.pointsBodyM.map(world) as [SensorVector, SensorVector, SensorVector]
    const x = b[0] - a[0], y = b[1] - a[1], u = d[0] - a[0], v = d[1] - a[1]
    const determinant = 2 * (x * v - y * u)
    if (Math.abs(determinant) < 1e-5) return fail()
    const northM = a[0] + (v * (x * x + y * y) - y * (u * u + v * v)) / determinant
    const eastM = a[1] + (x * (u * u + v * v) - u * (x * x + y * y)) / determinant
    const radiusM = Math.hypot(northM - a[0], eastM - a[1])
    if (!Number.isFinite(radiusM) || radiusM < 0.05 || radiusM > 2) return fail()
    return { id: c.id, northM, eastM, radiusM }
  })
  if (!Array.isArray(packet.groundBodyM) || packet.groundBodyM.length !== 3) fail()
  const [a, b, c] = packet.groundBodyM.map(world) as [SensorVector, SensorVector, SensorVector]
  const x = b[0] - a[0], y = b[1] - a[1], u = c[0] - a[0], v = c[1] - a[1]
  const determinant = x * v - y * u
  if (Math.abs(determinant) < 0.01) fail()
  const northSlope = ((b[2] - a[2]) * v - (c[2] - a[2]) * y) / determinant
  const eastSlope = (x * (c[2] - a[2]) - u * (b[2] - a[2])) / determinant
  if (Math.hypot(northSlope, eastSlope) > 0.1) fail()
  const landing = packet.landing === null ? null : id(packet.landing?.id) ? { id: packet.landing.id, positionM: world(packet.landing.pointBodyM) } : fail()
  return { version: 1, evidence: 'modeled-range', sequence: packet.sequence, reference: packet.reference, capturedAtMs: packet.capturedAtMs, receivedAtMs: packet.receivedAtMs, latencyMs: packet.receivedAtMs - packet.capturedAtMs, clockUncertaintyMs: packet.clockUncertaintyMs, uncertaintyM: 3 * (packet.rangeSigmaM + pose.positionSigmaM), coverage: { centerM: [...pose.positionM], radiusM: packet.maxRangeM }, obstacles, terrain: { northSlope, eastSlope, downAtOriginM: a[2] - northSlope * a[0] - eastSlope * a[1] }, landing }
}
export const terrainDownAt = (map: NavigationMap, positionM: SensorVector) => map.terrain.downAtOriginM + map.terrain.northSlope * positionM[0] + map.terrain.eastSlope * positionM[1]

/** Runtime check for consumers accepting a recorded detector result. */
export function validateNavigationMap(map: NavigationMap): void {
  if (!map || map.version !== 1 || map.evidence !== 'modeled-range' || !Number.isSafeInteger(map.sequence) || map.sequence < 1 || map.sequence > 0xFFFFFFFF || typeof map.reference !== 'string' || map.reference.length > 120 || !Number.isSafeInteger(map.capturedAtMs) || map.capturedAtMs < 0 || !Number.isSafeInteger(map.receivedAtMs) || map.receivedAtMs < map.capturedAtMs || map.latencyMs !== map.receivedAtMs - map.capturedAtMs || map.latencyMs > 200
    || !Number.isFinite(map.clockUncertaintyMs) || map.clockUncertaintyMs < 0 || map.clockUncertaintyMs > 5 || !Number.isFinite(map.uncertaintyM) || map.uncertaintyM <= 0 || map.uncertaintyM > 0.6 || !validVector(map.coverage?.centerM) || !Number.isFinite(map.coverage.radiusM) || map.coverage.radiusM < 2 || map.coverage.radiusM > 20 || !Array.isArray(map.obstacles) || map.obstacles.length > 8
    || map.obstacles.some(c => !c || !id(c.id) || !Number.isFinite(c.northM) || !Number.isFinite(c.eastM) || !Number.isFinite(c.radiusM) || c.radiusM < 0.05 || c.radiusM > 2) || new Set(map.obstacles.map(c => c.id)).size !== map.obstacles.length
    || !map.terrain || ![map.terrain.northSlope, map.terrain.eastSlope, map.terrain.downAtOriginM].every(Number.isFinite) || Math.hypot(map.terrain.northSlope, map.terrain.eastSlope) > 0.1 || (map.landing !== null && (!id(map.landing?.id) || !validVector(map.landing.positionM)))) throw new TypeError('Invalid navigation map')
}
