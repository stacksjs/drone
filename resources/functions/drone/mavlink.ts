import type { MavlinkSigning } from './drivers/signing'
import type { Vector3 } from './types'

/** Deliberately small common.xml subset. Unknown dialects are skipped, never trusted. */
const definitions: Record<number, { crc: number, length: number, maxLength?: number }> = {
  0: { crc: 50, length: 9 },
  1: { crc: 124, length: 31, maxLength: 43 },
  20: { crc: 214, length: 20 },
  22: { crc: 220, length: 25 },
  23: { crc: 168, length: 23 },
  32: { crc: 185, length: 28 },
  40: { crc: 230, length: 4, maxLength: 5 },
  42: { crc: 28, length: 2, maxLength: 18 },
  43: { crc: 132, length: 2, maxLength: 3 },
  44: { crc: 221, length: 4, maxLength: 9 },
  47: { crc: 153, length: 3, maxLength: 8 },
  51: { crc: 196, length: 4, maxLength: 5 },
  73: { crc: 38, length: 37, maxLength: 38 },
  76: { crc: 152, length: 33 },
  77: { crc: 143, length: 3, maxLength: 10 },
  148: { crc: 178, length: 60, maxLength: 78 },
  84: { crc: 143, length: 53 },
}

export interface MavlinkFrame { version: 1 | 2, sequence: number, signed: boolean, id: number, systemId: number, componentId: number, payload: Uint8Array }

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

/** MAVLink 2 with common.xml zero-tail truncation and optional authenticated signing. */
export function encodeFrameV2(id: number, payload: Uint8Array, sequence = 0, systemId = 245, componentId = 191, signing?: MavlinkSigning): Uint8Array {
  const definition = definitions[id]
  if (!definition || payload.length < definition.length || payload.length > (definition.maxLength ?? definition.length)) throw new RangeError('Unsupported MAVLink 2 payload')
  if (![sequence, systemId, componentId].every(v => Number.isInteger(v) && v >= 0 && v <= 255)) throw new RangeError('Invalid MAVLink identity')
  let length = payload.length
  while (length > 1 && payload[length - 1] === 0) length--
  const frame = new Uint8Array(length + 12)
  frame.set([0xFD, length, signing ? 1 : 0, 0, sequence, systemId, componentId, id & 255, (id >>> 8) & 255, (id >>> 16) & 255])
  frame.set(payload.subarray(0, length), 10)
  new DataView(frame.buffer).setUint16(frame.length - 2, checksum(frame.subarray(1, frame.length - 2), definition.crc), true)
  return signing ? signing.sign(frame) : frame
}

/** Handles multiple v1/v2 frames in one datagram. Signed v2 is refused without a verifier. */
export function decodeDatagram(bytes: Uint8Array, signing?: MavlinkSigning): MavlinkFrame[] {
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
    if (definition && (incompatibilityFlags === 0 || (incompatibilityFlags === 1 && signing !== undefined)) && (!signing || signed) && (v2 ? length >= 1 && length <= (definition.maxLength ?? definition.length) : length === definition.length)) {
      const expected = bytes[offset + header + length]! | (bytes[offset + header + length + 1]! << 8)
      const actual = checksum(bytes.subarray(offset + 1, offset + header + length), definition.crc)
      if (expected === actual && (!signed || signing!.verify(bytes.subarray(offset, offset + total)))) {
        const payload = new Uint8Array(Math.max(definition.length, length))
        payload.set(bytes.subarray(offset + header, offset + header + length))
        result.push({ version: v2 ? 2 : 1, sequence: bytes[offset + (v2 ? 4 : 2)]!, signed, id, payload, systemId: bytes[offset + (v2 ? 5 : 3)]!, componentId: bytes[offset + (v2 ? 6 : 4)]! })
      }
    }
    offset += total
  }
  return result
}

/** Bounded byte-stream framing. Partial frames belong to exactly one connection. */
export function createMavlinkStreamDecoder(signing?: MavlinkSigning) {
  // MAVLink 2: 10-byte header, 255-byte payload, CRC and 13-byte signature.
  const pending = new Uint8Array(280)
  let used = 0
  function discard(count: number) { pending.copyWithin(0, count, used); used -= count }
  return {
    get retainedBytes() { return used },
    reset() { used = 0 },
    push(bytes: Uint8Array): MavlinkFrame[] {
      if (!(bytes instanceof Uint8Array) || bytes.length > 65_536) throw new RangeError('MAVLink stream chunk exceeds 65536 bytes')
      const frames: MavlinkFrame[] = []
      for (const byte of bytes) {
        pending[used++] = byte
        while (used > 0) {
          const v2 = pending[0] === 0xFD
          if (!v2 && pending[0] !== 0xFE) { discard(1); continue }
          if (used < (v2 ? 3 : 2)) break
          const length = pending[1]! + (v2 ? 12 + ((pending[2]! & 1) ? 13 : 0) : 8)
          if (used < length) break
          const decoded = decodeDatagram(pending.subarray(0, length), signing)
          if (decoded.length === 1) { frames.push(decoded[0]!); discard(length) }
          else discard(1) // Resynchronize after corrupt length/CRC, retaining any following frame.
        }
      }
      return frames
    },
  }
}

/** LOCAL_NED velocity-only setpoint. Does not arm, take off, land or change modes. */
export function encodeVelocity(velocity: Vector3, options: { sequence?: number, targetSystem?: number, targetComponent?: number, bootMs?: number, signing?: MavlinkSigning } = {}): Uint8Array {
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
  return options.signing ? encodeFrameV2(84, payload, options.sequence, 245, 191, options.signing) : encodeFrame(84, payload, options.sequence)
}
