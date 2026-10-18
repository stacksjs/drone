import type { SensorVector } from '../sensors/types'
import { validVector } from '../controls/model'
import type { NavigationMap } from './perception'
import { validateNavigationMap } from './perception'
export const navigationPolicy = Object.freeze({ speedMps: 0.6, brakingMps2: 0.5, controlDelayMs: 250, bodyRadiusM: 0.3, trackingMarginM: 0.2, maxRangeAgeMs: 200, planPeriodMs: 200, schedulerGapMs: 40 })
export function navigationEnvelope(input: { speedMps: number, ageMs: number, uncertaintyM: number }) {
  if (![input.speedMps, input.ageMs, input.uncertaintyM].every(Number.isFinite) || input.speedMps < 0 || input.speedMps > 3 || input.ageMs < 0 || input.ageMs > navigationPolicy.maxRangeAgeMs || input.uncertaintyM < 0 || input.uncertaintyM > 1) throw new RangeError('Invalid navigation braking envelope')
  const reactionM = input.speedMps * (input.ageMs + navigationPolicy.controlDelayMs) / 1000
  const brakingM = input.speedMps ** 2 / (2 * navigationPolicy.brakingMps2)
  return { reactionM, brakingM, clearanceM: reactionM + brakingM + input.uncertaintyM + navigationPolicy.bodyRadiusM + navigationPolicy.trackingMarginM }
}
function segmentClear(a: SensorVector, b: SensorVector, map: NavigationMap, marginM: number): boolean {
  for (const c of map.obstacles) {
    const x = b[0] - a[0], y = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((c.northM - a[0]) * x + (c.eastM - a[1]) * y) / (x * x + y * y || 1)))
    if (Math.hypot(a[0] + t * x - c.northM, a[1] + t * y - c.eastM) < c.radiusM + marginM - 1e-9) return false
  }
  return true
}
/** Bounded visibility graph around inflated cylindrical columns. It never routes through unknown coverage. */
export function planNavigationPath(input: { map: NavigationMap, startM: SensorVector, goalM: SensorVector, fenceRadiusM: number, minDownM: number, marginM: number }): SensorVector[] | null {
  const { map, startM, goalM, marginM, fenceRadiusM, minDownM } = input
  validateNavigationMap(map)
  if (!map || map.evidence !== 'modeled-range' || !Array.isArray(map.obstacles) || map.obstacles.length > 8 || !validVector(startM) || !validVector(goalM) || !Number.isFinite(marginM) || marginM < 0.3 || marginM > 4 || !Number.isFinite(fenceRadiusM) || fenceRadiusM < 1 || fenceRadiusM > 19 || !Number.isFinite(minDownM) || minDownM < -9.5 || minDownM > -0.5) throw new TypeError('Invalid navigation path request')
  const allowed = (p: SensorVector) => Math.hypot(p[0], p[1]) + marginM <= fenceRadiusM && p[2] >= minDownM && p[2] <= 0 && Math.hypot(...p.map((n, i) => n - map.coverage.centerM[i]!)) + marginM <= map.coverage.radiusM && segmentClear(p, p, map, marginM)
  if (!allowed(startM) || !allowed(goalM)) return null
  if (segmentClear(startM, goalM, map, marginM)) return [[...startM], [...goalM]]
  const vertices: SensorVector[] = [[...startM], [...goalM]]
  for (const obstacle of map.obstacles) {
    const r = (obstacle.radiusM + marginM + 0.03) / Math.cos(Math.PI / 16)
    for (let i = 0; i < 16; i++) {
      const p: SensorVector = [obstacle.northM + r * Math.cos(i * Math.PI / 8), obstacle.eastM + r * Math.sin(i * Math.PI / 8), goalM[2]]
      if (allowed(p)) vertices.push(p)
    }
  }
  const distance = vertices.map(() => Infinity)
  const previous = vertices.map(() => -1)
  const visited = new Set<number>()
  distance[0] = 0
  for (let count = 0; count < vertices.length; count++) {
    let next = -1
    for (let i = 0; i < vertices.length; i++) if (!visited.has(i) && (next === -1 || distance[i]! < distance[next]!)) next = i
    if (next === -1 || !Number.isFinite(distance[next]!)) return null
    if (next === 1) {
      const route: SensorVector[] = []
      for (let at = 1; at !== -1; at = previous[at]!) route.unshift([...vertices[at]!] as SensorVector)
      return route
    }
    visited.add(next)
    for (let i = 0; i < vertices.length; i++) {
      if (visited.has(i) || !segmentClear(vertices[next]!, vertices[i]!, map, marginM)) continue
      const candidate = distance[next]! + Math.hypot(...vertices[next]!.map((n, j) => n - vertices[i]![j]!))
      if (candidate < distance[i]!) { distance[i] = candidate; previous[i] = next }
    }
  }
  return null
}

export function navigationSegmentClear(a: SensorVector, b: SensorVector, map: NavigationMap, marginM: number): boolean {
  validateNavigationMap(map)
  if (!validVector(a) || !validVector(b) || !Number.isFinite(marginM) || marginM < 0 || marginM > 4) throw new TypeError('Invalid navigation segment')
  return segmentClear(a, b, map, marginM)
}
