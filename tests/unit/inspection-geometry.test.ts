import { expect, test } from 'bun:test'
import { exampleInspectionConfig } from '../../resources/functions/drone/inspection/fixtures'
import { createInspectionPlan } from '../../resources/functions/drone/inspection/planner'
import { inspectionAssetPoint, inspectionSegmentSeparation, projectInspectionPixel } from '../../resources/functions/drone/inspection/geometry'
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

test('analytic finite-face distances include segment interiors, corners and ground transits', () => {
  const a = exampleInspectionConfig().asset
  expect(inspectionSegmentSeparation(a, [2, -2, -1.8], [2, 2, -1.8])).toBeCloseTo(1, 10)
  expect(inspectionSegmentSeparation(a, [3, -2, -1.8], [3, 2, -1.8])).toBe(0)
  expect(inspectionSegmentSeparation(a, [2, 1.8, -3.4], [2, 1.8, -3.4])).toBeCloseTo(Math.sqrt(3), 10)
  expect(projectInspectionPixel(createInspectionPlan(exampleInspectionConfig()), { positionM: [4, 0, -1.8], quaternionWxyz: [0, 0, 0, 1] }, [48, 36])).toBeNull()
})

test('route validation rejects unsafe home approaches, unqualified optics and resource overflow', () => {
  const mutations: ((c: ReturnType<typeof exampleInspectionConfig>) => void)[] = [
    c => { c.asset.centerM[0] = .7 },
    c => { c.standOffM = .8 },
    c => { c.clearance.positionBoundM = .01 },
    c => { c.stations.push({ id: 'fourth', uM: 0, vM: 0 }) },
    c => { c.stations[1]!.id = 'left' },
    c => { c.stations[0]!.uM = 2 },
    c => { c.calibration.extrinsics.quaternionWxyz = [1, 0, 0, 0] },
    c => { c.calibration.output.width = 1024 },
    c => { c.power.availableWh = .1 },
    c => { (c as unknown as Record<string, unknown>).plantPosition = [1, 0, 0] },
    c => { c.heldOut[0]!.bodyPointM[0] += 1 },
    c => { c.speedMps = Number.NaN },
  ]
  for (const mutate of mutations) {
    const c = exampleInspectionConfig(); mutate(c)
    expect(() => createInspectionPlan(c)).toThrow()
  }
  const c = exampleInspectionConfig(), p = createInspectionPlan(c)
  c.asset.centerM[0] = 8
  expect(p.config.asset.centerM[0]).toBe(3)
})

function literalCapture(plan: ReturnType<typeof createInspectionPlan>) {
  const body = { positionM: [1, 0, -1.8], quaternionWxyz: [1, 0, 0, 0] } as Parameters<typeof renderInspectionImage>[1]
  return {
    id: 'capture-1', visitId: 'visit-1', stationId: 'center', assetId: plan.config.asset.id, revision: plan.config.asset.revision, sessionId: 'session-1', sequence: 1,
    issuedAtMs: 1000, capturedAtMs: 1000, acknowledgedAtMs: 1020, calibrationId: plan.config.calibration.id, clockUncertaintyMs: 1, exposureTimeUs: 1000,
    pose: { capturedAtMs: 1000, reference: 'test-origin', positionM: body.positionM, quaternionWxyz: body.quaternionWxyz, positionCapturedAtMs: 1000, positionPredictedToMs: 1000, attitudeCapturedAtMs: 1000, attitudePredictedToMs: 1000, gyroCapturedAtMs: 1000, attitudePrediction: 'qualified-gyro-hold' as const },
    cameraPositionM: [1.04, 0, -1.8] as [number, number, number], positionSigmaM: .03, attitudeSigmaRad: .01,
    assetObservation: { sequence: 1, capturedAtMs: 1000, receivedAtMs: 1000, reference: 'test-origin', centerM: [3, 0, -1.8] as [number, number, number], normalNed: [-1, 0, 0] as [number, number, number], uncertaintyM: .04, registrationDisplacementM: 0, cameraSeparationM: 1.96 },
    image: renderInspectionImage(plan, body),
  }
}

test('capture quality derives calibrated GSD and blur and rejects missing, uncertain or moving views', () => {
  const p = createInspectionPlan(exampleInspectionConfig()), capture = literalCapture(p)
  const quality = inspectCaptureQuality(p, capture, { velocityMps: .1, angularRateRadS: .2 })
  expect(quality.qualified).toBe(true)
  expect(quality.gsdM).toBeCloseTo(1.96 / 60, 10)
  expect(quality.blurPx).toBeCloseTo(.001 * (.1 / (1.96 / 60) + .2 * 60), 10)
  expect(quality.assetFraction).toBe(.25)
  expect(inspectCaptureQuality(p, { ...capture, positionSigmaM: .2 }, { velocityMps: 0, angularRateRadS: 0 }).reasons).toContain('position uncertainty exceeded')
  expect(inspectCaptureQuality(p, capture, { velocityMps: 100, angularRateRadS: 0 }).reasons).toContain('motion blur exceeded')
  const blank = { ...capture, image: { ...capture.image, thermalCentiKelvin: new Uint16Array(6912) } }
  expect(inspectCaptureQuality(p, blank, { velocityMps: 0, angularRateRadS: 0 }).qualified).toBe(false)
  expect(() => inspectCaptureQuality(p, { ...capture, image: { ...capture.image, rgba: new Uint8Array(1) } }, { velocityMps: 0, angularRateRadS: 0 })).toThrow()
  expect(() => inspectCaptureQuality(p, capture, { velocityMps: Number.NaN, angularRateRadS: 0 })).toThrow()
})
