import type { VolumeXY } from './types'

// Local metre arithmetic, anchored shoelace area and explicit operation budgets avoid map-coordinate cancellation.
export const geometryEpsilon = 1e-9
export function cross(a: VolumeXY, b: VolumeXY, c: VolumeXY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}
export function signedArea(points: VolumeXY[]): number {
  const a = points[0]!
  let sum = 0
  for (let i = 1; i + 1 < points.length; i++) sum += cross(a, points[i]!, points[i + 1]!) / 2
  return sum
}
export function samePoint(a: VolumeXY, b: VolumeXY): boolean {
  return Math.abs(a[0] - b[0]) <= geometryEpsilon && Math.abs(a[1] - b[1]) <= geometryEpsilon
}
export function onSegment(p: VolumeXY, a: VolumeXY, b: VolumeXY): boolean {
  return Math.abs(cross(a, b, p)) <= geometryEpsilon * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))
    && p[0] >= Math.min(a[0], b[0]) - geometryEpsilon && p[0] <= Math.max(a[0], b[0]) + geometryEpsilon
    && p[1] >= Math.min(a[1], b[1]) - geometryEpsilon && p[1] <= Math.max(a[1], b[1]) + geometryEpsilon
}
export function segmentsTouch(a: VolumeXY, b: VolumeXY, c: VolumeXY, d: VolumeXY): boolean {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b)
  return ((abC > 0 && abD < 0 || abC < 0 && abD > 0) && (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0))
    || onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d)
}
export function insideRing(p: VolumeXY, ring: VolumeXY[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if (onSegment(p, a, b)) return true
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}
export function cleanPolygon(input: VolumeXY[]): VolumeXY[] {
  const out: VolumeXY[] = []
  for (const p of input) if (!out.length || !samePoint(p, out[out.length - 1]!)) out.push(p)
  if (out.length > 1 && samePoint(out[0]!, out[out.length - 1]!)) out.pop()
  return out
}
export function triangulateRing(input: VolumeXY[]): VolumeXY[][] {
  const ring = input.map(p => [...p] as VolumeXY)
  if (signedArea(ring) < 0) ring.reverse()
  // Collinear boundary vertices do not create positive-area ears.
  let changed = true
  while (changed && ring.length > 3) {
    changed = false
    for (let i = 0; i < ring.length; i++) {
      if (onSegment(ring[i]!, ring[(i + ring.length - 1) % ring.length]!, ring[(i + 1) % ring.length]!)) {
        ring.splice(i, 1); changed = true; break
      }
    }
  }
  const triangles: VolumeXY[][] = []
  while (ring.length > 3) {
    let found = false
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length]!, b = ring[i]!, c = ring[(i + 1) % ring.length]!
      if (cross(a, b, c) <= geometryEpsilon) continue
      if (ring.some((p, index) => index !== i && !samePoint(p, a) && !samePoint(p, c)
        && cross(a, b, p) >= -geometryEpsilon && cross(b, c, p) >= -geometryEpsilon && cross(c, a, p) >= -geometryEpsilon)) continue
      triangles.push([a, b, c]); ring.splice(i, 1); found = true; break
    }
    if (!found) throw new Error('Volume boundary cannot be triangulated within numerical resolution')
  }
  triangles.push(ring)
  return triangles
}
export function clipHalfPlane(input: VolumeXY[], value: (point: VolumeXY) => number): VolumeXY[] {
  const out: VolumeXY[] = []
  for (let i = 0; i < input.length; i++) {
    const a = input[i]!, b = input[(i + 1) % input.length]!, da = value(a), db = value(b)
    if (da >= 0) out.push(a)
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db)
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
    }
  }
  return cleanPolygon(out)
}
export function intersectConvex(subject: VolumeXY[], clip: VolumeXY[]): VolumeXY[] {
  let out = subject
  const orientation = signedArea(clip) >= 0 ? 1 : -1
  for (let i = 0; i < clip.length && out.length >= 3; i++) {
    const a = clip[i]!, b = clip[(i + 1) % clip.length]!
    out = clipHalfPlane(out, p => orientation * cross(a, b, p))
  }
  return out.length >= 3 ? out : []
}
export function bounds(points: VolumeXY[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]) }
  return [minX, minY, maxX, maxY]
}
export function boundsOverlap(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}
