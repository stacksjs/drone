import { describe, expect, test } from 'bun:test'
import { createSurveyPlan } from '../../resources/functions/drone/mapping/planner'
import { exampleSurveyConfig } from '../../resources/functions/drone/mapping/fixtures'
import { projectSurveyFootprint, intersectSurveyRay } from '../../resources/functions/drone/mapping/geometry'
import { nedToGeodetic, geodeticToNed } from '../../resources/functions/drone/estimation/frames'
import { createCalibratedCamera } from '../../resources/functions/drone/camera/calibrated'

describe('survey geometry public functions', () => {
  test('plans clipped imaging lanes and calibrated terrain footprints with explicit collection assumptions', () => {
    const config = exampleSurveyConfig(), plan = createSurveyPlan(config)
    expect(plan.areaM2).toBeCloseTo(2.56, 10)
    expect(plan.lanes.length).toBeGreaterThan(1)
    expect(plan.lanes.length).toBeLessThanOrEqual(8)
    expect(plan.gsdM).toBeLessThan(config.maxGsdM)
    expect(plan.requiredWh).toBeLessThan(config.power.availableWh * .75)
    for (const lane of plan.lanes) {
      expect(Math.abs(lane.fromM[0])).toBeCloseTo(.8, 8)
      expect(lane.fromM[2]).toBe(-1.5)
      expect(lane.lengthM).toBeCloseTo(1.6, 8)
    }
    const footprint = projectSurveyFootprint(plan, [0, 0, -1.5], [1, 0, 0, 0])
    expect(footprint).toHaveLength(4)
    expect(Math.min(...footprint.map(p => p[0]))).toBeLessThan(-.8)
    expect(Math.max(...footprint.map(p => p[1]))).toBeGreaterThan(1)
    const camera = createCalibratedCamera(config.calibration, config.heldOut)
    expect(camera.bodyPoint([48, 36], 1)).toEqual([0, 0, 1.04])
    expect(camera.projectBodyPoint([0, 0, 1.04])).toEqual([48, 36])
    expect(intersectSurveyRay(config, [0, 0, -1.46], [0, 0, 1])).toEqual([0, 0, 0])
  })
})

// Function seam catches topology, calibration and numerical frame errors; it cannot establish physical survey accuracy.
test('clips concave boundaries and imaging holes, crosshatches and follows the declared terrain plane', () => {
  const c = exampleSurveyConfig()
  c.boundary = [[-2, -2], [2, -2], [2, 0], [0, 0], [0, 2], [-2, 2]]
  c.holes = [[[-1.8, -1.8], [-1.2, -1.8], [-1.2, -1.2], [-1.8, -1.2]]]
  c.terrain.gradient = [.06, -.08]
  c.crosshatch = true
  c.power.availableWh = 100
  const plan = createSurveyPlan(c)
  expect(plan.areaM2).toBeCloseTo(11.64, 8)
  expect(new Set(plan.lanes.map(lane => lane.headingDeg))).toEqual(new Set([0, 90]))
  for (const lane of plan.lanes) {
    for (let step = 1; step < 20; step++) {
      const n = lane.fromM[0] + (lane.toM[0] - lane.fromM[0]) * step / 20
      const e = lane.fromM[1] + (lane.toM[1] - lane.fromM[1]) * step / 20
      expect(n <= 0 || e <= 0).toBe(true)
      expect(n > -1.8 && n < -1.2 && e > -1.8 && e < -1.2).toBe(false)
    }
    expect(lane.fromM[2]).toBeCloseTo(.06 * lane.fromM[0] - .08 * lane.fromM[1] - 1.5, 10)
  }
  const flat = createSurveyPlan(exampleSurveyConfig())
  expect(plan.gsdM).toBeGreaterThan(flat.gsdM)
  expect(plan.footprintM.along).toBeLessThan(flat.footprintM.along)
})

test('rejects ambiguous topology, unsupported geometry, optimistic GSD, trigger capacity and endurance', () => {
  const variants = [
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.boundary = [[0, 0], [1, 1], [0, 1], [1, 0]] },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.holes = [[[0, 0], [1, 0], [1, 1]]] },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.holes = [[[-.4, -.4], [.4, -.4], [.4, .4], [-.4, .4]], [[-.2, -.2], [.2, -.2], [.2, .2], [-.2, .2]]] },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.terrain.gradient = [.1, .1] },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.maxGsdM = .01 },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.minTriggerIntervalMs = 1000 },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.power.availableWh = .1 },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.altitudeAglM = 6 },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.boundary = [[-500, -500], [500, -500], [500, 500], [-500, 500]] },
    (c: ReturnType<typeof exampleSurveyConfig>) => { c.calibration.extrinsics.quaternionWxyz = [1, 0, 0, 0] },
  ]
  for (const mutate of variants) { const c = exampleSurveyConfig(); mutate(c); expect(() => createSurveyPlan(c)).toThrow() }
})

test('projects independently worked lever, tilt, Brown optics and rejects horizon or unqualified depth', () => {
  const c = exampleSurveyConfig()
  c.terrain.gradient = [.1, 0]
  // D=.1N, origin[0,0,-1], ray[1,0,1]: depth=1/.9.
  expect(intersectSurveyRay(c, [0, 0, -1], [1, 0, 1])[0]).toBeCloseTo(1 / .9, 12)
  expect(intersectSurveyRay(c, [0, 0, -1], [1, 0, 1])[2]).toBeCloseTo(1 / 9, 12)
  expect(() => intersectSurveyRay(c, [0, 0, -1], [1, 0, 0])).toThrow(/horizon/)
  expect(() => intersectSurveyRay(c, [0, 0, -10], [0, 0, 1])).toThrow(/depth/)
  const camera = createCalibratedCamera(c.calibration, c.heldOut)
  const point = camera.bodyPoint([23.76, 17.82], .5)
  expect(point[0]).toBeCloseTo(-.15, 9); expect(point[1]).toBeCloseTo(.2, 9); expect(point[2]).toBeCloseTo(.54, 9)
  const pixel = camera.projectBodyPoint([-.15, .2, .54])!
  expect(pixel[0]).toBeCloseTo(23.76, 9); expect(pixel[1]).toBeCloseTo(17.82, 9)
  const detached = camera.calibration; detached.output.width = 200
  expect(camera.calibration.output.width).toBe(96)
  expect(camera.projectBodyPoint([0, 0, -.1])).toBeNull()
})

test('inverts WGS84 fixed NED exactly through ECEF at equator, poles and the dateline', () => {
  const origin = { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 0 }
  expect(nedToGeodetic([0, 0, -100], origin)).toEqual({ latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 })
  const east = nedToGeodetic([0, 1000, 0], origin)
  expect(east.latitudeDeg).toBe(0)
  expect(east.longitudeDeg).toBeCloseTo(.008983152767588, 12)
  expect(east.ellipsoidHeightM).toBeCloseTo(.0783927962184, 7)
  for (const base of [{ latitudeDeg: 89.9, longitudeDeg: 179.999, ellipsoidHeightM: 120 }, { latitudeDeg: -70, longitudeDeg: -179.999, ellipsoidHeightM: -20 }, { latitudeDeg: 90, longitudeDeg: 42, ellipsoidHeightM: 500 }]) {
    for (const local of [[0, 0, 0], [1000, 500, -10], [-10000, -7000, 100]] as [number, number, number][]) {
      const point = nedToGeodetic(local, base), roundtrip = geodeticToNed(point, base)
      for (let i = 0; i < 3; i++) expect(roundtrip[i]).toBeCloseTo(local[i]!, 6)
    }
  }
  expect(() => nedToGeodetic([Infinity, 0, 0], origin)).toThrow()
})
