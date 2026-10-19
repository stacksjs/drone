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

test('calibration rejects zero catches, wrong units, impossible weights and unbounded quantities', () => {
  for (const value of [
    { pulses: 0, litres: 2, durationMs: 120000 },
    { pulses: 4000.5, litres: 2, durationMs: 120000 },
    { pulses: 4000, litres: 0, durationMs: 120000 },
    { pulses: 4000, litres: 2, durationMs: 0 },
    { pulses: 4000, litres: 2, durationMs: Number.NaN },
    { pulses: 4000, litres: 2, durationMs: 120000, gallons: 2 },
  ]) expect(() => applicationPulseFactor(value)).toThrow()
  for (const value of [
    { tareRaw: 2000, loadedRaw: 2000, knownMassKg: 5 },
    { tareRaw: 2000, loadedRaw: 1000, knownMassKg: 5 },
    { tareRaw: 2000, loadedRaw: 52000, knownMassKg: 0 },
    { tareRaw: 2000, loadedRaw: Infinity, knownMassKg: 5 },
  ]) expect(() => applicationScaleFactor(value)).toThrow()
  const scale = { tareRaw: 2000, loadedRaw: 52000, knownMassKg: 5 }
  expect(() => applicationScaleMass(scale, 1999)).toThrow()
  expect(() => applicationScaleMass(scale, 2000.5)).toThrow()
  expect(() => applicationRatePerSecond(-200, .5, .8)).toThrow()
  expect(() => applicationRatePerSecond(200, .5, 0)).toThrow()
  // This helper consumes speed magnitude; direction/turn authority is owned by
  // the implement controller and never inferred from this dimensional scalar.
  expect(applicationRatePerSecond(200, -.5, .8)).toBe(.008)
})

test('calibration accessors are rejected without reading private user data', () => {
  const value = { get pulses() { throw new Error('PRIVATE_CALIBRATION_ACCESSOR_INVOKED') }, litres: 2, durationMs: 120000 }
  expect(() => applicationPulseFactor(value)).toThrow('fields or accessor')
})
