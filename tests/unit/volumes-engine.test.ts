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
