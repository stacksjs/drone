import { createHash } from 'node:crypto'
import type { MissionPlan } from '../missions/plan'
import { validateMission } from '../missions/plan'

export const environmentProfiles = Object.freeze(['nominal', 'sensor-loss', 'site-closure'] as const)
export type EnvironmentProfile = typeof environmentProfiles[number]
export type V3 = [number, number, number]
export const environmentLimits = Object.freeze({ renders: 5001, captures: 1001, traceRows: 6001, diagnosticRow: 512, packetRow: 512, observationRow: 2048, diagnosticsBytes: 3 * 1024 * 1024, packetsBytes: 512 * 1024, observationsBytes: 2 * 1024 * 1024, traceBytes: 8 * 1024 * 1024, metadataBytes: 16384, totalBytes: 16 * 1024 * 1024 })
export function unavailable(): never { throw new RangeError('environment-unavailable') }
/** Inspect own data before reading values. Arbitrary Proxy termination is not promised. */
export function dataRecord(value: unknown, fields: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return unavailable()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !fields.includes(key) || !descriptors[key]!.enumerable || !('value' in descriptors[key]!)) || fields.some(key => !optional.includes(key) && !Object.hasOwn(descriptors, key))) return unavailable()
  return Object.fromEntries(Object.keys(descriptors).map(key => [key, descriptors[key]!.value]))
}
export function denseArray(value: unknown, max: number, exact?: number): unknown[] {
  if (!Array.isArray(value) || value.length > max || exact !== undefined && value.length !== exact || Object.getPrototypeOf(value) !== Array.prototype) return unavailable()
  const d = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>
  if (Reflect.ownKeys(d).length !== value.length + 1 || !d.length || !('value' in d.length)) return unavailable()
  for (let i = 0; i < value.length; i++) if (!d[i]?.enumerable || !('value' in d[i]!)) return unavailable()
  return value
}
export function finite(value: unknown, min = -1e6, max = 1e6): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || JSON.stringify(value).length > 32) return unavailable()
  return value
}
export function integer(value: unknown, min = 0, max = 100000): number {
  const n = finite(value, min, max)
  if (!Number.isSafeInteger(n)) return unavailable()
  return n
}
export function vector(value: unknown, min = -1e6, max = 1e6): V3 {
  return denseArray(value, 3, 3).map(n => finite(n, min, max)) as V3
}
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
export function compact(value: unknown): string { return JSON.stringify(value) }
export function normalizeEnvironmentInput(input: unknown = {}): { profile: EnvironmentProfile } {
  try {
    const data = dataRecord(input, ['profile'], ['profile'])
    const profile = Object.hasOwn(data, 'profile') ? data.profile : 'nominal'
    if (typeof profile !== 'string' || !environmentProfiles.includes(profile as EnvironmentProfile)) return unavailable()
    return { profile: profile as EnvironmentProfile }
  }
  catch { return unavailable() }
}
export function environmentModel() {
  return {
    id: 'synthetic-cell-tracer-v1', quantity: 'synthetic-cell-tracer-index', unit: 'U',
    localFrame: 'LOCAL_NED', altitudeDatum: 'WGS84_ELLIPSOID',
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 },
    headingAlignment: 'initial-simulation-north', bodyDatum: 'structural-body-origin',
    leverArmBodyM: [0, 0, 0], groundContactDownM: -0.1, terrain: 'FLAT_ORIGIN_PLANE',
    missionId: 'environment-two-height-v1', missionHorizonMs: 100000, missionWorstCaseMs: 92000,
    bodyStepMs: 4, instrumentMs: 20, instrumentStartMs: 600, supportWarmupMs: 600,
    capturePeriodMs: 100, transportDelayMs: 60, cellTauS: 0.4, cellInitialState: 'field-at-first-render',
    field: { baseU: 40, gradientUPerM: [2, 1, -3], amplitudeU: 4, periodMs: 10000 },
    envelope: { northAbsM: 12, eastAbsM: 12, minDownM: -5, maxDownM: 0, maxSpeedMps: 3, cellRangeU: [0, 100] },
    adc: { bits: 16, offsetCounts: 911, gainCountsPerU: 103, quantizer: 'nearest-Math.round' },
    clock: { domain: 'fixture-monotonic-ms', uncertaintyMs: 1, utcAvailable: false },
    uncertainty: { referenceAbsBoundU: 0.01, quantizationAbsBoundU: 0.5 / 103, cellSlewBoundUPerS: 250, cellTimingAbsBoundU: 0.25, valueAbsBoundU: 0.01 + 0.5 / 103 + 0.25, positionTimingTravelBoundM: 0.003, positionEvidence: 'native-modeled-covariance', physicalAccuracyVerified: false },
    payloadEffects: { massModeled: false, powerModeled: false, dragModeled: false, rotorWashModeled: false },
    cellStateIsInstantaneousAmbient: false, physicalCalibrationVerified: false,
  }
}
export interface Zone { revision: 1 | 2, effectiveAtMs: 600 | 8000, centerM: [number, number], radiusM: 1 | 12 }
export function environmentPolicy(profile: EnvironmentProfile) {
  const declaredRevisions: Zone[] = [{ revision: 1, effectiveAtMs: 600, centerM: [6, 6], radiusM: 1 }]
  if (profile === 'site-closure') declaredRevisions.push({ revision: 2, effectiveAtMs: 8000, centerM: [0, 0], radiusM: 12 })
  return { version: 1, kind: 'declared-synthetic-site-policy', declaredRevisions, appliedRevisions: [] as Zone[], guard: { fixedMarginM: 0.2, sigmaMultiplier: 3, speedBoundMps: 3, clockUncertaintyMs: 1, varianceKind: 'native-position-diagonal', physicalDisturbanceDistanceQualified: false }, nativeFenceChanged: false, declaredWildlifeDetected: false, antiPoachingAuthorityEstablished: false }
}
export function environmentMission(): MissionPlan {
  return validateMission({
    version: 1, id: 'environment-two-height-v1', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE',
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.3,
    tasks: [
      { id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1], timeoutMs: 12000, next: 'low-point' },
      { id: 'low-point', kind: 'waypoint', positionM: [1.2, 0, -1], timeoutMs: 12000, next: 'low-dwell' },
      { id: 'low-dwell', kind: 'loiter', positionM: [1.2, 0, -1], durationMs: 2000, timeoutMs: 12000, next: 'high-point' },
      { id: 'high-point', kind: 'waypoint', positionM: [1.2, 0, -2], timeoutMs: 12000, next: 'high-dwell' },
      { id: 'high-dwell', kind: 'loiter', positionM: [1.2, 0, -2], durationMs: 2000, timeoutMs: 12000, next: 'return' },
      { id: 'return', kind: 'return', timeoutMs: 16000, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 16000 },
    ],
  }).plan
}
