import type { SensorVector } from '../sensors/types'
export interface GeodeticOrigin { latitudeDeg: number, longitudeDeg: number, ellipsoidHeightM: number }
export function geodeticToEcef(point: GeodeticOrigin): SensorVector {
  if (![point.latitudeDeg, point.longitudeDeg, point.ellipsoidHeightM].every(Number.isFinite) || Math.abs(point.latitudeDeg) > 90 || Math.abs(point.longitudeDeg) > 180 || Math.abs(point.ellipsoidHeightM) > 100000) throw new RangeError('Invalid WGS84 geodetic coordinates')
  const latitude = point.latitudeDeg * Math.PI / 180, longitude = point.longitudeDeg * Math.PI / 180
  const a = 6378137
  const flattening = 1 / 298.257223563
  const e2 = flattening * (2 - flattening)
  const n = a / Math.sqrt(1 - e2 * Math.sin(latitude) ** 2)
  return [(n + point.ellipsoidHeightM) * Math.cos(latitude) * Math.cos(longitude), (n + point.ellipsoidHeightM) * Math.cos(latitude) * Math.sin(longitude), (n * (1 - e2) + point.ellipsoidHeightM) * Math.sin(latitude)]
}
/** Fixed tangent frame, geodetic north/east/down. Height is ellipsoidal, never MSL. */
export function geodeticToNed(point: GeodeticOrigin, origin: GeodeticOrigin): SensorVector {
  const ecef = geodeticToEcef(point), base = geodeticToEcef(origin)
  const [x, y, z] = ecef.map((value, i) => value - base[i]!) as SensorVector
  const p = origin.latitudeDeg * Math.PI / 180, l = origin.longitudeDeg * Math.PI / 180
  return [-Math.sin(p) * Math.cos(l) * x - Math.sin(p) * Math.sin(l) * y + Math.cos(p) * z, -Math.sin(l) * x + Math.cos(l) * y, -Math.cos(p) * Math.cos(l) * x - Math.cos(p) * Math.sin(l) * y - Math.sin(p) * z]
}
/** Rotate a local NED vector at the fix into the fixed origin's NED axes. */
export function nedRotation(point: GeodeticOrigin, origin: GeodeticOrigin): SensorVector[] {
  const basis = (g: GeodeticOrigin): SensorVector[] => {
    const p = g.latitudeDeg * Math.PI / 180, l = g.longitudeDeg * Math.PI / 180
    return [[-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)], [-Math.sin(l), Math.cos(l), 0], [-Math.cos(p) * Math.cos(l), -Math.cos(p) * Math.sin(l), -Math.sin(p)]]
  }
  const from = basis(point), to = basis(origin)
  return to.map(row => from.map(column => row.reduce((sum, n, i) => sum + n * column[i]!, 0)) as SensorVector)
}
export type Quaternion = [number, number, number, number]
export function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  const [w, x, y, z] = a, [v, i, j, k] = b
  return [w * v - x * i - y * j - z * k, w * i + x * v + y * k - z * j, w * j - x * k + y * v + z * i, w * k + x * j - y * i + z * v]
}
export function normalizeQuaternion(q: Quaternion): Quaternion {
  const length = Math.hypot(...q)
  if (!Number.isFinite(length) || length < 1e-12) throw new RangeError('Invalid attitude quaternion')
  return q.map(v => v / length) as Quaternion
}
export function quaternionFromTilt(roll: number, pitch: number): Quaternion {
  return [Math.cos(roll / 2) * Math.cos(pitch / 2), Math.sin(roll / 2) * Math.cos(pitch / 2), Math.cos(roll / 2) * Math.sin(pitch / 2), -Math.sin(roll / 2) * Math.sin(pitch / 2)]
}
export function quaternionEuler(q: Quaternion): SensorVector {
  const [w, x, y, z] = q
  return [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)), Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))), Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))]
}

/** Invert the fixed WGS84 tangent frame through ECEF, preserving ellipsoidal height. */
export function nedToGeodetic(positionM: SensorVector, origin: GeodeticOrigin): GeodeticOrigin {
  if (!Array.isArray(positionM) || positionM.length !== 3 || positionM.some(n => !Number.isFinite(n) || Math.abs(n) > 100000)) throw new RangeError('Invalid fixed NED coordinates')
  const base = geodeticToEcef(origin), p = origin.latitudeDeg * Math.PI / 180, l = origin.longitudeDeg * Math.PI / 180
  const [north, east, down] = positionM
  const x = base[0] - Math.sin(p) * Math.cos(l) * north - Math.sin(l) * east - Math.cos(p) * Math.cos(l) * down
  const y = base[1] - Math.sin(p) * Math.sin(l) * north + Math.cos(l) * east - Math.cos(p) * Math.sin(l) * down
  const z = base[2] + Math.cos(p) * north - Math.sin(p) * down
  const a = 6378137, flattening = 1 / 298.257223563, e2 = flattening * (2 - flattening), horizontal = Math.hypot(x, y)
  if (horizontal < 1e-8) return { latitudeDeg: z >= 0 ? 90 : -90, longitudeDeg: origin.longitudeDeg, ellipsoidHeightM: Math.abs(z) - a * (1 - flattening) }
  let latitude = Math.atan2(z, horizontal * (1 - e2))
  for (let iteration = 0; iteration < 12; iteration++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(latitude) ** 2)
    const next = Math.atan2(z + e2 * n * Math.sin(latitude), horizontal)
    if (Math.abs(next - latitude) < 1e-15) { latitude = next; break }
    latitude = next
  }
  const n = a / Math.sqrt(1 - e2 * Math.sin(latitude) ** 2)
  const height = horizontal * Math.cos(latitude) + z * Math.sin(latitude) - n * (1 - e2 * Math.sin(latitude) ** 2)
  return { latitudeDeg: latitude * 180 / Math.PI, longitudeDeg: Math.atan2(y, x) * 180 / Math.PI, ellipsoidHeightM: height }
}
