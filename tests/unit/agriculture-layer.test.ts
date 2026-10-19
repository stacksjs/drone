import { expect, test } from 'bun:test'
import { exampleAgricultureConfig } from '../../resources/functions/drone/agriculture/fixtures'
import { processAgriculture } from '../../resources/functions/drone/agriculture/layer'
import { simulateAgriculture } from '../../resources/functions/drone/agriculture/runtime'

// Public layer seam: independently declared field areas and reflectance zones
// detect axis/order, clipping, source sampling and missing-support errors.
// This is cell-centre simulation evidence, not field crop-health validation.
test('maps real retained raw counts at estimated-pose grid centres into independently known red/NIR zones', () => {
  const run = simulateAgriculture(), layer = processAgriculture(run)
  expect(layer.fieldAreaM2).toBeCloseTo(2.56, 9)
  expect(layer.observedAreaM2).toBeGreaterThan(0)
  expect(layer.observedAreaM2).toBeLessThanOrEqual(layer.fieldAreaM2 + 1e-10)
  expect(layer.cells[0]!.positionM[0]).toBeGreaterThan(layer.cells.at(-1)!.positionM[0])
  expect(layer.cells[0]!.positionM[1]).toBeLessThan(layer.cells[1]!.positionM[1])
  const cases = [[-.55, .35, .1, .7, .75], [.55, -.45, .2, .4, 1 / 3], [.55, .55, .25, .15, -.25]]
  for (const [north, east, red, nir, ndvi] of cases) {
    const cell = layer.cells.find(c => Math.abs(c.positionM[0] - north!) < 1e-6 && Math.abs(c.positionM[1] - east!) < 1e-6)!
    expect(cell.reason).toBe('valid')
    expect(cell.redReflectance!).toBeCloseTo(red!, 2)
    expect(cell.nirReflectance!).toBeCloseTo(nir!, 2)
    expect(cell.ndvi!).toBeCloseTo(ndvi!, 2)
    expect(cell.bounds![0]).toBeLessThanOrEqual(cell.ndvi!)
    expect(cell.bounds![1]).toBeGreaterThanOrEqual(cell.ndvi!)
    expect(cell.source!.captureId).toMatch(/^photo-/)
  }
  expect(layer.parcels.reduce((sum, parcel) => sum + parcel.areaM2, 0)).toBeCloseTo(layer.fieldAreaM2, 9)
  expect(layer.parcels.reduce((sum, parcel) => sum + parcel.observedAreaM2, 0)).toBeCloseTo(layer.observedAreaM2, 9)
  expect(layer.physicalAgronomyVerified).toBe(false)
})

test('exactly clips cells and parcel support to an independently worked concave-free triangle with a hole', () => {
  const config = exampleAgricultureConfig()
  config.survey.boundary = [[-.8, -.8], [.8, -.8], [-.8, .8]]
  config.survey.holes = [[[-.4, -.4], [-.2, -.4], [-.2, -.2], [-.4, -.2]]]
  config.gridResolutionM = .6
  const run = simulateAgriculture({ config, seconds: 8 }), layer = processAgriculture(run)
  // Right triangle area1.6*1.6/2=1.28, minus0.2*0.2 hole=.04.
  expect(layer.fieldAreaM2).toBeCloseTo(1.24, 9)
  // N<0 half contains0.96m² triangle support minus the0.04m² hole.
  expect(layer.parcels.find(parcel => parcel.id === 'south-parcel')!.areaM2).toBeCloseTo(.92, 9)
  expect(layer.parcels.find(parcel => parcel.id === 'north-parcel')!.areaM2).toBeCloseTo(.32, 9)
  expect(layer.grid.rows).toBe(3)
  expect(layer.grid.columns).toBe(3)
  expect(layer.cells).toHaveLength(9)
  expect(layer.cells.some(cell => cell.areaM2 === 0)).toBe(true)
  expect(layer.observedAreaM2).toBe(0)
  expect(layer.meanNdvi).toBeNull()
  expect(layer.parcels.every(parcel => Math.abs(parcel.missingAreaM2 - parcel.areaM2) < 1e-10 && parcel.meanNdvi === null)).toBe(true)
})

test('keeps a masked nearest-source pixel missing without interpolating another overlapping observation', () => {
  const run = simulateAgriculture(), initial = processAgriculture(run)
  const chosen = initial.cells.find(cell => cell.reason === 'valid' && cell.positionM[0] < -.3)!
  const frame = run.captures.find(capture => capture.captureId === chosen.source!.captureId)!
  const [x, y] = chosen.source!.pixel
  frame.image.bands[0].counts[y * frame.image.width + x] = 65535
  const processed = processAgriculture(run), masked = processed.cells.find(cell => cell.id === chosen.id)!
  expect(masked.reason).toBe('masked')
  expect(masked.source).toEqual(chosen.source)
  expect(masked.ndvi).toBeNull()
  expect(masked.bounds).toBeNull()
  expect(processed.observedAreaM2).toBeLessThan(initial.observedAreaM2)
})
