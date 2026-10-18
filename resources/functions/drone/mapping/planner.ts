import type { SensorVector } from '../sensors/types'
import type { SurveyConfig, SurveyLane, SurveyPlan, SurveyPoint } from './types'
import { createCalibratedCamera } from '../camera/calibrated'
import { geodeticToEcef } from '../estimation/frames'

function fail(reason: string): never { throw new RangeError(`Invalid survey: ${reason}`) }
function record(value: unknown, fields: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key))) fail(`${label} fields`)
}
function bounded(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label)
}
function cross(a: SurveyPoint, b: SurveyPoint, c: SurveyPoint): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) }
function on(a: SurveyPoint, b: SurveyPoint, p: SurveyPoint): boolean {
  return Math.abs(cross(a, b, p)) < 1e-9 && p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9 && p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9
}
function intersects(a: SurveyPoint, b: SurveyPoint, c: SurveyPoint, d: SurveyPoint): boolean {
  return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b) || (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
}
function area(ring: SurveyPoint[]): number { return Math.abs(ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]!; return sum + p[0] * q[1] - q[0] * p[1] }, 0)) / 2 }
function inside(point: SurveyPoint, ring: SurveyPoint[]): boolean {
  let result = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!
    if (on(a, b, point)) return false
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result
  }
  return result
}
function validateRing(value: unknown): asserts value is SurveyPoint[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 64) fail('polygon vertex budget')
  for (const p of value) {
    if (!Array.isArray(p) || p.length !== 2) fail('polygon coordinate')
    for (const n of p) bounded(n, -500, 500, 'polygon coordinate')
  }
  const ring = value as SurveyPoint[]
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-5) fail('duplicate polygon vertex')
    for (let j = i + 1; j < ring.length; j++) {
      if (j === i + 1 || (i === 0 && j === ring.length - 1)) continue
      if (intersects(a, b, ring[j]!, ring[(j + 1) % ring.length]!)) fail('self-intersecting polygon')
    }
    const c = ring[(i + 2) % ring.length]!
    if (Math.abs(cross(a, b, c)) < 1e-9) fail('collinear polygon vertices')
  }
  if (area(ring) < .0001) fail('polygon area')
}
function ringsTouch(a: SurveyPoint[], b: SurveyPoint[]): boolean {
  return a.some((p, i) => b.some((q, j) => intersects(p, a[(i + 1) % a.length]!, q, b[(j + 1) % b.length]!)))
}

/** Strict, bounded transect planning. AOI exclusions are imaging masks, not no-fly regions. */
export function createSurveyPlan(input: unknown): SurveyPlan {
  record(input, ['version', 'id', 'origin', 'boundary', 'holes', 'altitudeAglM', 'maxGsdM', 'overlap', 'headingDeg', 'crosshatch', 'terrain', 'speedMps', 'minTriggerIntervalMs', 'exposureTimeUs', 'power', 'calibration', 'heldOut'], 'config')
  const c = input as unknown as SurveyConfig
  if (c.version !== 1 || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id)) fail('version or identifier')
  record(c.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM'], 'origin'); geodeticToEcef(c.origin)
  validateRing(c.boundary)
  if (!Array.isArray(c.holes) || c.holes.length > 8) fail('hole budget')
  for (let i = 0; i < c.holes.length; i++) {
    const hole = c.holes[i]!; validateRing(hole)
    if (ringsTouch(c.boundary, hole) || !hole.every(p => inside(p, c.boundary))) fail('hole outside or touching boundary')
    for (let j = 0; j < i; j++) if (ringsTouch(hole, c.holes[j]!) || inside(hole[0]!, c.holes[j]!) || inside(c.holes[j]![0]!, hole)) fail('overlapping or nested holes')
  }
  if (c.boundary.length + c.holes.reduce((sum, h) => sum + h.length, 0) > 128) fail('total vertex budget')
  bounded(c.altitudeAglM, .5, 100, 'altitude'); bounded(c.maxGsdM, .001, 10, 'maximum GSD')
  record(c.overlap, ['front', 'side'], 'overlap'); bounded(c.overlap.front, .1, .9, 'front overlap'); bounded(c.overlap.side, .1, .9, 'side overlap')
  bounded(c.headingDeg, -180, 180, 'heading'); if (typeof c.crosshatch !== 'boolean') fail('crosshatch')
  record(c.terrain, ['downAtOriginM', 'gradient'], 'terrain'); bounded(c.terrain.downAtOriginM, -100, 100, 'terrain origin')
  if (!Array.isArray(c.terrain.gradient) || c.terrain.gradient.length !== 2) fail('terrain gradient')
  for (const n of c.terrain.gradient) bounded(n, -.1, .1, 'terrain gradient')
  const slope = Math.hypot(...c.terrain.gradient); if (slope > .1) fail('terrain slope')
  bounded(c.speedMps, .05, .6, 'speed'); bounded(c.minTriggerIntervalMs, 20, 10000, 'trigger interval'); bounded(c.exposureTimeUs, 10, 100000, 'exposure')
  if (!Number.isInteger(c.minTriggerIntervalMs) || !Number.isInteger(c.exposureTimeUs) || c.exposureTimeUs / 1000 >= c.minTriggerIntervalMs) fail('capture timing')
  record(c.power, ['availableWh', 'hoverW', 'reservePercent'], 'power'); bounded(c.power.availableWh, .1, 10000, 'available power'); bounded(c.power.hoverW, 100, 2000, 'hover power'); bounded(c.power.reservePercent, 25, 80, 'reserve')
  const camera = createCalibratedCamera(c.calibration, c.heldOut), calibration = camera.calibration
  if (Math.hypot(camera.originBodyM[0], camera.originBodyM[1]) > 1e-8) fail('centered nadir lever required')
  if (calibration.evidence !== 'synthetic' && calibration.evidence !== 'declared-bench') fail('calibration evidence')
  const down = camera.bodyRay([calibration.output.width / 2, calibration.output.height / 2])
  // Plan certificate requires a centered nadir optical axis. Actual capture attitudes are projected separately.
  const q = calibration.extrinsics.quaternionWxyz
  const nadir = [Math.SQRT1_2, 0, 0, -Math.SQRT1_2]
  if (Math.min(Math.hypot(...q.map((n, i) => n - nadir[i]!)), Math.hypot(...q.map((n, i) => n + nadir[i]!))) > 1e-6 || Math.hypot(down[0], down[1]) > 1e-8) fail('centered nadir camera required')
  const depth = c.altitudeAglM - camera.originBodyM[2]
  const [k1, k2, p1, p2, k3] = calibration.intrinsics.distortion
  const derivativeDelta = 12 * Math.abs(k1) + 80 * Math.abs(k2) + 448 * Math.abs(k3) + 16 * (Math.abs(p1) + Math.abs(p2))
  const i = calibration.intrinsics, crop = calibration.output.crop
  const opticalRadius = Math.min((i.cx - crop[0]) / i.fx, (crop[0] + crop[2] - i.cx) / i.fx, (i.cy - crop[1]) / i.fy, (crop[1] + crop[3] - i.cy) / i.fy) / (1 + derivativeDelta)
  if (opticalRadius <= 0 || opticalRadius > 2) fail('uncertified nadir field of view')
  const cornerRays = ([[0, 0], [calibration.output.width, 0], [0, calibration.output.height], [calibration.output.width, calibration.output.height]] as SurveyPoint[]).map(pixel => camera.bodyRay(pixel))
  const radius = Math.max(...cornerRays.map(ray => Math.hypot(ray[0], ray[1])))
  const minimumDepth = depth / (1 + slope * radius), maximumDepth = depth / (1 - slope * radius)
  if (1 - slope * radius <= .1 || minimumDepth < camera.report.minDepthM || maximumDepth > camera.report.maxDepthM) fail('terrain outside calibrated depth coverage')
  const width = Math.SQRT2 * depth * opticalRadius / (1 + slope * opticalRadius)
  // An inscribed square fits every transect heading. The distortion derivative bound holds over the full certified lens disc.
  const gsdM = maximumDepth * Math.max(crop[2] / calibration.output.width / i.fx, crop[3] / calibration.output.height / i.fy) / (1 - derivativeDelta) * (1 + radius * slope) / (1 - radius * slope)
  if (gsdM > c.maxGsdM) fail('maximum GSD exceeded')
  const captureSpacingM = width * (1 - c.overlap.front), laneSpacing = width * (1 - c.overlap.side)
  const triggerIntervalMs = Math.floor(captureSpacingM / c.speedMps * 1000)
  if (triggerIntervalMs < c.minTriggerIntervalMs) fail('camera trigger capacity exceeded')
  const lanes: SurveyLane[] = []
  for (const headingDeg of c.crosshatch ? [c.headingDeg, c.headingDeg + 90] : [c.headingDeg]) {
    const angle = headingDeg * Math.PI / 180
    const along: SurveyPoint = [Math.cos(angle), Math.sin(angle)]
    const across: SurveyPoint = [-along[1], along[0]]
    const rings = [c.boundary, ...c.holes].map(ring => ring.map(p => [p[0] * along[0] + p[1] * along[1], p[0] * across[0] + p[1] * across[1]] as SurveyPoint))
    const low = Math.min(...rings[0]!.map(p => p[1])), high = Math.max(...rings[0]!.map(p => p[1]))
    const count = Math.ceil((high - low) / laneSpacing)
    if (!Number.isFinite(count) || count > 128) fail('lane resource budget')
    for (let row = 0; row < count; row++) {
      const y = low + (row + .5) * (high - low) / count
      const events: { x: number, outer: boolean }[] = []
      for (let r = 0; r < rings.length; r++) for (let v = 0; v < rings[r]!.length; v++) {
        const a = rings[r]![v]!, b = rings[r]![(v + 1) % rings[r]!.length]!
        if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) events.push({ x: a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]), outer: r === 0 })
      }
      events.sort((a, b) => a.x - b.x)
      let inOuter = false, inHole = false
      const segments: [number, number][] = []
      for (let e = 0; e < events.length - 1; e++) {
        if (events[e]!.outer) inOuter = !inOuter; else inHole = !inHole
        if (inOuter && !inHole && events[e + 1]!.x - events[e]!.x > 1e-6) segments.push([events[e]!.x, events[e + 1]!.x])
      }
      if (row % 2) segments.reverse()
      for (const segment of segments) {
        const [start, end] = row % 2 ? [segment[1], segment[0]] : segment
        const point = (x: number): SensorVector => { const n = x * along[0] + y * across[0], e = x * along[1] + y * across[1]; return [n, e, c.terrain.downAtOriginM + c.terrain.gradient[0] * n + c.terrain.gradient[1] * e - c.altitudeAglM] }
        const fromM = point(start!), toM = point(end!)
        lanes.push({ id: `lane-${lanes.length + 1}`, fromM, toM, lengthM: Math.hypot(...toM.map((n, d) => n - fromM[d]!)), headingDeg })
        if (lanes.length > 128) fail('lane resource budget')
      }
    }
  }
  if (!lanes.length) fail('empty clipped survey')
  let distanceM = 0, previous: SensorVector = [0, 0, 0]
  for (const lane of lanes) { distanceM += Math.hypot(...lane.fromM.map((n, d) => n - previous[d]!)) + lane.lengthM; previous = lane.toM }
  distanceM += Math.hypot(...previous)
  const estimatedSeconds = distanceM / c.speedMps + 16 + lanes.length * 4
  const requiredWh = estimatedSeconds * c.power.hoverW / 3600
  if (requiredWh > c.power.availableWh * (1 - c.power.reservePercent / 100)) fail('endurance reserve exceeded')
  return { version: 1, config: structuredClone(c), areaM2: area(c.boundary) - c.holes.reduce((sum, h) => sum + area(h), 0), lanes, footprintM: { along: width, across: width }, gsdM, captureSpacingM, triggerIntervalMs, estimatedPhotos: lanes.reduce((sum, lane) => sum + Math.ceil(lane.lengthM / captureSpacingM) + 1, 0), distanceM, estimatedSeconds, requiredWh, assumptions: ['Collection only; no reconstruction or measured survey accuracy.', 'Nadir planned pose with initial simulation north; absolute heading is not observed.', 'Conservative central footprint square, certified lens derivative and declared terrain plane.', 'AOI holes exclude imaging transects; connectors may cross holes and footprints may extend outside the AOI.', 'Endurance estimate includes launch, return, transit and settling; wind and physical battery performance are unverified.'] }
}
