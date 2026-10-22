import type { Decision, FlightAdapter, Telemetry } from '../types'
import type { MavlinkFrame } from '../mavlink'
import type { MavlinkSigning } from './signing'
import type { AutopilotDriverId } from './profiles'
import type { AutopilotProtocol } from './protocol'
import { zero, finiteVector } from '../geometry'
import { encodeFrameV2, encodeVelocity } from '../mavlink'
import { decodeAutopilotMode, driverProfiles } from './profiles'
import { createDriverProtocol } from './protocol'

export interface AutopilotSessionOptions {
  driver?: AutopilotDriverId
  kind: 'sitl' | 'telemetry-only'
  systemId?: number
  componentId?: number
  now?: () => number
  /** Strict MAVLink 2 signing. Unsigned input is rejected when configured. Never log the key. */
  signing?: { key: Uint8Array, linkId: number, timestamp: () => bigint }
}
export interface AutopilotAdapter extends FlightAdapter {
  readonly driver: AutopilotDriverId
  readonly localPort: number
  readonly protocol: AutopilotProtocol
  /** One zero setpoint per call. Caller must sustain >= 5Hz during explicit SITL preparation. */
  primeOffboard: () => { ready: boolean, reason: string }
}

/** Shared driver policy. A transport owns bytes, peer pinning, polling and resource cleanup. */
export function createAutopilotSession(options: AutopilotSessionOptions, signing: MavlinkSigning | undefined, transport: { available(): boolean, write(bytes: Uint8Array): void }) {
  const driver = options.driver ?? 'ardupilot', kind = options.kind
  if (driver !== 'ardupilot' && driver !== 'px4') throw new TypeError('Unknown autopilot driver')
  if (kind !== 'sitl' && kind !== 'telemetry-only') throw new TypeError('Unknown adapter mode')
  const profile = driverProfiles[driver], now = options.now ?? (() => performance.now())
  const systemId = options.systemId ?? 1, componentId = options.componentId ?? 1
  if (![systemId, componentId].every(id => Number.isInteger(id) && id >= 1 && id <= 255)) throw new RangeError('Invalid autopilot identity')
  let sequence = 0, closed = false, transportError = false
  let heartbeatAt = -Infinity, positionAt = -Infinity, batteryAt = -Infinity, primeStarted = -Infinity, lastSetpointAt = -Infinity
  let telemetry: Telemetry = { position: zero(), velocity: zero(), batteryPercent: -1, positionHealthy: false, armed: false, mode: 'manual', receivedAtMs: -Infinity }
  const protocol = createDriverProtocol({ driver, kind, systemId, componentId, now, transmit(id, payload) {
    if (closed || transportError || kind !== 'sitl' || !transport.available()) throw new Error('No writable simulator peer')
    transport.write(encodeFrameV2(id, payload, sequence++ % 256, 245, 191, signing))
  } })
  function transportLost(message?: string) { transportError = true; protocol.transportLost(message) }
  function read(): Telemetry | undefined {
    if (closed || transportError) return undefined
    telemetry = { ...telemetry, receivedAtMs: Math.min(heartbeatAt, positionAt, batteryAt), positionHealthy: kind === 'sitl' }
    return structuredClone(telemetry)
  }
  function transmit(velocity: Telemetry['velocity']) {
    const timestamp = now()
    const frame = encodeVelocity(velocity, { sequence: sequence++ % 256, targetSystem: systemId, targetComponent: componentId, bootMs: timestamp, signing })
    try { transport.write(frame); lastSetpointAt = timestamp }
    catch { transportLost() }
  }
  return {
    kind, driver, read, protocol, transportLost,
    receive(frame: MavlinkFrame): boolean {
      if (closed || transportError || frame.systemId !== systemId || frame.componentId !== componentId) return false
      const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength), receivedAt = now()
      if (frame.id === 0) {
        if (view.getUint8(5) !== profile.autopilotId || view.getUint8(4) !== profile.vehicleType) return false
        heartbeatAt = receivedAt
        telemetry.armed = (view.getUint8(6) & 128) !== 0
        telemetry.mode = decodeAutopilotMode(driver, view.getUint32(0, true))
      }
      else if (frame.id === 1) { batteryAt = receivedAt; telemetry.batteryPercent = view.getInt8(30) }
      else if (frame.id === 32) {
        positionAt = receivedAt
        telemetry.position = { north: view.getFloat32(4, true), east: view.getFloat32(8, true), down: view.getFloat32(12, true) }
        telemetry.velocity = { north: view.getFloat32(16, true), east: view.getFloat32(20, true), down: view.getFloat32(24, true) }
      }
      protocol.receive(frame)
      return true
    },
    primeOffboard() {
      if (driver !== 'px4' || kind !== 'sitl') throw new Error('Offboard priming is supported only by the PX4 SITL driver')
      const timestamp = now(), t = read()
      if (!t || protocol.snapshot().fault || !transport.available() || !Number.isFinite(timestamp) || t.receivedAtMs > timestamp
        || timestamp - t.receivedAtMs > 1000 || !finiteVector(t.position) || !finiteVector(t.velocity)
        || t.batteryPercent < 25 || t.batteryPercent > 100 || t.mode === 'rtl' || t.mode === 'land') {
        primeStarted = -Infinity
        return { ready: false, reason: 'Fresh simulator telemetry and battery reserve required' }
      }
      if (timestamp < lastSetpointAt || timestamp - lastSetpointAt > 400 || !Number.isFinite(primeStarted)) primeStarted = timestamp
      transmit(zero())
      return { ready: !transportError && timestamp - primeStarted >= 1500, reason: 'Stream zero-velocity setpoints before selecting PX4 Offboard' }
    },
    send(decision: Decision) {
      if (closed || transportError || protocol.snapshot().fault || kind !== 'sitl' || !transport.available() || decision.kind === 'release') return
      if (driver === 'px4' && (now() - lastSetpointAt > 400 || now() < lastSetpointAt || now() - primeStarted < 1500 || !Number.isFinite(primeStarted) || telemetry.mode !== 'guided')) return
      transmit(decision.kind === 'velocity' ? decision.velocity : zero())
    },
    close() { if (!closed) { closed = true; protocol.close() } },
  }
}
