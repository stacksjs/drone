import type { KnownSurface, SurfaceMetadata, SurfaceReference, VolumeBase, VolumeBoundary, VolumeReference, VolumeRequest, VolumeXY } from './types'
import { volumeBounds, volumeBoundsOverlap, volumeCross2D, volumeInsideRing, volumeIntersectConvex, volumeOnSegment, volumeSamePoint, volumeSegmentsTouch, volumeSignedArea } from './geometry'

export const volumeLimits = Object.freeze({ vertices: 32768, primitives: 16384, gridCells: 32768, boundaryVertices: 64, holes: 8, integrationPieces: 32768, candidatePairs: 500000, clippingCandidates: 1000000 })
function fail(message: string): never { throw new Error(`Volume input: ${message}`) }
function object(input: unknown, name: string, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(`${name} must be an object`)
  const out = input as Record<string, unknown>
  if (Object.keys(out).some(key => !keys.includes(key))) fail(`${name} contains unsupported fields`)
  if (keys.some(key => !Object.hasOwn(out, key))) fail(`${name} is missing required fields`)
  return out
}
function text(input: unknown, name: string): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024 || /[\u0000-\u001f]/.test(input)) fail(`${name} must be nonempty bounded text`)
  return input
}
function finite(input: unknown, name: string, min = -1e8, max = 1e8): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < min || input > max) fail(`${name} must be a finite number in [${min},${max}]`)
  return input
}
function literal<T extends string>(input: unknown, name: string, choices: readonly T[]): T {
  if (typeof input !== 'string' || !choices.includes(input as T)) fail(`${name} is unsupported`)
  return input as T
}
function exact(input: unknown, expected: unknown, name: string): void { if (input !== expected) fail(`${name} must be ${expected}`) }
function nullableText(input: unknown, name: string): string | null { return input === null ? null : text(input, name) }
function bound(input: unknown, name: string): number | null { return input === null ? null : finite(input, name, 0, 10000) }
function hash(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) fail('sourceSha256 must be a lowercase SHA256 hex digest')
  return input
}
function point(input: unknown, name: string, size: number): number[] {
  if (!Array.isArray(input) || input.length !== size) fail(`${name} needs ${size} coordinates`)
  return input.map((x, i) => finite(x, `${name}[${i}]`))
}
export function validateSurfaceReference(input: unknown): SurfaceReference {
  const r = object(input, 'reference', ['horizontalCrs', 'axes', 'horizontalUnit', 'verticalDatum', 'verticalUnit', 'elevationPositive'])
  const crs = object(r.horizontalCrs, 'horizontalCrs', ['kind', 'id', 'definition', 'coordinateEpoch'])
  const kind = literal(crs.kind, 'CRS kind', ['wgs84-utm', 'engineering']), id = text(crs.id, 'CRS id')
  if (kind === 'wgs84-utm' && !/^EPSG:32[67](0[1-9]|[1-5][0-9]|60)$/.test(id)) fail('horizontal CRS requires metre WGS84 UTM EPSG:32601..32660 or32701..32760')
  if (kind === 'engineering' && !/^LOCAL:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) fail('engineering CRS requires explicit LOCAL: identifier')
  const datum = object(r.verticalDatum, 'verticalDatum', ['kind', 'id', 'definition'])
  exact(r.axes, 'EAST_NORTH', 'axes'); exact(r.horizontalUnit, 'metre', 'horizontalUnit'); exact(r.verticalUnit, 'metre', 'verticalUnit'); exact(r.elevationPositive, 'up', 'elevationPositive')
  return { horizontalCrs: { kind, id, definition: text(crs.definition, 'CRS definition'), coordinateEpoch: nullableText(crs.coordinateEpoch, 'coordinate epoch') }, axes: 'EAST_NORTH', horizontalUnit: 'metre', verticalUnit: 'metre', elevationPositive: 'up', verticalDatum: { kind: literal(datum.kind, 'vertical datum kind', ['ellipsoidal', 'orthometric', 'engineering']), id: text(datum.id, 'datum id'), definition: text(datum.definition, 'datum definition') } }
}
export function validateSurfaceMetadata(input: unknown): SurfaceMetadata {
  const m = object(input, 'metadata', ['version', 'id', 'reference', 'provenance']); exact(m.version, 1, 'metadata version')
  const p = object(m.provenance, 'provenance', ['evidence', 'sourceKind', 'sourceSha256', 'acquisition', 'reconstructionOrMeshing', 'boresightCalibration', 'timeCalibration', 'groundClassification', 'georeferencing'])
  const evidence = literal(p.evidence, 'surface evidence', ['synthetic', 'operator-imported'])
  const sourceKind = literal(p.sourceKind, 'source kind', ['analytic', 'lidar', 'photogrammetry', 'surveyed-mesh'])
  if (evidence === 'synthetic' !== (sourceKind === 'analytic')) fail('synthetic evidence and analytic source kind must agree')
  function stage(value: unknown, name: string): SurfaceMetadata['provenance']['acquisition'] {
    const s = object(value, name, ['status', 'sourceId']), status = literal(s.status, name, ['synthetic', 'external', 'unknown']), sourceId = nullableText(s.sourceId, `${name} source`)
    if ((status === 'unknown') !== (sourceId === null)) fail(`${name} requires a source identity exactly when known`)
    if (evidence === 'synthetic' && status === 'external' || evidence === 'operator-imported' && status === 'synthetic') fail(`${name} evidence contradicts surface evidence`)
    return { status, sourceId }
  }
  function calibration(value: unknown, name: string): SurfaceMetadata['provenance']['timeCalibration'] {
    const s = object(value, name, ['status', 'reportId']), status = literal(s.status, name, ['not-applicable', 'unknown', 'declared']), reportId = nullableText(s.reportId, `${name} report`)
    if ((status === 'declared') !== (reportId !== null)) fail(`${name} declared calibration requires report identity; unknown/not-applicable cannot claim a report`)
    return { status, reportId }
  }
  const c = object(p.groundClassification, 'groundClassification', ['status', 'description', 'reportId'])
  const classificationStatus = literal(c.status, 'classification status', ['unknown', 'declared']), classificationReport = nullableText(c.reportId, 'classification report')
  if ((classificationStatus === 'declared') !== (classificationReport !== null)) fail('classification report and status disagree')
  const g = object(p.georeferencing, 'georeferencing', ['verticalBoundM', 'horizontalBoundM', 'reportId'])
  const verticalBoundM = bound(g.verticalBoundM, 'top vertical bound'), horizontalBoundM = bound(g.horizontalBoundM, 'horizontal bound'), reportId = nullableText(g.reportId, 'georeferencing report')
  if ((verticalBoundM !== null || horizontalBoundM !== null) && reportId === null) fail('declared georeferencing bounds require report identity')
  return { version: 1, id: text(m.id, 'surface id'), reference: validateSurfaceReference(m.reference), provenance: { evidence, sourceKind, sourceSha256: hash(p.sourceSha256), acquisition: stage(p.acquisition, 'acquisition'), reconstructionOrMeshing: stage(p.reconstructionOrMeshing, 'reconstructionOrMeshing'), boresightCalibration: calibration(p.boresightCalibration, 'boresightCalibration'), timeCalibration: calibration(p.timeCalibration, 'timeCalibration'), groundClassification: { status: classificationStatus, description: text(c.description, 'classification description'), reportId: classificationReport }, georeferencing: { verticalBoundM, horizontalBoundM, reportId } } }
}
function checkTin(surface: Extract<KnownSurface['geometry'], { kind: 'tin' }>): void {
  const vertices = surface.vertices, xy = vertices.map(v => [v[0] - vertices[0]![0], v[1] - vertices[0]![1]] as VolumeXY)
  const elevations = new Map<string, number>(), edges = new Map<string, number>(), faces = new Set<string>()
  function key(i: number): string { return `${vertices[i]![0]},${vertices[i]![1]}` }
  for (let i = 0; i < vertices.length; i++) {
    const k = key(i), old = elevations.get(k)
    if (old !== undefined && old !== vertices[i]![2]) fail('TIN has conflicting same-XY elevations')
    elevations.set(k, vertices[i]![2])
  }
  const triangles = surface.triangles.map((indices, id) => {
    const points = indices.map(i => xy[i]!), area = Math.abs(volumeSignedArea(points))
    if (area <= 1e-10) fail('TIN has degenerate horizontal triangle')
    const keys = indices.map(key), face = [...keys].sort().join('|')
    if (faces.has(face)) fail('TIN has duplicate projected face')
    faces.add(face)
    for (let i = 0; i < 3; i++) {
      const edge = [keys[i]!, keys[(i + 1) % 3]!].sort().join('|'), count = (edges.get(edge) ?? 0) + 1
      if (count > 2) fail('TIN has non-manifold shared edge')
      edges.set(edge, count)
    }
    return { id, indices, points, bbox: volumeBounds(points) }
  }).sort((a, b) => a.bbox[0] - b.bbox[0])
  let candidates = 0
  const active: typeof triangles = []
  for (const current of triangles) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i]!.bbox[2] < current.bbox[0]) active.splice(i, 1)
    for (const other of active) {
      if (++candidates > volumeLimits.candidatePairs) fail('TIN topology candidate-pair budget exceeded; tile the surface')
      if (!volumeBoundsOverlap(current.bbox, other.bbox)) continue
      const intersection = volumeIntersectConvex(current.points, other.points)
      if (intersection.length >= 3 && Math.abs(volumeSignedArea(intersection)) > 1e-9) fail('TIN projected interiors overlap; terrain must be single-valued')
      // Even a zero-area shared boundary must agree in elevation, including T-junctions.
      for (const [one, two] of [[current, other], [other, current]]) {
        for (let v = 0; v < 3; v++) for (let e = 0; e < 3; e++) {
          const p = one!.points[v]!, a = two!.points[e]!, b = two!.points[(e + 1) % 3]!
          if (!volumeOnSegment(p, a, b)) continue
          const length2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2
          const t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length2
          const zA = vertices[two!.indices[e]!]![2], zB = vertices[two!.indices[(e + 1) % 3]!]![2], z = vertices[one!.indices[v]!]![2]
          if (Math.abs(z - zA - t * (zB - zA)) > 1e-7) fail('TIN has conflicting shared-boundary elevation')
        }
      }
    }
    active.push(current)
  }
}
export function validateKnownSurface(input: unknown): KnownSurface {
  const s = object(input, 'surface', ['version', 'metadata', 'geometry']); exact(s.version, 1, 'surface version')
  const metadata = validateSurfaceMetadata(s.metadata)
  if (!s.geometry || typeof s.geometry !== 'object') fail('surface geometry missing')
  if ((s.geometry as Record<string, unknown>).kind === 'tin') {
    const g = object(s.geometry, 'TIN', ['kind', 'vertices', 'triangles'])
    if (!Array.isArray(g.vertices) || g.vertices.length < 3 || g.vertices.length > volumeLimits.vertices) fail('TIN vertices exceed supported bounds')
    if (!Array.isArray(g.triangles) || !g.triangles.length || g.triangles.length > volumeLimits.primitives) fail('TIN triangles exceed supported bounds')
    const vertices = g.vertices.map((v, i) => point(v, `vertex ${i}`, 3) as [number, number, number])
    const triangles = g.triangles.map((t, i) => {
      const indices = point(t, `triangle ${i}`, 3)
      if (indices.some(n => !Number.isSafeInteger(n) || n < 0 || n >= vertices.length)) fail('TIN triangle index outside vertices')
      return indices as [number, number, number]
    })
    const geometry = { kind: 'tin' as const, vertices, triangles }; checkTin(geometry)
    return { version: 1, metadata, geometry }
  }
  const g = object(s.geometry, 'grid', ['kind', 'width', 'height', 'westM', 'southM', 'cellSizeM', 'rows', 'rowOrder', 'interpretation'])
  exact(g.kind, 'cell-grid', 'geometry kind'); exact(g.rowOrder, 'north-to-south', 'row order'); exact(g.interpretation, 'piecewise-constant-cell-elevation', 'grid interpretation')
  const width = finite(g.width, 'grid width', 1, volumeLimits.gridCells), height = finite(g.height, 'grid height', 1, volumeLimits.gridCells)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > volumeLimits.gridCells) fail('grid cell count exceeds supported bounds')
  const cellSizeM = finite(g.cellSizeM, 'cell size', 1e-5, 1e6), westM = finite(g.westM, 'west'), southM = finite(g.southM, 'south')
  finite(westM + width * cellSizeM, 'grid east'); finite(southM + height * cellSizeM, 'grid north')
  if (!Array.isArray(g.rows) || g.rows.length !== height) fail('grid needs exact row count')
  const rows = g.rows.map((row, r) => {
    if (!Array.isArray(row) || row.length !== width) fail('grid needs exact column count')
    return row.map((z, c) => z === null ? null : finite(z, `grid ${r},${c}`))
  })
  if (!rows.some(row => row.some(z => z !== null))) fail('grid has no valid surface cells')
  return { version: 1, metadata, geometry: { kind: 'cell-grid', width, height, westM, southM, cellSizeM, rows, rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' } }
}
function boundary(input: unknown): VolumeBoundary {
  const b = object(input, 'boundary', ['outer', 'holes'])
  if (!Array.isArray(b.holes) || b.holes.length > volumeLimits.holes) fail('boundary holes exceed supported bounds')
  function ring(value: unknown): VolumeXY[] {
    if (!Array.isArray(value) || value.length < 3 || value.length > volumeLimits.boundaryVertices) fail('boundary ring vertex count invalid')
    const points = value.map((p, i) => point(p, `boundary vertex ${i}`, 2) as VolumeXY)
    for (let i = 0; i < points.length; i++) {
      if (volumeSamePoint(points[i]!, points[(i + 1) % points.length]!)) fail('boundary ring has repeated adjacent vertex or explicit closing vertex')
      const prev = points[(i + points.length - 1) % points.length]!, next = points[(i + 1) % points.length]!
      if (Math.abs(volumeCross2D(prev, points[i]!, next)) < 1e-9 && !volumeOnSegment(points[i]!, prev, next)) fail('boundary doubles back along an edge')
      for (let j = i + 1; j < points.length; j++) {
        if (j === i + 1 || i === 0 && j === points.length - 1) continue
        if (volumeSegmentsTouch(points[i]!, points[(i + 1) % points.length]!, points[j]!, points[(j + 1) % points.length]!)) fail('boundary ring self-intersects or touches')
      }
    }
    if (Math.abs(volumeSignedArea(points)) < 1e-8) fail('boundary has zero or unresolved area')
    return points
  }
  const outer = ring(b.outer), holes = b.holes.map(ring), all = [outer, ...holes]
  if (all.reduce((sum, r) => sum + r.length, 0) > volumeLimits.boundaryVertices) fail('total boundary vertex budget exceeded')
  for (let h = 1; h < all.length; h++) {
    if (!volumeInsideRing(all[h]![0]!, outer)) fail('boundary hole lies outside outer ring')
    for (let j = 0; j < h; j++) {
      const a = all[h]!, c = all[j]!
      for (let i = 0; i < a.length; i++) for (let k = 0; k < c.length; k++) if (volumeSegmentsTouch(a[i]!, a[(i + 1) % a.length]!, c[k]!, c[(k + 1) % c.length]!)) fail('boundary rings cross or touch')
      if (j > 0 && (volumeInsideRing(a[0]!, c) || volumeInsideRing(c[0]!, a))) fail('boundary holes overlap or nest')
    }
  }
  return { outer, holes }
}
function base(input: unknown): VolumeBase {
  const b = object(input, 'base', ['kind', 'anchorM', 'gradientEast', 'gradientNorth', 'assumption', 'evidence', 'verticalBoundM']); exact(b.kind, 'plane', 'base kind')
  return { kind: 'plane', anchorM: point(b.anchorM, 'base anchor', 3) as [number, number, number], gradientEast: finite(b.gradientEast, 'base east gradient', -100, 100), gradientNorth: finite(b.gradientNorth, 'base north gradient', -100, 100), assumption: text(b.assumption, 'base assumption'), evidence: literal(b.evidence, 'base evidence', ['synthetic', 'operator-assumed', 'operator-declared-survey']), verticalBoundM: bound(b.verticalBoundM, 'base vertical bound') }
}
function canonicalBoundary(value: VolumeBoundary): string {
  const canonical = (ring: VolumeXY[]) => {
    const variants: string[] = []
    for (const order of [ring, [...ring].reverse()]) for (let i = 0; i < ring.length; i++) variants.push(JSON.stringify([...order.slice(i), ...order.slice(0, i)]))
    return variants.sort()[0]!
  }
  return JSON.stringify([canonical(value.outer), value.holes.map(canonical).sort()])
}
export function validateVolumeRequest(input: unknown): VolumeRequest {
  const r = object(input, 'request', ['version', 'id', 'surface', 'boundary', 'base', 'reference']); exact(r.version, 1, 'request version')
  const surface = validateKnownSurface(r.surface), domain = boundary(r.boundary), plane = base(r.base)
  if (surface.metadata.provenance.evidence === 'synthetic' && plane.evidence !== 'synthetic') fail('synthetic surface cannot claim a physical base survey')
  let reference: VolumeReference | null = null
  if (r.reference !== null) {
    const v = object(r.reference, 'comparison reference', ['id', 'evidence', 'sourceSha256', 'surveyedAt', 'method', 'independence', 'reference', 'boundary', 'base', 'aboveBaseM3', 'belowBaseM3', 'volumeBoundM3'])
    const refFrame = validateSurfaceReference(v.reference), refBoundary = boundary(v.boundary), refBase = base(v.base), evidence = literal(v.evidence, 'reference evidence', ['synthetic', 'operator-declared-survey'])
    if (JSON.stringify(refFrame) !== JSON.stringify(surface.metadata.reference)) fail('comparison CRS, datum, units or coordinate epoch mismatch')
    if (canonicalBoundary(refBoundary) !== canonicalBoundary(domain)) fail('comparison boundary mismatch')
    // Anchors may differ along the identical plane; uncertainty/evidence remain separately declared.
    const refAtAnchor = refBase.anchorM[2] + refBase.gradientEast * (plane.anchorM[0] - refBase.anchorM[0]) + refBase.gradientNorth * (plane.anchorM[1] - refBase.anchorM[1])
    if (Math.abs(refAtAnchor - plane.anchorM[2]) > 1e-8 || refBase.gradientEast !== plane.gradientEast || refBase.gradientNorth !== plane.gradientNorth) fail('comparison base convention mismatch')
    if (surface.metadata.provenance.evidence === 'synthetic' && evidence !== 'synthetic') fail('synthetic surface cannot be promoted to surveyed comparison evidence')
    const surveyedAt = text(v.surveyedAt, 'reference survey date')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(surveyedAt) || !Number.isFinite(Date.parse(surveyedAt)) || new Date(surveyedAt).toISOString().slice(0, 19) !== surveyedAt.slice(0, 19)) fail('reference surveyedAt must be a valid ISO UTC calendar date')
    if (v.independence === 'declared-independent' && (v.id === surface.metadata.id || v.id === r.id || v.sourceSha256 === surface.metadata.provenance.sourceSha256)) fail('independent comparison requires a distinct source identity and digest')
    reference = { id: text(v.id, 'reference id'), evidence, sourceSha256: hash(v.sourceSha256), surveyedAt, method: text(v.method, 'reference method'), independence: literal(v.independence, 'reference independence', ['declared-independent', 'not-independent']), reference: refFrame, boundary: refBoundary, base: refBase, aboveBaseM3: finite(v.aboveBaseM3, 'reference above volume', 0, 1e20), belowBaseM3: finite(v.belowBaseM3, 'reference below volume', 0, 1e20), volumeBoundM3: v.volumeBoundM3 === null ? null : finite(v.volumeBoundM3, 'reference bound', 0, 1e20) }
  }
  return { version: 1, id: text(r.id, 'request id'), surface, boundary: domain, base: plane, reference }
}
