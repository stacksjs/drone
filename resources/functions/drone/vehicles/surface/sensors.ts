import type { VehicleMeasurement, VehiclePlantState } from '../types'
import type { SurfacePing } from './survey'
const q = (n: number, step = 0.001) => Math.round(n / step) * step
export const harbourObstacle = { northM: 2, eastM: 5, radiusM: 0.7 } as const
/** Only truth bridge. These are modeled encoder/DVL, range, contact and single-beam packets. */
export function renderSurfaceMeasurement(state: VehiclePlantState, atMs: number, reference: string, sequence: number, collision = false): VehicleMeasurement {
  const centerN = collision ? 2 : harbourObstacle.northM, centerE = collision ? 0 : harbourObstacle.eastM
  const dn = centerN - state.positionM[0], de = centerE - state.positionM[1]
  // Scene obstruction distance is measured by an idealized complete 360 degree range sensor.
  const clearance = Math.max(0, Math.hypot(dn, de) - harbourObstacle.radiusM)
  const depth = 5 + 0.02 * state.positionM[0] + 0.01 * state.positionM[1]
  const waterLevel = 0.4, draft = 0.3, soundSpeed = 1480
  return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'surface', sequence, reference, capturedAtMs: atMs, receivedAtMs: atMs + 60, values: { clockSigmaMs: 1, onSurface: state.onSurface, stopped: Math.hypot(...state.velocityMps) < 0.25, speedMps: q(Math.hypot(...state.velocityMps)), closestRangeM: q(clearance), rangeCoverage: 'complete-360-model', rangeSigmaM: 0.02, yawRateRadS: q(state.angularRateRadS[2], 0.0001), travelTimeS: q((depth + waterLevel - draft) * 2 / soundSpeed, 0.000001), soundSpeedMps: soundSpeed, draftM: draft, waterLevelAboveDatumM: waterLevel, datum: 'LOCAL_HARBOUR_MODEL_DATUM' } }
}
export function qualifySurfaceMeasurement(m: VehicleMeasurement | null, nowMs: number, reference?: string): VehicleMeasurement {
  if (!m || m.version !== 1 || m.evidence !== 'modeled-vehicle-sensors' || m.vehicle !== 'surface' || !Number.isInteger(m.sequence) || m.sequence <= 0 || !m.reference || reference !== undefined && m.reference !== reference || ![nowMs, m.capturedAtMs, m.receivedAtMs].every(Number.isFinite) || m.capturedAtMs < 0 || m.receivedAtMs < m.capturedAtMs || m.receivedAtMs > nowMs || nowMs - m.capturedAtMs > 120 || m.receivedAtMs - m.capturedAtMs !== 60 || typeof m.values.onSurface !== 'boolean' || typeof m.values.stopped !== 'boolean' || m.values.rangeCoverage !== 'complete-360-model') throw new RangeError('Unqualified surface measurement')
  for (const key of ['clockSigmaMs', 'speedMps', 'closestRangeM', 'rangeSigmaM', 'yawRateRadS', 'travelTimeS', 'soundSpeedMps', 'draftM', 'waterLevelAboveDatumM']) if (typeof m.values[key] !== 'number' || !Number.isFinite(m.values[key])) throw new RangeError('Malformed surface sensor value')
  if (Number(m.values.clockSigmaMs) < 1 || Number(m.values.clockSigmaMs) > 5 || Number(m.values.speedMps) < 0 || Number(m.values.speedMps) > 4 || Number(m.values.closestRangeM) < 0 || Number(m.values.rangeSigmaM) <= 0 || Number(m.values.rangeSigmaM) > 0.1 || Number(m.values.travelTimeS) <= 0 || Number(m.values.travelTimeS) > 0.2 || typeof m.values.datum !== 'string' || !m.values.datum) throw new RangeError('Out of bounds surface sensor value')
  return structuredClone(m)
}
export function surfacePingFromMeasurement(m: VehicleMeasurement, nowMs: number): SurfacePing {
  const checked = qualifySurfaceMeasurement(m, nowMs), v = checked.values
  return { id: `ping-${checked.sequence}`, reference: checked.reference, capturedAtMs: checked.capturedAtMs, receivedAtMs: checked.receivedAtMs, clockSigmaMs: Number(v.clockSigmaMs), twoWayTravelS: Number(v.travelTimeS), soundSpeedMps: Number(v.soundSpeedMps), draftM: Number(v.draftM), waterLevelAboveDatumM: Number(v.waterLevelAboveDatumM), datum: String(v.datum), timeSigmaS: 0.000001, soundSpeedSigmaMps: 1, draftSigmaM: 0.01, waterLevelSigmaM: 0.02, motionSigmaM: 0.01 }
}
