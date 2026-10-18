import type { Quaternion } from '../../estimation/frames'
import type { SensorVector } from '../../sensors/types'
import type { VehicleMeasurement, VehiclePlantState } from '../types'

export const subseaCalibration = 'subsea-dvl-pressure-v1'
const gravity = 9.80665
function quantize(n: number, resolution = 0.0001) {
  const rounded = Math.round(n / resolution) * resolution
  return Object.is(rounded, -0) ? 0 : rounded
}
const vector = (value: unknown, max: number): value is SensorVector => Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= max)
function bodyVelocity(v: SensorVector, q: Quaternion): SensorVector {
  const [w, x, y, z] = q
  return [(1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y + w * z) * v[1] + 2 * (x * z - w * y) * v[2], 2 * (x * y - w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z + w * x) * v[2], 2 * (x * z + w * y) * v[0] + 2 * (y * z - w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2]].map(n => quantize(n)) as SensorVector
}
/** Synthetic pressure, seabed-referenced DVL, gyro, range and 4x4 luma fixture. No hardware data. */
export function renderSubseaMeasurement(state: VehiclePlantState, atMs: number, reference: string, sequence: number, scenario = 'nominal'): VehicleMeasurement {
  if (!state || !vector(state.positionM, 10000) || !vector(state.velocityMps, 100) || !vector(state.accelerationMps2, 1000) || !vector(state.angularRateRadS, 35) || !Array.isArray(state.quaternionWxyz) || state.quaternionWxyz.length !== 4 || state.quaternionWxyz.some(n => !Number.isFinite(n)) || Math.abs(Math.hypot(...state.quaternionWxyz) - 1) > 1e-6 || typeof state.onSurface !== 'boolean' || !state.details || Object.values(state.details).some(v => !(typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)))) throw new TypeError('Invalid subsea model sensor state')
  const fault = atMs >= 5000 ? scenario : 'nominal'
  const depth = fault === 'depth-limit' ? 9 : state.positionM[2]
  // Vertical NED seabed altitude, not a tilted body beam. The declared flat seabed is down=10m.
  const bottomRangeM = Math.max(0, 10 - state.positionM[2])
  const [w, x, y, z] = state.quaternionWxyz
  const directionNorth = 1 - 2 * (y * y + z * z), directionDown = 2 * (x * z - w * y)
  const rayRangeM = Math.abs(directionNorth) > 1e-8 ? (6 - state.positionM[0]) / directionNorth : Infinity
  const hitDownM = state.positionM[2] + rayRangeM * directionDown
  const structureHit = rayRangeM > 0 && rayRangeM <= 50 && hitDownM >= 0 && hitDownM <= 10
  const structureRangeM = structureHit ? rayRangeM : 50
  // A deterministic beam-facing hull texture. Brightness depends on idealized range and viewing direction.
  const facing = Math.max(0, 1 - 2 * (state.quaternionWxyz[2] ** 2 + state.quaternionWxyz[3] ** 2))
  const light = structureHit ? Math.max(0, 180 * facing / (1 + structureRangeM * 0.1)) : 0
  const cameraLuma = Array.from({ length: 16 }, (_, i) => Math.round(Math.max(0, Math.min(255, light + ((i + Math.floor(state.positionM[1] * 4)) % 4) * 10 - Math.floor(i / 4) * 6))))
  return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'subsea', sequence, reference, capturedAtMs: atMs, receivedAtMs: atMs + 60, values: {
    onSurface: state.onSurface, stopped: Math.hypot(...state.velocityMps) <= 0.12 && Math.hypot(...state.angularRateRadS) <= 0.1,
    calibration: subseaCalibration, clockSigmaMs: 1, pressurePa: fault === 'pressure-loss' ? 0 : quantize(101325 + 1025 * gravity * depth), surfacePressurePa: 101325, waterDensityKgM3: 1025,
    dvlVelocityBodyMps: bodyVelocity(state.velocityMps, state.quaternionWxyz), dvlLocked: fault !== 'dvl-loss' && state.details.dvlLocked !== false,
    angularRateBodyRadS: state.angularRateRadS.map(n => quantize(n, 0.00001)), leak: fault === 'leak' || state.details.leak === true,
    tetherLengthM: quantize(Number(state.details.tetherLengthM ?? Math.hypot(...state.positionM))), tetherTensionN: fault === 'tether-overload' ? 60 : quantize(Number(state.details.tetherTensionN ?? 0)), linkConnected: fault !== 'tether-loss' && state.details.linkConnected !== false, emergency: fault === 'emergency',
    bottomRangeM: quantize(bottomRangeM), structureHit, structureRangeM: quantize(structureRangeM), cameraLuma, cameraFrameId: `subsea-model-${sequence}-${atMs}`,
  } }
}
/** Stateless quantity qualification. Navigation adds replay and latched session-loss handling. */
export function qualifySubseaMeasurement(m: VehicleMeasurement | null, nowMs: number, reference?: string): VehicleMeasurement | null {
  if (!m || m.version !== 1 || m.evidence !== 'modeled-vehicle-sensors' || m.vehicle !== 'subsea' || !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || typeof m.reference !== 'string' || m.reference.length > 120 || !/^[1-9][0-9]{0,19}:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(m.reference) || reference !== undefined && m.reference !== reference || !Number.isSafeInteger(m.capturedAtMs) || m.capturedAtMs < 0 || !Number.isSafeInteger(m.receivedAtMs) || m.receivedAtMs - m.capturedAtMs !== 60 || m.receivedAtMs > nowMs || nowMs - m.capturedAtMs + 1 > 120 || !m.values || typeof m.values !== 'object' || Array.isArray(m.values) || Object.keys(m.values).length > 32) return null
  const v = m.values
  for (const [key, value] of Object.entries(v)) if (key.length > 80 || !(typeof value === 'boolean' || typeof value === 'string' && value.length <= 160 || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e8 || Array.isArray(value) && value.length <= 32 && value.every(n => Number.isFinite(n) && typeof n === 'number' && Math.abs(n) <= 1e8))) return null
  for (const key of ['onSurface', 'stopped', 'dvlLocked', 'leak', 'linkConnected', 'emergency', 'structureHit']) if (typeof v[key] !== 'boolean') return null
  if (v.calibration !== subseaCalibration || v.clockSigmaMs !== 1 || v.surfacePressurePa !== 101325 || v.waterDensityKgM3 !== 1025 || typeof v.pressurePa !== 'number' || v.pressurePa < 100319.818375 || v.pressurePa > 201843.1625 || !vector(v.dvlVelocityBodyMps, 5) || !vector(v.angularRateBodyRadS, 35) || Math.hypot(...v.angularRateBodyRadS) > 35) return null
  for (const [key, max] of [['tetherLengthM', 100], ['tetherTensionN', 200], ['bottomRangeM', 50], ['structureRangeM', 50]] as const) if (typeof v[key] !== 'number' || Number(v[key]) < 0 || Number(v[key]) > max) return null
  if (v.structureHit === false && v.structureRangeM !== 50 || v.structureHit === true && Number(v.structureRangeM) <= 0) return null
  if (!Array.isArray(v.cameraLuma) || v.cameraLuma.length !== 16 || v.cameraLuma.some(n => !Number.isInteger(n) || n < 0 || n > 255) || typeof v.cameraFrameId !== 'string' || v.cameraFrameId !== `subsea-model-${m.sequence}-${m.capturedAtMs}`) return null
  return structuredClone(m)
}
