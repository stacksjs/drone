import { expect, test } from 'bun:test'
import { applicationPulseFactor, applicationScaleFactor, applicationScaleMass, applicationRatePerSecond } from '../../resources/functions/drone/application/calibration'

// Public calibration/dimensional seams catch unit mistakes and invalid catches.
// These independent literals do not establish an instrument or physical dose.
test('independent catches and inert weights establish pulse and scale factors', () => {
  expect(applicationPulseFactor({ pulses: 4000, litres: 2, durationMs: 120000 })).toBe(2000)
  const scale = { tareRaw: 2000, loadedRaw: 52000, knownMassKg: 5 }
  expect(applicationScaleFactor(scale)).toBe(10000)
  expect(applicationScaleMass(scale, 32000)).toBe(3)
  expect(applicationScaleMass(scale, 2000)).toBe(0)
  expect(applicationRatePerSecond(200, .5, .8)).toBe(.008)
  expect(applicationRatePerSecond(100, .5, .8)).toBe(.004)
  expect(applicationRatePerSecond(200, 0, .8)).toBe(0)
})
