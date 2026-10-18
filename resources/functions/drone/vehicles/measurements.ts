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
