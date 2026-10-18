import type { SurfaceMetadata, VolumeRequest } from './types'
export const volumeScenarios = ['pyramid', 'cut-fill', 'coverage-gap', 'tilted-base', 'unknown-uncertainty', 'reference-comparison'] as const
export type VolumeScenario = typeof volumeScenarios[number]
export function exampleVolumeRequest(scenario: VolumeScenario = 'pyramid'): VolumeRequest {
  if (!volumeScenarios.includes(scenario)) throw new Error('Unknown volume scenario')
  const metadata: SurfaceMetadata = {
    version: 1, id: 'analytic-pyramid',
    reference: { horizontalCrs: { kind: 'engineering', id: 'LOCAL:analytic-stockpile', definition: 'Analytic east/north metre fixture, origin at southwest base corner', coordinateEpoch: null }, axes: 'EAST_NORTH', horizontalUnit: 'metre', verticalDatum: { kind: 'engineering', id: 'analytic-zero', definition: 'Elevation zero is the specified analytic ground plane' }, verticalUnit: 'metre', elevationPositive: 'up' },
    provenance: { evidence: 'synthetic', sourceKind: 'analytic', sourceSha256: '0'.repeat(64), acquisition: { status: 'synthetic', sourceId: 'analytic-formula-side4-height3' }, reconstructionOrMeshing: { status: 'synthetic', sourceId: 'four-explicit-pyramid-faces' }, boresightCalibration: { status: 'not-applicable', reportId: null }, timeCalibration: { status: 'not-applicable', reportId: null }, groundClassification: { status: 'declared', description: 'Specified analytic material surface, no vegetation or equipment', reportId: 'analytic-construction' }, georeferencing: { verticalBoundM: .1, horizontalBoundM: null, reportId: 'conditional-synthetic-error-example' } },
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
  if (scenario === 'tilted-base' && request.surface.geometry.kind === 'tin') {
    request.base.gradientEast = .2; request.base.gradientNorth = -.1
    request.base.anchorM[2] = 10
    for (const p of request.surface.geometry.vertices) p[2] += 10 + .2 * p[0] - .1 * p[1]
  }
  if (scenario === 'unknown-uncertainty') request.base.verticalBoundM = null
  if (scenario === 'reference-comparison') request.reference = {
    id: 'independent-analytic-volume', evidence: 'synthetic', sourceSha256: '1'.repeat(64), surveyedAt: '2026-10-18T00:00:00Z', method: 'Independent closed-form square pyramid area times height divided by three', independence: 'declared-independent', reference: structuredClone(metadata.reference), boundary: structuredClone(request.boundary), base: structuredClone(request.base), aboveBaseM3: 16, belowBaseM3: 0, volumeBoundM3: .25,
  }
  return request
}
