import { expect, test } from 'bun:test'
import { processStockpile, validateVolumeRequest } from '../../resources/functions/drone/volumes/engine'
import { exampleVolumeRequest } from '../../resources/functions/drone/volumes/fixtures'

// Public function seam catches geometry, provenance and numerical errors, not physical survey accuracy.
test('integrates an independently specified square pyramid, detached from caller state', () => {
  const request = exampleVolumeRequest('pyramid')
  const report = processStockpile(request)
  expect(report.boundaryAreaM2).toBeCloseTo(16, 10)
  expect(report.coveredAreaM2).toBeCloseTo(16, 10)
  expect(report.aboveBaseM3).toBeCloseTo(16, 10)
  expect(report.belowBaseM3).toBe(0)
  expect(report.signedTopMinusBaseM3).toBeCloseTo(16, 10)
  expect(report.fullBoundarySignedM3).toBeCloseTo(16, 10)
  expect(report.physicalAccuracyVerified).toBe(false)
  const detached = validateVolumeRequest(request)
  detached.surface.metadata.id = 'changed'
  expect(request.surface.metadata.id).not.toBe('changed')
})

test('clips an affine wedge and independently splits the crossing zero line', () => {
  const wedge = exampleVolumeRequest()
  wedge.surface.geometry = { kind: 'tin', vertices: [[0, 0, 0], [4, 0, 4], [4, 3, 4], [0, 3, 0]], triangles: [[0, 1, 2], [0, 2, 3]] }
  wedge.boundary.outer = [[0, 0], [4, 0], [4, 3], [0, 3]]
  expect(processStockpile(wedge).aboveBaseM3).toBeCloseTo(24, 10)
  wedge.boundary.outer = [[1, 0], [4, 0], [4, 3], [1, 3]]
  expect(processStockpile(wedge).aboveBaseM3).toBeCloseTo(22.5, 10)
  wedge.boundary.outer = [[0, 0], [2, 0], [0, 2]]
  expect(processStockpile(wedge).aboveBaseM3).toBeCloseTo(4 / 3, 10)
  const crossing = processStockpile(exampleVolumeRequest('cut-fill'))
  expect(crossing.aboveBaseM3).toBeCloseTo(.5, 10)
  expect(crossing.belowBaseM3).toBeCloseTo(.5, 10)
  expect(crossing.signedTopMinusBaseM3).toBeCloseTo(0, 10)
  expect(crossing.coveredAreaM2).toBeCloseTo(2, 10)
  expect(crossing.integrationPieces.some(p => p.aboveBaseM3 > 0)).toBe(true)
  expect(crossing.integrationPieces.some(p => p.belowBaseM3 > 0)).toBe(true)
  expect(crossing.integrationPieces.every(p => p.aboveBaseM3 === 0 || p.belowBaseM3 === 0)).toBe(true)
})

test('retains exact concavity, signed hole exclusions and disconnected gaps', () => {
  const request = exampleVolumeRequest()
  request.boundary.holes = [[[1, 1], [3, 1], [3, 3], [1, 3]]]
  const hollow = processStockpile(request)
  expect(hollow.boundaryAreaM2).toBeCloseTo(12, 10)
  expect(hollow.aboveBaseM3).toBeCloseTo(8, 10)
  expect(hollow.integrationPieces.some(p => p.weight === -1)).toBe(true)
  expect(hollow.integrationPieces.reduce((sum, p) => sum + p.weight * p.areaM2, 0)).toBeCloseTo(12, 10)
  expect(hollow.integrationPieces.reduce((sum, p) => sum + p.weight * p.aboveBaseM3, 0)).toBeCloseTo(8, 10)
  const gap = processStockpile(exampleVolumeRequest('coverage-gap'))
  expect(gap.coveredAreaM2).toBeCloseTo(12, 10)
  expect(gap.uncoveredAreaM2).toBeCloseTo(4, 10)
  expect(gap.aboveBaseM3).toBeCloseTo(12, 10)
  expect(gap.fullBoundarySignedM3).toBeNull()
  expect(gap.status).toBe('partial-coverage')
  request.surface.geometry = { kind: 'tin', vertices: [[0, 0, 0], [4, 0, 4], [4, 3, 4], [0, 3, 0]], triangles: [[0, 1, 2], [0, 2, 3]] }
  request.boundary = { outer: [[0, 0], [4, 0], [4, 1], [1, 1], [1, 3], [0, 3]], holes: [[[.25, .25], [.75, .25], [.75, .75], [.25, .75]]] }
  const concave = processStockpile(request)
  expect(concave.boundaryAreaM2).toBeCloseTo(5.75, 10)
  expect(concave.aboveBaseM3).toBeCloseTo(8.875, 10)
  expect(concave.uncoveredAreaM2).toBeCloseTo(0, 10)
})

test('integrates cell areas with north-first rows, null gaps and partial-cell clips', () => {
  const request = exampleVolumeRequest()
  request.surface.geometry = { kind: 'cell-grid', width: 2, height: 2, westM: 0, southM: 0, cellSizeM: 1, rows: [[2, null], [-1, 4]], rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' }
  request.boundary.outer = [[0, 0], [2, 0], [2, 2], [0, 2]]
  const full = processStockpile(request)
  expect(full.aboveBaseM3).toBeCloseTo(6, 10)
  expect(full.belowBaseM3).toBeCloseTo(1, 10)
  expect(full.signedTopMinusBaseM3).toBeCloseTo(5, 10)
  expect(full.coveredAreaM2).toBeCloseTo(3, 10)
  expect(full.excludedGridCells).toEqual([{ row: 0, column: 1 }])
  request.boundary.outer = [[.5, 0], [2, 0], [2, 1], [.5, 1]]
  const bottom = processStockpile(request)
  expect(bottom.coveredAreaM2).toBeCloseTo(1.5, 10)
  expect(bottom.aboveBaseM3).toBeCloseTo(4, 10)
  expect(bottom.belowBaseM3).toBeCloseTo(.5, 10)
  expect(bottom.signedTopMinusBaseM3).toBeCloseTo(3.5, 10)
  request.surface.geometry = { kind: 'cell-grid', width: 1, height: 1, westM: -1, southM: 0, cellSizeM: 2, rows: [[0]], rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' }
  request.boundary.outer = [[-1, 0], [1, 0], [1, 1], [-1, 1]]
  request.base.gradientEast = 1
  const split = processStockpile(request)
  expect(split.aboveBaseM3).toBeCloseTo(.5, 10)
  expect(split.belowBaseM3).toBeCloseTo(.5, 10)
})

test('preserves volume under large projected translations, face winding/order, and a shared tilted basal plane', () => {
  const request = exampleVolumeRequest()
  if (request.surface.geometry.kind !== 'tin') throw new Error('Fixture requires TIN')
  request.surface.geometry.vertices = request.surface.geometry.vertices.map(([e, n, z]) => [e + 500000, n + 6000000, z + 120])
  request.surface.geometry.triangles = request.surface.geometry.triangles.reverse().map(([a, b, c]) => [c, b, a])
  request.boundary.outer = request.boundary.outer.reverse().map(([e, n]) => [e + 500000, n + 6000000])
  request.base.anchorM = [500000, 6000000, 120]
  request.surface.metadata.reference.horizontalCrs = { kind: 'wgs84-utm', id: 'EPSG:32610', definition: 'Declared WGS84 UTM zone 10N metres', coordinateEpoch: '2026.0' }
  const projected = processStockpile(request)
  expect(projected.boundaryAreaM2).toBeCloseTo(16, 10)
  expect(projected.aboveBaseM3).toBeCloseTo(16, 10)
  expect(processStockpile(exampleVolumeRequest('tilted-base')).signedTopMinusBaseM3).toBeCloseTo(16, 10)
  const biased = exampleVolumeRequest()
  if (biased.surface.geometry.kind !== 'tin') throw new Error('Fixture requires TIN')
  for (const p of biased.surface.geometry.vertices) p[2] += .1
  const report = processStockpile(biased)
  expect(report.signedTopMinusBaseM3).toBeCloseTo(17.6, 10)
  expect(report.uncertainty.conditionalVerticalBoundM3).toBeCloseTo(2.4, 10)
  expect(report.uncertainty.overallAccuracyBoundM3).toBeNull()
  expect(report.uncertainty.horizontalBoundM).toBeNull()
  expect(processStockpile(exampleVolumeRequest('unknown-uncertainty')).uncertainty.conditionalVerticalBoundM3).toBeNull()
})

test('reports declared comparisons without promoting synthetic or partial evidence', () => {
  const request = exampleVolumeRequest('reference-comparison')
  const report = processStockpile(request)
  expect(report.comparison.status).toBe('synthetic-comparison')
  expect(report.comparison.signedDifferenceM3).toBeCloseTo(0, 10)
  expect(report.comparison.combinedDeclaredBoundM3).toBeCloseTo(2.65, 10)
  expect(report.comparison.withinCombinedDeclaredBound).toBe(true)
  request.reference!.aboveBaseM3 = 18
  expect(processStockpile(request).comparison.signedDifferenceM3).toBeCloseTo(-2, 10)
  expect(processStockpile(request).comparison.relativeSignedDifference).toBeCloseTo(-1 / 9, 10)
  request.reference!.aboveBaseM3 = 0
  expect(processStockpile(request).comparison.relativeSignedDifference).toBeNull()
  request.reference!.independence = 'not-independent'
  expect(processStockpile(request).comparison.status).toBe('not-independent')
  if (request.surface.geometry.kind !== 'tin') throw new Error('Fixture requires TIN')
  request.surface.geometry.triangles.pop()
  const partial = processStockpile(request)
  expect(partial.comparison.status).toBe('unavailable')
  expect(partial.comparison.signedDifferenceM3).toBeNull()
  expect(partial.comparison.withinCombinedDeclaredBound).toBeNull()
})

test('rejects self-reference, invalid calendar dates and contradictory evidence before comparison', () => {
  const sameSource = exampleVolumeRequest('reference-comparison')
  sameSource.reference!.sourceSha256 = sameSource.surface.metadata.provenance.sourceSha256
  expect(() => processStockpile(sameSource)).toThrow(/independent/)
  const sameId = exampleVolumeRequest('reference-comparison')
  sameId.reference!.id = sameId.surface.metadata.id
  expect(() => processStockpile(sameId)).toThrow(/independent/)
  const invalidDate = exampleVolumeRequest('reference-comparison')
  invalidDate.reference!.surveyedAt = '2026-02-31T00:00:00Z'
  expect(() => processStockpile(invalidDate)).toThrow(/date/)
  const fakePhysical = exampleVolumeRequest('reference-comparison')
  fakePhysical.reference!.evidence = 'operator-declared-survey'
  expect(() => processStockpile(fakePhysical)).toThrow(/synthetic/)
})

test('rejects multi-valued, degenerate, overlapping, duplicate and disconnected-height TIN topology', () => {
  const meshes = [
    { vertices: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], triangles: [[0, 1, 2]] },
    { vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 1], [2, 0, 1], [0, 2, 1]], triangles: [[0, 1, 2], [3, 4, 5]] },
    { vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0]], triangles: [[0, 1, 2], [2, 1, 0]] },
    { vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0], [1, 0, 0], [3, 0, 0], [1, 2, 0]], triangles: [[0, 1, 2], [3, 4, 5]] },
    { vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0], [1, 0, 1], [2, -1, 1], [0, -1, 1]], triangles: [[0, 1, 2], [3, 4, 5]] },
    { vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, -2, 0], [2, 2, 0]], triangles: [[0, 1, 2], [0, 1, 3], [0, 1, 4]] },
  ]
  for (const mesh of meshes) {
    const request = exampleVolumeRequest()
    request.surface.geometry = { kind: 'tin', vertices: mesh.vertices as [number, number, number][], triangles: mesh.triangles as [number, number, number][] }
    expect(() => processStockpile(request)).toThrow(/TIN/)
  }
  const validJunction = exampleVolumeRequest()
  validJunction.surface.geometry = { kind: 'tin', vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0], [1, 0, 0], [2, -1, 0], [0, -1, 0]], triangles: [[0, 1, 2], [3, 4, 5]] }
  validJunction.boundary.outer = [[0, -1], [2, -1], [2, 2], [0, 2]]
  expect(processStockpile(validJunction).coveredAreaM2).toBeCloseTo(3, 10)
})

test('rejects invalid boundary topology, unsupported coordinate semantics and uncertainty contradictions', () => {
  const variants = [
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.boundary.outer = [[0, 0], [4, 4], [0, 4], [4, 0]] },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.boundary.outer = [[0, 0], [4, 0], [2, 0], [4, 4], [0, 4]] },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.boundary.holes = [[[0, 0], [1, 0], [1, 1]]] },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.boundary.holes = [[[1, 1], [3, 1], [3, 3], [1, 3]], [[1.5, 1.5], [2, 1.5], [2, 2]]] },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.boundary.holes = [[[1, 1], [3, 1], [3, 3], [1, 3]], [[2, 2], [3.5, 2], [3.5, 3.5], [2, 3.5]]] },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.boundary.holes = [[[5, 5], [6, 5], [6, 6]]] },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.reference.horizontalCrs = { kind: 'wgs84-utm', id: 'EPSG:4326', definition: 'Degrees', coordinateEpoch: null } },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.reference.horizontalCrs.id = 'EPSG:32661' },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.reference.horizontalUnit = 'degree' as 'metre' },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.reference.elevationPositive = 'down' as 'up' },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.provenance.georeferencing.verticalBoundM = -.1 },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.provenance.georeferencing.reportId = null },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.provenance.timeCalibration = { status: 'unknown', reportId: 'invented' } },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.surface.metadata.provenance.acquisition = { status: 'external', sourceId: 'claimed-measurement' } },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.base.kind = 'surface' as 'plane' },
    (r: ReturnType<typeof exampleVolumeRequest>) => { r.base.anchorM[2] = Infinity },
  ]
  for (const mutate of variants) { const request = exampleVolumeRequest(); mutate(request); expect(() => processStockpile(request)).toThrow() }
})

test('requires identical comparison frames/domains and accepts equivalent ring winding and starting point', () => {
  const request = exampleVolumeRequest('reference-comparison')
  request.reference!.boundary.outer = [[4, 4], [4, 0], [0, 0], [0, 4]]
  expect(processStockpile(request).comparison.status).toBe('synthetic-comparison')
  const variants = [
    (r: typeof request) => { r.reference!.reference.verticalDatum.id = 'different-datum' },
    (r: typeof request) => { r.reference!.reference.horizontalCrs.coordinateEpoch = '2025.0' },
    (r: typeof request) => { r.reference!.boundary.outer[0]![0] = 3 },
    (r: typeof request) => { r.reference!.base.anchorM[2] = 1 },
    (r: typeof request) => { r.reference!.base.gradientEast = .1 },
  ]
  for (const mutate of variants) { const r = exampleVolumeRequest('reference-comparison'); mutate(r); expect(() => processStockpile(r)).toThrow(/comparison/)}
})

test('binds analytic fixture source identity to exact numeric geometry and independent formula bytes', () => {
  for (const scenario of ['pyramid', 'cut-fill', 'coverage-gap', 'tilted-base', 'unknown-uncertainty', 'reference-comparison'] as const) {
    const request = exampleVolumeRequest(scenario)
    expect(request.surface.metadata.provenance.sourceSha256).toBe(new Bun.CryptoHasher('sha256').update(JSON.stringify(request.surface.geometry)).digest('hex'))
    if (request.reference) expect(request.reference.sourceSha256).toBe(new Bun.CryptoHasher('sha256').update(request.reference.method).digest('hex'))
  }
})

test('bounds primitive counts and candidate work, and rejects absent domain or all-nodata surfaces', () => {
  const oversized = exampleVolumeRequest()
  oversized.surface.geometry = { kind: 'tin', vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: Array.from({ length: 16385 }, () => [0, 1, 2]) }
  expect(() => processStockpile(oversized)).toThrow(/triangles/)
  const crowded = exampleVolumeRequest()
  const vertices: [number, number, number][] = [], triangles: [number, number, number][] = []
  // Triangles have identical X ranges but disjoint Y domains. The sweep must bound even bbox rejection work.
  for (let i = 0; i < 1100; i++) { const first = vertices.length; vertices.push([0, 3 * i, 0], [1, 3 * i, 0], [0, 3 * i + 1, 0]); triangles.push([first, first + 1, first + 2]) }
  crowded.surface.geometry = { kind: 'tin', vertices, triangles }
  expect(() => processStockpile(crowded)).toThrow(/candidate-pair budget/)
  const missing = exampleVolumeRequest()
  missing.surface.geometry = { kind: 'cell-grid', width: 1, height: 1, westM: 0, southM: 0, cellSizeM: 1, rows: [[null]], rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' }
  expect(() => processStockpile(missing)).toThrow(/no valid/)
  missing.surface.geometry.rows = [[1]]
  missing.boundary.outer = [[10, 10], [11, 10], [11, 11], [10, 11]]
  expect(() => processStockpile(missing)).toThrow(/no positive-area coverage/)
})

test('handles zero height, collinear AOI vertices, zero lines on edges and cut/fill sign reversal', () => {
  const request = exampleVolumeRequest()
  request.surface.geometry = { kind: 'tin', vertices: [[0, 0, 0], [2, 0, 0], [0, 2, 0]], triangles: [[0, 1, 2]] }
  request.boundary.outer = [[0, 0], [1, 0], [2, 0], [0, 2]]
  const zero = processStockpile(request)
  expect(zero.coveredAreaM2).toBeCloseTo(2, 10)
  expect(zero.aboveBaseM3).toBe(0)
  expect(zero.belowBaseM3).toBe(0)
  expect(zero.fullBoundarySignedM3).toBe(0)
  request.surface.geometry.vertices[1]![2] = 2
  expect(processStockpile(request).aboveBaseM3).toBeCloseTo(4 / 3, 10)
  request.surface.geometry.vertices[1]![2] = -2
  expect(processStockpile(request).aboveBaseM3).toBe(0)
  expect(processStockpile(request).belowBaseM3).toBeCloseTo(4 / 3, 10)
  expect(processStockpile(request).signedTopMinusBaseM3).toBeCloseTo(-4 / 3, 10)
})
