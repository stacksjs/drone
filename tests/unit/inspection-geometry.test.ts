import { expect, test } from 'bun:test'
import { exampleInspectionConfig } from '../../resources/functions/drone/inspection/fixtures'
import { createInspectionPlan } from '../../resources/functions/drone/inspection/planner'
import { inspectionAssetPoint, projectInspectionPixel } from '../../resources/functions/drone/inspection/geometry'
import { renderInspectionImage, renderInspectionRange, inspectCaptureQuality } from '../../resources/functions/drone/inspection/camera'

test('bridge route uses east/up asset axes and certifies every transit segment', () => {
  const plan = createInspectionPlan(exampleInspectionConfig())
  expect(inspectionAssetPoint(plan.config.asset, .5, .2)).toEqual([3, .5, -2])
  expect(plan.stations.map(s => s.vehiclePositionM)).toEqual([[1, -.5, -1.8], [1, 0, -1.8], [1, .5, -1.8]])
  expect(plan.mission.tasks.map(t => t.id)).toEqual(['takeoff', 'station-left', 'capture-left', 'station-center', 'capture-center', 'station-right', 'capture-right', 'return', 'land'])
  expect(plan.minimumPlannedSeparationM).toBeCloseTo(2, 10)
  const hit = projectInspectionPixel(plan, { positionM: [1, 0, -1.8], quaternionWxyz: [1, 0, 0, 0] }, [48, 36])!
  expect(hit.pointM).toEqual([3, 0, -1.8])
  expect(hit.distanceM).toBeCloseTo(1.96, 10)
  expect(hit.incidenceRad).toBe(0)
})

test('ray raster resolves independently located surface marks and synthetic temperature values', () => {
  const plan = createInspectionPlan(exampleInspectionConfig())
  const body = { positionM: [1, 0, -1.8], quaternionWxyz: [1, 0, 0, 0] } as Parameters<typeof renderInspectionImage>[1]
  const image = renderInspectionImage(plan, body)
  expect([image.width, image.height, image.rgba.length, image.thermalCentiKelvin.length]).toEqual([96, 72, 27648, 6912])
  // Pinhole center samples are offset by half a pixel, still inside the central mark.
  expect(image.thermalCentiKelvin[36 * 96 + 48]).toBe(29315)
  expect(image.rgba.slice((36 * 96 + 48) * 4, (36 * 96 + 48) * 4 + 4)).toEqual(new Uint8Array([38, 49, 61, 255]))
  expect(image.thermalCentiKelvin[0]).toBe(0)
  // Independent ray to hot mark U=.4,V=.2: x=60.2449,y=29.8776.
  expect(image.thermalCentiKelvin[30 * 96 + 60]).toBe(31315)
  const shifted = renderInspectionImage(plan, body, [2.8, 0, -1.8])
  expect(shifted.thermalCentiKelvin).not.toEqual(image.thermalCentiKelvin)
  const range = renderInspectionRange(plan, body, 500, 2)
  for (const [i, expected] of [[2, -.8, .6], [2, .8, .6], [2, -.8, -.6]].entries()) for (let axis = 0; axis < 3; axis++) expect(range.pointsBodyM[i]![axis]).toBeCloseTo(expected[axis]!, 10)
})
