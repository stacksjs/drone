import { expect, test } from 'bun:test'
import { exampleAgricultureConfig } from '../../resources/functions/drone/agriculture/fixtures'
import { createAgriculturePlan } from '../../resources/functions/drone/agriculture/planner'

test('agriculture planning retains the owned survey, raw band calibration and explicit parcel geometry', () => {
  const config = exampleAgricultureConfig()
  const plan = createAgriculturePlan(config)
  expect(plan.survey.areaM2).toBeCloseTo(2.56, 10)
  expect(plan.config.parcels).toHaveLength(2)
  expect(plan.config.radiometry.bands.map(band => band.name)).toEqual(['red', 'nir'])
  expect(plan.survey.config.calibration.evidence).toBe('synthetic')
  config.parcels[0]!.boundsM[0] = -8
  expect(plan.config.parcels[0]!.boundsM[0]).toBe(-0.8)
})

test('overlapping parcel interiors, oversized grids and unknown calibration/config fields fail before execution', () => {
  const overlap = exampleAgricultureConfig()
  overlap.parcels[1]!.boundsM = [-.5, -.5, .5, .5]
  expect(() => createAgriculturePlan(overlap)).toThrow('parcel')
  expect(() => createAgriculturePlan({ ...exampleAgricultureConfig(), gridResolutionM: .001 })).toThrow('grid')
  expect(() => createAgriculturePlan({ ...exampleAgricultureConfig(), physicalFlightEnabled: true })).toThrow('fields')
  const wrong = exampleAgricultureConfig()
  wrong.radiometry.bands[1].name = 'red'
  expect(() => createAgriculturePlan(wrong)).toThrow()
  const getter = Object.defineProperty(exampleAgricultureConfig(), 'id', { get() { throw new Error('PRIVATE_CONFIG_VALUE') } })
  expect(() => createAgriculturePlan(getter)).toThrow('accessor')
})
