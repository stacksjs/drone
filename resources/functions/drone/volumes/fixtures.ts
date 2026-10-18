import type { SurfaceMetadata, VolumeRequest } from './types'
export const volumeScenarios = ['pyramid', 'cut-fill', 'coverage-gap', 'grid-nodata', 'tilted-base', 'unknown-uncertainty', 'reference-comparison'] as const
export type VolumeScenario = typeof volumeScenarios[number]
// SHA256 of UTF8 JSON.stringify(surface.geometry), pinned so browser fixtures need no crypto or server dependency.
const geometryDigests: Record<VolumeScenario, string> = {
  'pyramid': '75c0b15d9b67ab0564f5b370511a58ab43226206a230072a58b6e32af5a39d45',
  'cut-fill': '68b097bb17e4ef7bac13388a554bc1d8b9f88cc9422efa7af564297db69e6c80',
  'coverage-gap': 'ed9480b1f19a26eabe18b3e0e9d11b4bc7722bc85eafde7282ecc006ff86f595',
  'grid-nodata': '949065b24321076f81aea72657e0e3fe83fce858c0d2c290f90107ef7d0c49a6',
  'tilted-base': 'be6ce65151c0d5cc979ca6fde826ccba12fb2ed2b7110b1b176354863f491d4b',
  'unknown-uncertainty': '75c0b15d9b67ab0564f5b370511a58ab43226206a230072a58b6e32af5a39d45',
  'reference-comparison': '75c0b15d9b67ab0564f5b370511a58ab43226206a230072a58b6e32af5a39d45',
}
export function exampleVolumeRequest(scenario: VolumeScenario = 'pyramid'): VolumeRequest {
  if (!volumeScenarios.includes(scenario)) throw new Error('Unknown volume scenario')
  const metadata: SurfaceMetadata = {
    version: 1, id: 'analytic-pyramid',
    reference: { horizontalCrs: { kind: 'engineering', id: 'LOCAL:analytic-stockpile', definition: 'Analytic east/north metre fixture, origin at southwest base corner', coordinateEpoch: null }, axes: 'EAST_NORTH', horizontalUnit: 'metre', verticalDatum: { kind: 'engineering', id: 'analytic-zero', definition: 'Elevation zero is the specified analytic ground plane' }, verticalUnit: 'metre', elevationPositive: 'up' },
    provenance: { evidence: 'synthetic', sourceKind: 'analytic', sourceSha256: geometryDigests[scenario], acquisition: { status: 'synthetic', sourceId: 'analytic-formula-side4-height3' }, reconstructionOrMeshing: { status: 'synthetic', sourceId: 'four-explicit-pyramid-faces' }, boresightCalibration: { status: 'not-applicable', reportId: null }, timeCalibration: { status: 'not-applicable', reportId: null }, groundClassification: { status: 'declared', description: 'Specified analytic material surface, no vegetation or equipment', reportId: 'analytic-construction' }, georeferencing: { verticalBoundM: .1, horizontalBoundM: null, reportId: 'conditional-synthetic-error-example' } },
  }
  const request: VolumeRequest = {
    version: 1, id: `stockpile-${scenario}`, surface: { version: 1, metadata, geometry: { kind: 'tin', vertices: [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [2, 2, 3]], triangles: [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]] } },
    boundary: { outer: [[0, 0], [4, 0], [4, 4], [0, 4]], holes: [] },
    base: { kind: 'plane', anchorM: [0, 0, 0], gradientEast: 0, gradientNorth: 0, assumption: 'Known analytic basal plane, not inferred from surface samples', evidence: 'synthetic', verticalBoundM: .05 }, reference: null,
  }
  if (scenario === 'cut-fill') {
    request.surface.geometry = { kind: 'tin', vertices: [[0, 0, -1], [2, 0, 1], [2, 1, 1], [0, 1, -1]], triangles: [[0, 1, 2], [0, 2, 3]] }
    request.boundary.outer = [[0, 0], [2, 0], [2, 1], [0, 1]]
    metadata.id = 'analytic-cut-fill'
  }
  if (scenario === 'coverage-gap' && request.surface.geometry.kind === 'tin') request.surface.geometry.triangles.pop()
  if (scenario === 'grid-nodata') {
    request.surface.geometry = { kind: 'cell-grid', width: 5, height: 4, westM: 0, southM: 0, cellSizeM: 1, rows: [[1, 2, 3, 4, 5], [2, 3, null, 5, 6], [3, 4, 5, 6, 7], [4, 5, 6, 7, 8]], rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' }
    request.boundary.outer = [[0, 0], [5, 0], [5, 4], [0, 4]]
    metadata.id = 'analytic-grid-nodata'
    metadata.provenance.acquisition.sourceId = 'analytic-cell-elevations-with-one-unknown-cell'
    metadata.provenance.reconstructionOrMeshing.sourceId = 'explicit-north-first-cell-area-product'
  }
  if (scenario === 'tilted-base' && request.surface.geometry.kind === 'tin') {
    request.base.gradientEast = .2; request.base.gradientNorth = -.1
    request.base.anchorM[2] = 10
    for (const p of request.surface.geometry.vertices) p[2] += 10 + .2 * p[0] - .1 * p[1]
  }
  if (scenario === 'unknown-uncertainty') request.base.verticalBoundM = null
  // Reference digest identifies the exact UTF8 method/formula string below, independently of the mesh representation.
  if (scenario === 'reference-comparison') request.reference = {
    id: 'independent-analytic-volume', evidence: 'synthetic', sourceSha256: 'fcfc826a164353f7183b7744a255ac0336242473890c641f3c4e55013b06089e', surveyedAt: '2026-10-18T00:00:00Z', method: 'Independent closed-form square pyramid area times height divided by three', independence: 'declared-independent', reference: structuredClone(metadata.reference), boundary: structuredClone(request.boundary), base: structuredClone(request.base), aboveBaseM3: 16, belowBaseM3: 0, volumeBoundM3: .25,
  }
  return request
}
