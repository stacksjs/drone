import type { EstimatorSnapshot } from '../estimation/estimator'
import type { VehicleKind, VehicleMeasurement } from './types'
export function vehicleReference(estimate: EstimatorSnapshot) { return `${estimate.bootId}:${Object.values(estimate.resets).join(',')}` }
/** Shared envelope qualification. Domain adapters still validate physical quantities and units. */
export function createVehicleMeasurementQualifier(vehicle: VehicleKind) {
  let reference: string | null = null, sequence = 0, captured = -Infinity, signature = '', now = -Infinity
  return {
    qualify(input: VehicleMeasurement | null, atMs: number, expectedReference: string): VehicleMeasurement | null {
      if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs < now) throw new RangeError('Vehicle measurement clock must be monotonic')
      now = atMs
      if (input === null) return null
      const m = structuredClone(input)
      if (m.version !== 1 || m.evidence !== 'modeled-vehicle-sensors' || m.vehicle !== vehicle || !Number.isSafeInteger(m.sequence) || m.sequence <= 0 || m.reference !== expectedReference || !/^[1-9][0-9]{0,19}:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(m.reference) || !Number.isSafeInteger(m.capturedAtMs) || m.capturedAtMs < 0 || !Number.isSafeInteger(m.receivedAtMs) || m.receivedAtMs < m.capturedAtMs || m.receivedAtMs > atMs || atMs - m.capturedAtMs > 120 || m.receivedAtMs - m.capturedAtMs < 20 || m.receivedAtMs - m.capturedAtMs > 100 || !m.values || typeof m.values !== 'object' || Array.isArray(m.values) || Object.keys(m.values).length > 32 || typeof m.values.onSurface !== 'boolean' || typeof m.values.stopped !== 'boolean') throw new TypeError('Unqualified modeled vehicle measurement')
      for (const [key, value] of Object.entries(m.values)) if (key.length > 80 || !(typeof value === 'boolean' || typeof value === 'string' && value.length <= 160 || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e8 || Array.isArray(value) && value.length <= 32 && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e8))) throw new TypeError('Invalid vehicle measurement values')
      const encoded = JSON.stringify(m)
      if (reference !== null && (reference !== m.reference || m.sequence < sequence || m.sequence === sequence && encoded !== signature || m.sequence > sequence && m.capturedAtMs <= captured)) throw new TypeError('Replayed vehicle measurement or changed reference')
      reference = m.reference; sequence = m.sequence; captured = m.capturedAtMs; signature = encoded
      return m
    },
  }
}

import type { SensorObservation, ImuMeasurement } from '../sensors/types'
import type { VehicleMeasurementPose } from './types'
import { multiplyQuaternion, normalizeQuaternion } from '../estimation/frames'
/** Capture-time extrapolation uses only the qualified raw gyro, never plant orientation. */
export function predictVehicleMeasurementPose(estimate: EstimatorSnapshot, imu: SensorObservation | null | undefined, atMs: number): VehicleMeasurementPose | null {
  const p = estimate.localPosition, a = estimate.attitude
  const value = imu?.value as ImuMeasurement | undefined
  if (estimate.evidence !== 'fixture' || !Number.isSafeInteger(atMs) || atMs < 0 || !estimate.health.tilt || !estimate.health.localPosition || !p || !a || estimate.nowMs !== atMs || p.capturedAtMs === null || a.capturedAtMs === null || p.predictedToMs !== atMs || a.capturedAtMs > atMs || atMs - a.capturedAtMs > 60 || !imu?.healthy || imu.kind !== 'imu' || imu.estimatedCaptureMs !== a.capturedAtMs || imu.measurementAgeUpperMs === null || !Number.isFinite(imu.measurementAgeUpperMs) || imu.measurementAgeUpperMs < atMs - imu.estimatedCaptureMs || imu.measurementAgeUpperMs > 80 || !Number.isFinite(imu.receivedAtMs) || imu.receivedAtMs < imu.estimatedCaptureMs || imu.receivedAtMs > atMs || imu.timeUncertaintyUs === null || !Number.isFinite(imu.timeUncertaintyUs) || imu.timeUncertaintyUs < 0 || imu.quality.some(flag => ['stream-overrun', 'timing-unvalidated', 'measurement-epoch-unaligned', 'stuck-suspected'].includes(flag)) || !value || value.frame !== 'BODY_FRD' || value.angularRateRadS.length !== 3 || value.angularRateRadS.some(n => !Number.isFinite(n)) || !value.angularRateVariance || value.angularRateVariance.length !== 3 || value.angularRateVariance.some(n => !Number.isFinite(n) || n <= 0) || Math.hypot(...value.angularRateRadS) > 35) return null
  const dt = (atMs - a.capturedAtMs) / 1000, magnitude = Math.hypot(...value.angularRateRadS), angle = magnitude * dt
  const scale = magnitude < 1e-10 ? dt / 2 : Math.sin(angle / 2) / magnitude
  const rates = value.angularRateRadS
  const q = normalizeQuaternion(multiplyQuaternion(a.quaternionWxyz, [Math.cos(angle / 2), rates[0] * scale, rates[1] * scale, rates[2] * scale]))
  return { reference: vehicleReference(estimate), capturedAtMs: atMs, positionM: [...p.positionM] as [number, number, number], quaternionWxyz: q, positionCapturedAtMs: p.capturedAtMs, positionPredictedToMs: p.predictedToMs, attitudeCapturedAtMs: a.capturedAtMs, attitudePredictedToMs: atMs, gyroCapturedAtMs: imu.estimatedCaptureMs, attitudePrediction: 'qualified-gyro-hold' }
}
