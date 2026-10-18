import { expect, test } from 'bun:test'
import { exampleVolumeRequest } from '../../resources/functions/drone/volumes/fixtures'
import { processStockpile } from '../../resources/functions/drone/volumes/engine'

test('the numeric grid workspace example retains the unknown cell and enough pieces to inspect pagination', () => {
  const report = processStockpile(exampleVolumeRequest('grid-nodata'))
  // Independently summed rows: 15 + 16 + 25 + 30 cubic metres, with one missing square metre.
  expect(report.aboveBaseM3).toBeCloseTo(86, 12)
  expect(report.boundaryAreaM2).toBe(20)
  expect(report.coveredAreaM2).toBeCloseTo(19, 12)
  expect(report.excludedGridCells).toEqual([{ row: 1, column: 2 }])
  expect(report.fullBoundarySignedM3).toBeNull()
  expect(report.integrationPieces.length).toBeGreaterThan(12)
})
