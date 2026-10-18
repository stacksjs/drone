import type { VisionCalibration, VisionValidationSample } from './types'
import { createVisionLocalizer } from './geometry'

/** Import a bounded calibration and its held-out correspondences. This verifies consistency, not provenance. */
export function parseVisionProfile(text: string) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 262144) throw new RangeError('Vision profile exceeds 256 KiB')
  let profile: { version: number, calibration: VisionCalibration, heldOut: VisionValidationSample[] }
  try { profile = JSON.parse(text) }
  catch { throw new TypeError('Malformed vision profile JSON') }
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).length !== 3
    || !Object.keys(profile).every(key => ['version', 'calibration', 'heldOut'].includes(key)) || profile.version !== 1)
    throw new TypeError('Expected a version 1 vision calibration and heldOut correspondences')
  return createVisionLocalizer(profile.calibration, profile.heldOut)
}
