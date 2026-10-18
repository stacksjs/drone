import type { Target } from './types'
import { gpsToLocal, horizontalDistance } from './geometry'

export interface GpsTargetFix {
  latitude: number
  longitude: number
  accuracyMeters: number
  headingRadians: number
}

/** Adapt a trusted, explicitly paired phone/GNSS feed. Transport auth is the caller's responsibility. */
export function createGpsTargetSource(options: {
  targetId: string
  origin: { latitude: number, longitude: number }
  maxSpeedMps?: number
  now?: () => number
}) {
  const targetId = options.targetId
  const origin = { ...options.origin }
  const maxSpeed = options.maxSpeedMps ?? 8
  const now = options.now ?? (() => performance.now())
  if (!targetId.trim() || !Number.isFinite(maxSpeed) || maxSpeed <= 0) throw new RangeError('Invalid target source settings')
  let previous: Target | undefined
  return {
    update(fix: GpsTargetFix): Target {
      const receivedAtMs = now()
      if (!Number.isFinite(receivedAtMs) || !Number.isFinite(fix.accuracyMeters) || fix.accuracyMeters < 0 || !Number.isFinite(fix.headingRadians))
        throw new RangeError('Invalid target fix')
      const position = gpsToLocal(origin, { ...fix, altitudeMeters: 0 })
      if (previous) {
        const seconds = (receivedAtMs - previous.receivedAtMs) / 1000
        if (seconds <= 0 || horizontalDistance(position, previous.position) > maxSpeed * seconds + fix.accuracyMeters + previous.accuracyMeters)
          throw new RangeError('Out-of-order fix or implausible target jump')
      }
      previous = { id: targetId, position, accuracyMeters: fix.accuracyMeters, headingRadians: fix.headingRadians, receivedAtMs, confidence: 1 }
      return structuredClone(previous)
    },
  }
}
