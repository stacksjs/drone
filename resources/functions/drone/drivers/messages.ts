import type { AutopilotDriverId } from './profiles'
import { driverProfiles } from './profiles'
import type { MavlinkFrame } from '../mavlink'
export interface DriverCapabilities {
  driver: AutopilotDriverId
  bits: bigint
  uid: bigint
  flightSoftwareVersion: number
  missionInt: boolean
  parameterEncoding: 'bytewise' | 'c-cast'
  encodingEvidence: 'advertised' | 'explicit-driver-profile'
  physicalCommands: false
}
export type ParameterType = 1 | 2 | 3 | 4 | 5 | 6 | 9
export interface DriverParameter { id: string, type: ParameterType, value: number, count: number, index: number }
export interface MissionWaypoint {
  command: 16
  frame: 5 | 6 // GLOBAL_INT (MSL), GLOBAL_RELATIVE_ALT_INT (home-relative)
  latitudeDeg: number
  longitudeDeg: number
  altitudeM: number
  holdSeconds?: number
  acceptanceRadiusM?: number
  passRadiusM?: number
  yawDeg?: number | null
}
export const driverProtocolLimits = Object.freeze({ heartbeatMs: 1500, retryMs: 500, retries: 3, progressMs: 5000, operationMs: 30000, completionMs: 10000, missionItems: 128 })
export const messageView = (f: MavlinkFrame) => new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.byteLength)
export function commandPayload(command: number, params: readonly number[], targetSystem: number, targetComponent: number, confirmation = 0) {
  if (!Number.isInteger(command) || command < 0 || command > 65535 || params.length > 7 || params.some(n => !Number.isFinite(n) || !Number.isFinite(Math.fround(n)))) throw new RangeError('Invalid COMMAND_LONG id or parameters')
  const payload = new Uint8Array(33), v = new DataView(payload.buffer)
  params.forEach((n, i) => v.setFloat32(i * 4, n, true))
  v.setUint16(28, command, true); payload.set([targetSystem, targetComponent, confirmation], 30)
  return payload
}
export function parseCapabilities(frame: MavlinkFrame, driver: AutopilotDriverId): DriverCapabilities {
  const v = messageView(frame), bits = v.getBigUint64(0, true)
  if (!(bits & 8192n)) throw new Error('Peer does not advertise MAVLink 2')
  const bytewise = (bits & 16n) !== 0n, cast = (bits & 131072n) !== 0n
  if (bytewise && cast) throw new Error('Ambiguous parameter encoding capabilities')
  return { driver, bits, uid: v.getBigUint64(8, true), flightSoftwareVersion: v.getUint32(16, true), missionInt: (bits & 4n) !== 0n, parameterEncoding: bytewise ? 'bytewise' : cast ? 'c-cast' : driverProfiles[driver].parameterEncodingFallback, encodingEvidence: bytewise || cast ? 'advertised' : 'explicit-driver-profile', physicalCommands: false }
}
export function parameterId(id: string) {
  if (typeof id !== 'string' || !/^[\x21-\x7E]{1,16}$/.test(id)) throw new RangeError('Parameter ID must be 1..16 printable ASCII characters without spaces')
  const bytes = new Uint8Array(16); bytes.set(new TextEncoder().encode(id)); return bytes
}
const ranges: Record<number, [number, number]> = { 1: [0, 255], 2: [-128, 127], 3: [0, 65535], 4: [-32768, 32767], 5: [0, 4294967295], 6: [-2147483648, 2147483647] }
export function parameterBytes(value: number, type: ParameterType, encoding: DriverCapabilities['parameterEncoding']) {
  if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || (type !== 9 && (!ranges[type] || !Number.isInteger(value) || value < ranges[type]![0] || value > ranges[type]![1]))) throw new RangeError('Unsupported parameter type or out-of-range value')
  const bytes = new Uint8Array(4), v = new DataView(bytes.buffer)
  if (type === 9 || encoding === 'c-cast') {
    if (type !== 9 && Math.fround(value) !== value) throw new RangeError('Integer loses precision under C-cast parameter encoding')
    v.setFloat32(0, value, true)
  }
  else if (type === 1) v.setUint8(0, value)
  else if (type === 2) v.setInt8(0, value)
  else if (type === 3) v.setUint16(0, value, true)
  else if (type === 4) v.setInt16(0, value, true)
  else if (type === 5) v.setUint32(0, value, true)
  else v.setInt32(0, value, true)
  return bytes
}
export function parameterResponseId(frame: MavlinkFrame) {
  const rawId = frame.payload.subarray(8, 24), end = rawId.indexOf(0), id = new TextDecoder().decode(rawId.subarray(0, end < 0 ? 16 : end))
  parameterId(id)
  if (end >= 0 && rawId.subarray(end).some(n => n !== 0)) throw new Error('Malformed parameter ID padding')
  return id
}
export function parseParameter(frame: MavlinkFrame, encoding: DriverCapabilities['parameterEncoding']): DriverParameter {
  const id = parameterResponseId(frame), v = messageView(frame)
  const type = v.getUint8(24) as ParameterType
  let value: number
  if (type === 9 || encoding === 'c-cast') value = v.getFloat32(0, true)
  else if (type === 1) value = v.getUint8(0)
  else if (type === 2) value = v.getInt8(0)
  else if (type === 3) value = v.getUint16(0, true)
  else if (type === 4) value = v.getInt16(0, true)
  else if (type === 5) value = v.getUint32(0, true)
  else if (type === 6) value = v.getInt32(0, true)
  else throw new Error('Unsupported parameter type')
  parameterBytes(value, type, encoding)
  const count = v.getUint16(4, true), index = v.getUint16(6, true)
  if (count === 0 || index >= count) throw new Error('Invalid parameter count/index')
  return { id, type, value, count, index }
}
export function readParameterPayload(id: string, system: number, component: number) {
  const bytes = new Uint8Array(20); new DataView(bytes.buffer).setInt16(0, -1, true); bytes.set([system, component], 2); bytes.set(parameterId(id), 4); return bytes
}
export function setParameterPayload(id: string, value: number, type: ParameterType, encoding: DriverCapabilities['parameterEncoding'], system: number, component: number) {
  const bytes = new Uint8Array(23); bytes.set(parameterBytes(value, type, encoding)); bytes.set([system, component], 4); bytes.set(parameterId(id), 6); bytes[22] = type; return bytes
}
export function missionCountPayload(count: number, system: number, component: number) {
  const bytes = new Uint8Array(5); new DataView(bytes.buffer).setUint16(0, count, true); bytes.set([system, component], 2); return bytes
}
export function missionAckPayload(result: number, system: number, component: number) { return new Uint8Array([system, component, result, 0]) }
export function normalizeWaypoint(item: MissionWaypoint): Required<MissionWaypoint> {
  if (!item || item.command !== 16 || ![5, 6].includes(item.frame) || ![item.latitudeDeg, item.longitudeDeg, item.altitudeM].every(Number.isFinite) || Math.abs(item.latitudeDeg) > 90 || Math.abs(item.longitudeDeg) > 180 || Math.abs(item.altitudeM) > 10000) throw new RangeError('Only bounded global NAV_WAYPOINT items are supported')
  const holdSeconds = item.holdSeconds ?? 0, acceptanceRadiusM = item.acceptanceRadiusM ?? 2, passRadiusM = item.passRadiusM ?? 0, yawDeg = item.yawDeg ?? null
  if (![holdSeconds, acceptanceRadiusM, passRadiusM].every(n => Number.isFinite(n) && n >= 0 && n <= 10000) || (yawDeg !== null && (!Number.isFinite(yawDeg) || Math.abs(yawDeg) > 360))) throw new RangeError('Invalid waypoint parameters')
  return { command: 16, frame: item.frame, latitudeDeg: Math.round(item.latitudeDeg * 1e7) / 1e7, longitudeDeg: Math.round(item.longitudeDeg * 1e7) / 1e7, altitudeM: Math.fround(item.altitudeM), holdSeconds: Math.fround(holdSeconds), acceptanceRadiusM: Math.fround(acceptanceRadiusM), passRadiusM: Math.fround(passRadiusM), yawDeg: yawDeg === null ? null : Math.fround(yawDeg) }
}
export function waypointPayload(item: MissionWaypoint, seq: number, system: number, component: number) {
  const p = normalizeWaypoint(item), bytes = new Uint8Array(38), v = new DataView(bytes.buffer)
  ;[p.holdSeconds, p.acceptanceRadiusM, p.passRadiusM, p.yawDeg ?? NaN].forEach((n, i) => v.setFloat32(i * 4, n, true))
  v.setInt32(16, Math.round(p.latitudeDeg * 1e7), true); v.setInt32(20, Math.round(p.longitudeDeg * 1e7), true); v.setFloat32(24, p.altitudeM, true)
  v.setUint16(28, seq, true); v.setUint16(30, 16, true); bytes.set([system, component, p.frame, seq === 0 ? 1 : 0, 1, 0], 32)
  return bytes
}
export function parseWaypoint(frame: MavlinkFrame) {
  const v = messageView(frame)
  if (![0, 1].includes(v.getUint8(35)) || v.getUint8(36) !== 1) throw new Error('Unsupported mission current/autocontinue fields')
  const yaw = v.getFloat32(12, true)
  return normalizeWaypoint({ command: v.getUint16(30, true) as 16, frame: v.getUint8(34) as 5 | 6, holdSeconds: v.getFloat32(0, true), acceptanceRadiusM: v.getFloat32(4, true), passRadiusM: v.getFloat32(8, true), yawDeg: Number.isNaN(yaw) ? null : yaw, latitudeDeg: v.getInt32(16, true) / 1e7, longitudeDeg: v.getInt32(20, true) / 1e7, altitudeM: v.getFloat32(24, true) })
}
