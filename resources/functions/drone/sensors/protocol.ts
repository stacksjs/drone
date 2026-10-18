import type { SensorKind, SensorPacket } from './types'
import { runtimeCrc32 } from '../runtime/protocol'
export const sensorFrameBytes = 128
export const sensorKinds = ['imu', 'barometer', 'gnss'] as const
const lengths = { imu: 16, barometer: 30, gnss: 80 } as const
/** DS v1 is a receive-only telemetry stream, separate from DR v1 diagnostic authority. */
export function decodeSensorFrame(bytes: Uint8Array): SensorPacket {
  if (bytes.length !== sensorFrameBytes) throw new RangeError('Sensor frame must be 128 bytes')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = sensorKinds[bytes[3]! - 1] as SensorKind | undefined
  if (bytes[0] !== 68 || bytes[1] !== 83 || bytes[2] !== 1 || !kind || view.getUint32(124, true) !== runtimeCrc32(bytes.subarray(0, 124))) throw new RangeError('Incompatible or corrupt sensor frame')
  const length = view.getUint16(38, true)
  const flags = view.getUint32(32, true)
  const sequence = view.getUint32(4, true), bootId = view.getBigUint64(8, true)
  const capturedUs = view.getBigUint64(16, true), completedUs = view.getBigUint64(24, true)
  if (length !== lengths[kind] || view.getUint16(36, true) !== bytes[3] || sequence === 0 || bootId === 0n
    || capturedUs > completedUs || completedUs - capturedUs > 50000n || (flags & ~63) !== 0 || !((flags & 1) !== 0 || (flags & 2) !== 0)
    || ((flags & 3) === 3) || bytes.subarray(44 + length, 124).some(value => value !== 0)) throw new RangeError('Invalid sensor identity, timestamps or fields')
  return { kind, sequence, bootId, capturedUs, completedUs, flags, deviceId: bytes[3]!, uncertaintyUs: view.getUint32(40, true), payload: bytes.slice(44, 44 + length) }
}
