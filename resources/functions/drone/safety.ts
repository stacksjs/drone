import type { Behavior, Decision, FlightLimits, Target, Telemetry } from './types'
import { clampVelocity, finiteVector, horizontalDistance } from './geometry'

export const defaultLimits: Readonly<FlightLimits> = Object.freeze({
  radiusMeters: 80,
  minAltitudeMeters: 8,
  maxAltitudeMeters: 30,
  maxSpeedMps: 3,
  maxClimbMps: 1,
  minSeparationMeters: 5,
  minBatteryPercent: 25,
  maxTelemetryAgeMs: 1000,
  maxTargetAgeMs: 1500,
  maxTargetAccuracyMeters: 4,
  minConfidence: 0.8,
  predictionSeconds: 2,
})

export function validateLimits(limits: FlightLimits): void {
  if (!Object.values(limits).every(v => Number.isFinite(v) && v > 0)
    || limits.minAltitudeMeters >= limits.maxAltitudeMeters || limits.radiusMeters > 500
    || limits.minConfidence > 1 || limits.minBatteryPercent > 100)
    throw new RangeError('Invalid flight limits')
}

const fresh = (timestamp: number, now: number, maxAge: number): boolean => Number.isFinite(timestamp) && timestamp <= now && now - timestamp <= maxAge

/** Pure decision boundary, also used by the simulator and custom behavior runner. */
export function decide(input: {
  telemetry?: Telemetry
  target?: Target
  targetId: string
  enabled: boolean
  nowMs: number
  behavior: Behavior
  limits?: FlightLimits
}): Decision {
  const { telemetry: t, target, enabled, nowMs, behavior, targetId } = input
  const limits = input.limits ?? defaultLimits
  validateLimits(limits)
  const release = (reason: string): Decision => ({ kind: 'release', reason })
  const hold = (reason: string): Decision => ({ kind: 'hold', reason })
  if (!enabled) return release('Autonomy disabled')
  if (!Number.isFinite(nowMs) || !t || !fresh(t.receivedAtMs, nowMs, limits.maxTelemetryAgeMs)) return release('Telemetry stale or missing')
  if (!t.armed || t.mode !== 'guided') return release('Pilot has control')
  if (!finiteVector(t.position) || !finiteVector(t.velocity) || !t.positionHealthy) return release('Position estimate unavailable')
  if (!Number.isFinite(t.batteryPercent) || t.batteryPercent < limits.minBatteryPercent || t.batteryPercent > 100) return release('Battery reserve reached or unknown')
  const altitude = -t.position.down
  if (Math.hypot(t.position.north, t.position.east) > limits.radiusMeters
    || altitude < limits.minAltitudeMeters || altitude > limits.maxAltitudeMeters)
    return release('Aircraft outside operating envelope')
  if (!target || target.id !== targetId || !targetId) return hold('Selected target unavailable')
  if (!fresh(target.receivedAtMs, nowMs, limits.maxTargetAgeMs)) return hold('Target stale')
  if (!finiteVector(target.position) || !Number.isFinite(target.headingRadians)
    || !Number.isFinite(target.confidence) || target.confidence < limits.minConfidence || target.confidence > 1
    || !Number.isFinite(target.accuracyMeters) || target.accuracyMeters < 0 || target.accuracyMeters > limits.maxTargetAccuracyMeters)
    return hold('Target quality insufficient')
  if (Math.hypot(target.position.north, target.position.east) > limits.radiusMeters) return hold('Target outside fence')
  // Remain stopped when separation is already compromised. This is not obstacle avoidance.
  if (horizontalDistance(t.position, target.position) < limits.minSeparationMeters) return hold('Minimum target separation reached')
  let requested
  try {
    requested = behavior.velocity(structuredClone({ telemetry: t, target, nowMs }))
  }
  catch {
    return hold('Behavior failed')
  }
  if (!requested || !finiteVector(requested)) return hold('Behavior returned invalid velocity')
  const velocity = clampVelocity(requested, limits.maxSpeedMps, limits.maxClimbMps)
  const horizon = limits.predictionSeconds
  const predicted = {
    north: t.position.north + velocity.north * horizon,
    east: t.position.east + velocity.east * horizon,
    down: t.position.down + velocity.down * horizon,
  }
  // A cylinder is convex, so in-bounds endpoints also bound this straight segment.
  if (Math.hypot(predicted.north, predicted.east) > limits.radiusMeters
    || -predicted.down < limits.minAltitudeMeters || -predicted.down > limits.maxAltitudeMeters)
    return hold('Predicted fence or altitude breach')
  const relativeNorth = t.position.north - target.position.north
  const relativeEast = t.position.east - target.position.east
  const speedSquared = velocity.north ** 2 + velocity.east ** 2
  const closestTime = speedSquared === 0 ? 0 : Math.max(0, Math.min(horizon, -(relativeNorth * velocity.north + relativeEast * velocity.east) / speedSquared))
  if (Math.hypot(relativeNorth + velocity.north * closestTime, relativeEast + velocity.east * closestTime) < limits.minSeparationMeters)
    return hold('Predicted target separation breach')
  return { kind: 'velocity', velocity, reason: behavior.name }
}
