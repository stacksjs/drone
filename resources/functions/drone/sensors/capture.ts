import { decodeRuntimeFrame } from '../runtime/protocol'
import { decodeSensorFrame, sensorKinds } from './protocol'
import type { SensorKind, SensorPacket } from './types'
export function inspectSensorCapture(bytes: Uint8Array) {
  if (bytes.length > 1048576) throw new RangeError('Sensor capture exceeds 1 MiB')
  const latest: Record<SensorKind, SensorPacket | null> = { imu: null, barometer: null, gnss: null }
  const counts = { imu: 0, barometer: 0, gnss: 0 }
  let offset = 0, discardedBytes = 0, corruptFrames = 0, runtimeFrames = 0
  while (offset < bytes.length) {
    if (bytes[offset] === 68 && bytes[offset + 1] === 82 && offset + 64 <= bytes.length) {
      try { decodeRuntimeFrame(bytes.subarray(offset, offset + 64)); runtimeFrames++; offset += 64; continue }
      catch { corruptFrames++ }
    }
    if (bytes[offset] === 68 && bytes[offset + 1] === 83 && offset + 128 <= bytes.length) {
      try {
        const packet = decodeSensorFrame(bytes.subarray(offset, offset + 128))
        latest[packet.kind] = packet; counts[packet.kind]++; offset += 128; continue
      }
      catch { corruptFrames++ }
    }
    offset++; discardedBytes++
  }
  if (!sensorKinds.some(kind => counts[kind])) throw new RangeError('No compatible sensor frames found')
  return { evidence: 'recorded-unanchored-wire', counts, runtimeFrames, discardedBytes, corruptFrames, latest,
    physicalFlightEnabled: false as const, note: 'Raw board timestamps and receipt timing are not a synchronized measurement clock. Replay requires a qualified clock anchor.' }
}
