import { expect, test } from 'bun:test'
import { exampleVisionCalibration, exampleVisionValidation } from '../../resources/functions/drone/vision/fixtures'
import { parseVisionProfile } from '../../resources/functions/drone/vision/profile'

test('vision profile imports reject unknown versions, malformed JSON and oversized UTF-8 without reflecting private input', () => {
  const profile = { version: 1, calibration: exampleVisionCalibration(), heldOut: exampleVisionValidation() }
  expect(parseVisionProfile(JSON.stringify(profile)).report.physicalCalibrationVerified).toBe(false)
  expect(() => parseVisionProfile(JSON.stringify({ ...profile, version: 2 }))).toThrow(/version 1/)
  expect(() => parseVisionProfile(JSON.stringify({ ...profile, approved: true }))).toThrow(/version 1/)
  expect(() => parseVisionProfile('{"private-location":')).toThrow('Malformed vision profile JSON')
  expect(() => parseVisionProfile('"' + '界'.repeat(90000) + '"')).toThrow(/256 KiB/)
  profile.calibration.intrinsics.fx = 0
  expect(() => parseVisionProfile(JSON.stringify(profile))).toThrow()
})
