import type { SensorVector } from '../sensors/types'
import type { MissionObservation } from '../missions/engine'
import { validVector } from '../controls/model'
import type { NavigationMap } from './perception'
import { terrainDownAt, validateNavigationMap } from './perception'
import { navigationEnvelope, navigationPolicy, navigationSegmentClear, planNavigationPath } from './planner'
export type NavigationIntent =
  | { mode: 'route', goalM: SensorVector, clearanceM: number }
  | { mode: 'rtl', goalM: SensorVector, clearanceM: number }
  | { mode: 'land', siteId: string, expectedM: SensorVector }
  | { mode: 'follow', targetId: string, offsetM: SensorVector, clearanceM: number }
  | { mode: 'orbit', targetId: string, radiusM: number, radiansPerSecond: number, phaseRad: number, startedAtMs: number, clearanceM: number }
export interface NavigationTarget { id: string, reference: string, positionM: SensorVector, capturedAtMs: number }
export interface NavigationDecision {
  state: 'navigating' | 'blocked' | 'released'
  reason: string
  targetM: SensorVector | null
  route: SensorVector[]
  marginM: number | null
  perceptionAgeMs: number | null
  mode: NavigationIntent['mode']
  replans: number
  physicalFlightEnabled: false
}
/** Metric selected-target intents only. Image boxes never enter this interface. */
export function navigationGoal(intent: NavigationIntent, o: MissionObservation, map: NavigationMap, target?: NavigationTarget): SensorVector {
  validateNavigationMap(map)
  if (!intent || !['route', 'rtl', 'land', 'follow', 'orbit'].includes(intent.mode)) throw new TypeError('Invalid navigation intent')
  let goal: SensorVector
  if (intent.mode === 'land') {
    if (!validVector(intent.expectedM) || !map.landing || intent.siteId !== map.landing.id || map.uncertaintyM > 0.1 || Math.hypot(...map.landing.positionM.map((n, i) => n - intent.expectedM[i]!)) > 0.18 || Math.hypot(map.terrain.northSlope, map.terrain.eastSlope) > 0.07) throw new TypeError('Selected landing site unavailable or inconsistent')
    const landingGoal: SensorVector = [...map.landing.positionM]
    landingGoal[2] = Math.min(0, landingGoal[2])
    return landingGoal
  }
  if (!Number.isFinite(intent.clearanceM) || intent.clearanceM < 0.8 || intent.clearanceM > 4) throw new RangeError('Invalid terrain clearance')
  if (intent.mode === 'route' || intent.mode === 'rtl') {
    if (!validVector(intent.goalM)) throw new TypeError('Invalid navigation goal')
    goal = [...intent.goalM]
  }
  else {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(intent.targetId) || !target || target.id !== intent.targetId || target.reference !== o.reference || !validVector(target.positionM) || !Number.isFinite(target.capturedAtMs) || target.capturedAtMs > o.nowMs || o.nowMs - target.capturedAtMs > 200) throw new TypeError('Selected navigation target lost')
    if (intent.mode === 'follow') {
      if (!validVector(intent.offsetM) || Math.hypot(...intent.offsetM) < 1 || Math.hypot(...intent.offsetM) > 5) throw new RangeError('Invalid selected-target offset')
      goal = target.positionM.map((n, i) => n + intent.offsetM[i]!) as SensorVector
    }
    else {
      if (!Number.isFinite(intent.radiusM) || intent.radiusM < 1 || intent.radiusM > 4 || !Number.isFinite(intent.radiansPerSecond) || Math.abs(intent.radiansPerSecond) > 0.6 / intent.radiusM || !Number.isFinite(intent.phaseRad) || Math.abs(intent.phaseRad) > Math.PI || !Number.isFinite(intent.startedAtMs) || intent.startedAtMs < 0 || intent.startedAtMs > o.nowMs) throw new RangeError('Invalid orbit geometry or speed')
      const angle = intent.phaseRad + (o.nowMs - intent.startedAtMs) / 1000 * intent.radiansPerSecond
      goal = [target.positionM[0] + intent.radiusM * Math.cos(angle), target.positionM[1] + intent.radiusM * Math.sin(angle), target.positionM[2]]
    }
  }
  // Explicit terrain-clearance mode. The flat-plane mission remains the high-level acceptance reference.
  goal[2] = terrainDownAt(map, goal) - intent.clearanceM
  return goal
}
export function createNavigator(options: { fenceRadiusM: number, minDownM: number }) {
  if (!Number.isFinite(options.fenceRadiusM) || options.fenceRadiusM < 1 || options.fenceRadiusM > 19 || !Number.isFinite(options.minDownM) || options.minDownM < -9.5 || options.minDownM > -0.5) throw new RangeError('Invalid navigation fence')
  let lastCapturedAt = -1
  let frameSignature: string | null = null
  let lastNow: number | null = null
  let reference: string | null = null
  let sequence = 0
  let signature = ''
  let fault: string | null = null
  let plannedAt = -Infinity
  let route: SensorVector[] = []
  let command: SensorVector | null = null
  let previousGoal: SensorVector | null = null
  let replans = 0
  return {
    step(o: MissionObservation, map: NavigationMap | null, intent: NavigationIntent, target?: NavigationTarget): NavigationDecision {
      const blocked = (reason: string): NavigationDecision => { fault ??= reason; command = null; route = []; return { state: 'blocked', reason: fault, targetM: null, route: [], marginM: null, perceptionAgeMs: null, mode: intent?.mode, replans, physicalFlightEnabled: false } }
      if (fault) return blocked(fault)
      if (!o || o.kind !== 'simulation' || !Number.isFinite(o.nowMs) || o.nowMs < 0 || (lastNow !== null && (o.nowMs <= lastNow || o.nowMs - lastNow > navigationPolicy.schedulerGapMs))) return blocked('navigation-clock-or-schedule')
      const dt = lastNow === null ? 0 : o.nowMs - lastNow
      lastNow = o.nowMs
      if (!o.healthy || !validVector(o.positionM) || !validVector(o.velocityMps) || o.authority !== 'autonomous') return blocked('navigation-position-or-authority')
      if (reference !== null && reference !== o.reference) return blocked('navigation-reference-changed')
      reference = o.reference
      const frame = JSON.stringify(o.origin)
      if (frameSignature !== null && frameSignature !== frame) return blocked('navigation-origin-changed')
      frameSignature = frame
      if (!map) return blocked('navigation-range-missing')
      try { validateNavigationMap(map) }
      catch { return blocked('navigation-range-invalid') }
      const ageMs = o.nowMs - map.capturedAtMs + map.clockUncertaintyMs
      const serialized = JSON.stringify(map)
      if (map.reference !== reference || map.receivedAtMs > o.nowMs || ageMs < 0 || ageMs > navigationPolicy.maxRangeAgeMs || map.sequence < sequence || (map.sequence > sequence && map.capturedAtMs <= lastCapturedAt) || (map.sequence === sequence && serialized !== signature)) return blocked('navigation-range-stale-or-replayed')
      sequence = map.sequence; signature = serialized; lastCapturedAt = map.capturedAtMs
      let goal: SensorVector
      try { goal = navigationGoal(intent, o, map, target) }
      catch { return blocked('navigation-intent-or-selected-target') }
      const speed = Math.max(navigationPolicy.speedMps, Math.hypot(...o.velocityMps))
      if (speed > 1.5) return blocked('navigation-speed-envelope')
      const envelope = navigationEnvelope({ speedMps: speed, ageMs, uncertaintyM: map.uncertaintyM })
      const planMarginM = Math.max(envelope.clearanceM, navigationEnvelope({ speedMps: 0.8, ageMs: 200, uncertaintyM: map.uncertaintyM }).clearanceM) + 0.3
      const allowedPosition = Math.hypot(o.positionM[0], o.positionM[1]) + envelope.clearanceM <= options.fenceRadiusM && o.positionM[2] >= options.minDownM && o.positionM[2] <= 0
      if (!allowedPosition || !navigationSegmentClear(o.positionM, o.positionM, map, envelope.clearanceM)) return blocked('navigation-braking-envelope')
      if (o.nowMs - plannedAt >= navigationPolicy.planPeriodMs || !previousGoal || Math.hypot(...goal.map((n, i) => n - previousGoal![i]!)) > 0.15 || !route.length || !navigationSegmentClear(o.positionM, route[0]!, map, envelope.clearanceM)) {
        const planned = planNavigationPath({ map, startM: o.positionM, goalM: goal, marginM: planMarginM, ...options })
        if (!planned) return blocked('navigation-no-observed-route')
        route = planned.slice(1); plannedAt = o.nowMs; previousGoal = [...goal]; replans++
      }
      while (route.length > 1 && Math.hypot(...o.positionM.map((n, i) => n - route[0]![i]!)) < 0.18) route.shift()
      const waypoint = route[0] ?? goal
      command ??= [...o.positionM]
      const distance = Math.hypot(...waypoint.map((n, i) => n - command![i]!))
      const scale = distance === 0 ? 1 : Math.min(1, navigationPolicy.speedMps * dt / 1000 / distance)
      const next = waypoint.map((n, i) => command![i]! + (n - command![i]!) * scale) as SensorVector
      if (!navigationSegmentClear(o.positionM, next, map, envelope.clearanceM)) return blocked('navigation-command-segment')
      command = next
      return { state: 'navigating', reason: intent.mode === 'land' ? 'selected-range-landing-site' : 'observed-braking-constrained-route', targetM: [...command], route: route.map(p => [...p]), marginM: envelope.clearanceM, perceptionAgeMs: ageMs, mode: intent.mode, replans, physicalFlightEnabled: false }
    },
  }
}
