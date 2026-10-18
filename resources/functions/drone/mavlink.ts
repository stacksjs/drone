import type { Vector3 } from './types'

/** Deliberately small common.xml subset. Unknown dialects are skipped, never trusted. */
const definitions: Record<number, { crc: number, length: number }> = {
  0: { crc: 50, length: 9 },
  1: { crc: 124, length: 31 },
  32: { crc: 185, length: 28 },
  84: { crc: 143, length: 53 },
}

export interface MavlinkFrame { id: number, systemId: number, componentId: number, payload: Uint8Array }

function checksum(bytes: Uint8Array, extra: number): number {
  let crc = 0xFFFF
  for (const byte of [...bytes, extra]) {
    let temporary = byte ^ (crc & 0xFF)
    temporary ^= (temporary << 4) & 0xFF
    crc = ((crc >> 8) ^ (temporary << 8) ^ (temporary << 3) ^ (temporary >> 4)) & 0xFFFF
  }
  return crc
}

export function encodeFrame(id: number, payload: Uint8Array, sequence = 0, systemId = 245, componentId = 191): Uint8Array {
  const definition = definitions[id]
  if (!definition || payload.length !== definition.length) throw new RangeError('Unsupported MAVLink payload')
  for (const value of [sequence, systemId, componentId]) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('Invalid MAVLink identity')
  }
  const frame = new Uint8Array(payload.length + 8)
  frame.set([0xFE, payload.length, sequence, systemId, componentId, id])
  frame.set(payload, 6)
  new DataView(frame.buffer).setUint16(frame.length - 2, checksum(frame.subarray(1, frame.length - 2), definition.crc), true)
  return frame
}

/** Handles multiple v1/v2 frames in one datagram. Signed v2 is refused without a verifier. */
export function decodeDatagram(bytes: Uint8Array): MavlinkFrame[] {
  const result: MavlinkFrame[] = []
  for (let offset = 0; offset < bytes.length;) {
    const magic = bytes[offset]
    if (magic !== 0xFE && magic !== 0xFD) { offset++; continue }
    const v2 = magic === 0xFD
    const header = v2 ? 10 : 6
    if (offset + header > bytes.length) break
    const length = bytes[offset + 1]!
    const incompatibilityFlags = v2 ? bytes[offset + 2]! : 0
    const signed = (incompatibilityFlags & 1) !== 0
    const total = header + length + 2 + (signed ? 13 : 0)
    if (offset + total > bytes.length) break
    const id = v2 ? bytes[offset + 7]! | (bytes[offset + 8]! << 8) | (bytes[offset + 9]! << 16) : bytes[offset + 5]!
    const definition = definitions[id]
    if (definition && incompatibilityFlags === 0 && (v2 ? length <= definition.length : length === definition.length)) {
      const expected = bytes[offset + header + length]! | (bytes[offset + header + length + 1]! << 8)
      const actual = checksum(bytes.subarray(offset + 1, offset + header + length), definition.crc)
      if (expected === actual) {
        const payload = new Uint8Array(definition.length)
        payload.set(bytes.subarray(offset + header, offset + header + length))
        result.push({ id, payload, systemId: bytes[offset + (v2 ? 5 : 3)]!, componentId: bytes[offset + (v2 ? 6 : 4)]! })
      }
    }
    offset += total
  }
  return result
}

/** LOCAL_NED velocity-only setpoint. Does not arm, take off, land or change modes. */
export function encodeVelocity(velocity: Vector3, options: { sequence?: number, targetSystem?: number, targetComponent?: number, bootMs?: number } = {}): Uint8Array {
  if (![velocity.north, velocity.east, velocity.down].every(v => Number.isFinite(v) && Math.abs(v) <= 20))
    throw new RangeError('Invalid velocity setpoint')
  if (![options.targetSystem ?? 1, options.targetComponent ?? 1].every(id => Number.isInteger(id) && id >= 1 && id <= 255)
    || !Number.isFinite(options.bootMs ?? 0) || (options.bootMs ?? 0) < 0)
    throw new RangeError('Invalid setpoint destination or clock')
  const payload = new Uint8Array(53)
  const view = new DataView(payload.buffer)
  view.setUint32(0, (options.bootMs ?? 0) >>> 0, true)
  view.setFloat32(16, velocity.north, true)
  view.setFloat32(20, velocity.east, true)
  view.setFloat32(24, velocity.down, true)
  view.setUint16(48, 0x0DC7, true) // ignore position, acceleration, yaw and yaw rate
  payload[50] = options.targetSystem ?? 1
  payload[51] = options.targetComponent ?? 1
  payload[52] = 1 // MAV_FRAME_LOCAL_NED
  return encodeFrame(84, payload, options.sequence)
}
