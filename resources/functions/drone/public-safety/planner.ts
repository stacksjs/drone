import type { PublicSafetyConfig, PublicSafetyPlan } from './types'
import type { SurveyPoint } from '../mapping/types'
import { createSurveyPlan } from '../mapping/planner'
import { compileSurveyMission } from '../mapping/runtime'
import { volumeCross2D, volumeInsideRing, volumeOnSegment, volumeSegmentsTouch, volumeSignedArea } from '../volumes/geometry'

function fail(reason: string): never { throw new TypeError(`Invalid public-safety incident: ${reason}`) }
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail('record fields')
}
function id(value: unknown) { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail('identifier') }
/** Bound plain data and inspect descriptors before reading or cloning caller values. */
function bounded(input: unknown) {
  let nodes = 0, bytes = 0
  const ancestors = new Set<object>()
  function walk(value: unknown, depth: number): void {
    if (++nodes > 6000 || depth > 14) fail('structure budget')
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('finite quantity'); bytes += 24 }
    else if (typeof value === 'string') { if (value.length > 2048) fail('text budget'); bytes += value.length * 3 + 2 }
    else if (value === null || typeof value === 'boolean') bytes += 5
    else if (value && typeof value === 'object') {
      const array = Array.isArray(value)
      if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) fail('plain acyclic data required')
      if (array && value.length > 128) fail('array budget')
      ancestors.add(value)
      const names = Object.getOwnPropertyNames(value)
      if (names.length > 129) fail('record budget')
      let count = 0
      for (const name of names) {
        if (array && name === 'length') continue
        if (array && name !== String(count++)) fail('dense plain array required')
        const descriptor = Object.getOwnPropertyDescriptor(value, name)!
        if (!('value' in descriptor) || !descriptor.enumerable) fail('accessor or hidden data')
        bytes += name.length * 3 + 4; walk(descriptor.value, depth + 1)
      }
      if (array && count !== value.length) fail('sparse array')
      ancestors.delete(value)
    }
    else fail('unsupported value')
    if (bytes > 256 * 1024) fail('byte budget')
  }
  walk(input, 0)
}
function polygon(input: unknown): asserts input is SurveyPoint[] {
  if (!Array.isArray(input) || input.length < 3 || input.length > 32) fail('polygon vertex budget')
  for (const p of input) if (!Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 50)) fail('local north/east coordinate')
  for (let i = 0; i < input.length; i++) {
    const a = input[i]!, b = input[(i + 1) % input.length]!, c = input[(i + 2) % input.length]!
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 || Math.abs(volumeCross2D(a, b, c)) < 1e-10) fail('degenerate polygon edge')
    for (let j = i + 1; j < input.length; j++) {
      if (j === i + 1 || i === 0 && j === input.length - 1) continue
      if (volumeSegmentsTouch(a, b, input[j]!, input[(j + 1) % input.length]!)) fail('self-intersecting polygon')
    }
  }
  if (Math.abs(volumeSignedArea(input)) < .0001) fail('polygon area')
}
/** Exact edge-intersection partition catches concave excursions that endpoint checks miss. */
export function publicSafetySegmentInside(a: SurveyPoint, b: SurveyPoint, ring: SurveyPoint[]): boolean {
  if (!volumeInsideRing(a, ring) || !volumeInsideRing(b, ring)) return false
  const dn = b[0] - a[0], de = b[1] - a[1], length2 = dn * dn + de * de
  if (length2 < 1e-18) return true
  const events = [0, 1]
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i]!, d = ring[(i + 1) % ring.length]!, cn = d[0] - c[0], ce = d[1] - c[1], denominator = dn * ce - de * cn
    if (Math.abs(denominator) > 1e-12) {
      const t = ((c[0] - a[0]) * ce - (c[1] - a[1]) * cn) / denominator
      const u = ((c[0] - a[0]) * de - (c[1] - a[1]) * dn) / denominator
      if (t > 0 && t < 1 && u >= -1e-9 && u <= 1 + 1e-9) events.push(t)
    }
    else for (const point of [c, d]) if (volumeOnSegment(point, a, b)) events.push(((point[0] - a[0]) * dn + (point[1] - a[1]) * de) / length2)
  }
  events.sort((x, y) => x - y)
  return events.every((t, i) => i === 0 || volumeInsideRing([a[0] + dn * (t + events[i - 1]!) / 2, a[1] + de * (t + events[i - 1]!) / 2], ring))
}
function contained(ring: SurveyPoint[], operating: SurveyPoint[]) { return ring.every((p, i) => publicSafetySegmentInside(p, ring[(i + 1) % ring.length]!, operating)) }

/** One explicitly selected incident sector executes through the owned survey mission engine. */
export function planPublicSafetyMission(input: unknown): PublicSafetyPlan {
  bounded(input)
  fields(input, ['version', 'id', 'revision', 'visitId', 'purpose', 'policyId', 'purposeAuthority', 'retention', 'survey', 'operatingBoundary', 'noObserveZones', 'sectors', 'sectorId'])
  const c = input as unknown as PublicSafetyConfig
  if (c.version !== 1 || !['search-and-rescue', 'fire-observation', 'disaster-assessment', 'lawful-police-observation'].includes(c.purpose)) fail('version or purpose')
  for (const value of [c.id, c.revision, c.visitId, c.policyId, c.sectorId]) id(value)
  fields(c.purposeAuthority, ['status', 'reference'])
  if (!['simulation-declared', 'unqualified'].includes(c.purposeAuthority.status) || (c.purposeAuthority.reference !== null && (typeof c.purposeAuthority.reference !== 'string' || !c.purposeAuthority.reference.trim() || c.purposeAuthority.reference.length > 256)) || c.purposeAuthority.status === 'simulation-declared' && c.purposeAuthority.reference === null) fail('declared purpose authority')
  fields(c.retention, ['policyId', 'expiresAt', 'hold']); id(c.retention.policyId)
  if (typeof c.retention.expiresAt !== 'string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.retention.expiresAt) || !Number.isFinite(Date.parse(c.retention.expiresAt)) || new Date(c.retention.expiresAt).toISOString() !== c.retention.expiresAt || !['none', 'declared-review-required'].includes(c.retention.hold)) fail('explicit canonical retention expiry or hold')
  polygon(c.operatingBoundary)
  if (!volumeInsideRing([0, 0], c.operatingBoundary)) fail('launch and return outside operating boundary')
  if (!Array.isArray(c.sectors) || c.sectors.length < 1 || c.sectors.length > 8 || !Array.isArray(c.noObserveZones) || c.noObserveZones.length > 8) fail('sector or privacy zone budget')
  let vertices = c.operatingBoundary.length
  const sectors = new Set<string>()
  for (const sector of c.sectors) {
    fields(sector, ['id', 'boundary']); id(sector.id); polygon(sector.boundary)
    if (sectors.has(sector.id) || !contained(sector.boundary, c.operatingBoundary)) fail('duplicate or out-of-boundary sector')
    sectors.add(sector.id); vertices += sector.boundary.length
  }
  for (const zone of c.noObserveZones) { polygon(zone); vertices += zone.length }
  if (vertices > 256) fail('total polygon vertex budget')
  const selected = c.sectors.find(sector => sector.id === c.sectorId)
  if (!selected || JSON.stringify(selected.boundary) !== JSON.stringify(c.survey.boundary)) fail('survey must exactly name the selected search sector')
  const survey = createSurveyPlan(c.survey)
  if (survey.config.origin.latitudeDeg !== 0 || survey.config.origin.longitudeDeg !== 0 || survey.config.origin.ellipsoidHeightM !== 100 || survey.config.calibration.evidence !== 'synthetic') fail('owned synthetic fixture origin or calibration')
  const { width, height } = survey.config.calibration.output
  if (width < 16 || height < 16 || width * height > 65536) fail('synthetic raster budget')
  const mission = compileSurveyMission(survey)
  let previous: SurveyPoint = [0, 0]
  for (const lane of survey.lanes) {
    const from: SurveyPoint = [lane.fromM[0], lane.fromM[1]], to: SurveyPoint = [lane.toM[0], lane.toM[1]]
    if (!publicSafetySegmentInside(previous, from, c.operatingBoundary) || !publicSafetySegmentInside(from, to, c.operatingBoundary)) fail('route segment leaves operating boundary')
    previous = to
  }
  if (!publicSafetySegmentInside(previous, [0, 0], c.operatingBoundary)) fail('return segment leaves operating boundary')
  return { version: 1, config: structuredClone(c), survey, mission, sectorId: c.sectorId, searchAreaM2: survey.areaM2, assumptions: [
    'One selected bounded sector per owned mission; other sectors remain unsearched.',
    'Route centers and complete straight connectors are inside the operating boundary; flight tracking error and obstacles remain unqualified.',
    'Visible and thermal ground-plane imagery is synthetic, with calibrated truth-ray privacy masking before storage.',
    'Estimated pose and uncertainty govern admission and geolocation separately; physical privacy registration and thermal radiometry remain unqualified.',
    'Purpose authority and retention are explicit declarations, not authenticated role membership, legal authority or automatic erasure.',
    'No autonomous person identification, pursuit, enforcement or tactical response.',
  ] }
}
