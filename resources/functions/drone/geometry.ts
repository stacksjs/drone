import type { Vector3 } from './types'

export const zero = (): Vector3 => ({ north: 0, east: 0, down: 0 })
export const finiteVector = (v: Vector3): boolean => !!v && [v.north, v.east, v.down].every(Number.isFinite)
export const horizontalDistance = (a: Vector3, b: Vector3): number => Math.hypot(a.north - b.north, a.east - b.east)

export function clampVelocity(v: Vector3, horizontal: number, vertical: number): Vector3 {
  const scale = Math.min(1, horizontal / (Math.hypot(v.north, v.east) || 1))
  return { north: v.north * scale, east: v.east * scale, down: Math.max(-vertical, Math.min(vertical, v.down)) }
}

/** Small-area GPS conversion, appropriate for this framework's <= 500m fence. */
export function gpsToLocal(origin: { latitude: number, longitude: number }, fix: { latitude: number, longitude: number, altitudeMeters: number }): Vector3 {
  if (![origin.latitude, origin.longitude, fix.latitude, fix.longitude, fix.altitudeMeters].every(Number.isFinite)
    || Math.abs(origin.latitude) > 85 || Math.abs(fix.latitude) > 85
    || Math.abs(origin.longitude) > 180 || Math.abs(fix.longitude) > 180)
    throw new RangeError('Invalid GPS fix or polar origin')
  const radians = Math.PI / 180
  const longitudeDelta = ((fix.longitude - origin.longitude + 540) % 360) - 180
  return {
    north: (fix.latitude - origin.latitude) * radians * 6371000,
    east: longitudeDelta * radians * 6371000 * Math.cos(origin.latitude * radians),
    down: -fix.altitudeMeters,
  }
}
