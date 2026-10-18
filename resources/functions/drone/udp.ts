import type { Decision, FlightAdapter, Telemetry } from './types'
import { createSocket } from 'node:dgram'
import { decodeDatagram, encodeVelocity } from './mavlink'
import { zero } from './geometry'
import { finiteVector } from './geometry'
import type { AutopilotDriverId } from './drivers/profiles'
import { decodeAutopilotMode, driverProfiles } from './drivers/profiles'

export interface UdpOptions {
  driver?: AutopilotDriverId
  kind: 'sitl' | 'telemetry-only'
  listenPort: number
  /** Fixed loopback destination. Never point a SITL forwarder at a physical vehicle. */
  sitlPort?: number
  systemId?: number
  componentId?: number
  now?: () => number
}
export interface AutopilotAdapter extends FlightAdapter {
  readonly driver: AutopilotDriverId
  /** One zero setpoint per call. Caller must sustain >= 5Hz during explicit SITL preparation. */
  primeOffboard: () => { ready: boolean, reason: string }
}

/** Local MAVProxy/mavlink-router endpoint. Physical hardware is receive-only. */
export async function createUdpAdapter(options: UdpOptions): Promise<AutopilotAdapter> {
  const driver = options.driver ?? 'ardupilot'
  if (driver !== 'ardupilot' && driver !== 'px4') throw new TypeError('Unknown autopilot driver')
  const profile = driverProfiles[driver]
  const kind = options.kind
  if (kind !== 'sitl' && kind !== 'telemetry-only') throw new TypeError('Unknown UDP adapter mode')
  const portValid = (port: number): boolean => Number.isInteger(port) && port > 0 && port <= 65535
  if (!portValid(options.listenPort) || (options.sitlPort !== undefined && !portValid(options.sitlPort)))
    throw new RangeError('Invalid UDP port')
  const now = options.now ?? (() => performance.now())
  const systemId = options.systemId ?? 1
  const componentId = options.componentId ?? 1
  if (![systemId, componentId].every(id => Number.isInteger(id) && id >= 1 && id <= 255)) {
    throw new RangeError('Invalid autopilot identity')
  }
  const socket = createSocket('udp4')
  let peerPort = options.sitlPort
  let sequence = 0
  let closed = false
  let transportError = false
  let heartbeatAt = -Infinity
  let positionAt = -Infinity
  let batteryAt = -Infinity
  let primeStarted = -Infinity
  let lastSetpointAt = -Infinity
  let telemetry: Telemetry = { position: zero(), velocity: zero(), batteryPercent: -1, positionHealthy: false, armed: false, mode: 'manual', receivedAtMs: -Infinity }
  socket.on('error', () => { transportError = true })
  socket.on('message', (bytes, remote) => {
    if (remote.address !== '127.0.0.1') return
    if (peerPort !== undefined && remote.port !== peerPort) return
    for (const frame of decodeDatagram(bytes)) {
      if (frame.systemId !== systemId || frame.componentId !== componentId) continue
      if (peerPort === undefined && frame.id !== 0) continue
      const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength)
      const receivedAt = now()
      if (frame.id === 0) {
        if (view.getUint8(5) !== profile.autopilotId || view.getUint8(4) !== profile.vehicleType) continue
        peerPort ??= remote.port
        heartbeatAt = receivedAt
        const mode = view.getUint32(0, true)
        telemetry.armed = (view.getUint8(6) & 128) !== 0
        telemetry.mode = decodeAutopilotMode(driver, mode)
      }
      else if (frame.id === 1) {
        batteryAt = receivedAt
        telemetry.batteryPercent = view.getInt8(30)
      }
      else if (frame.id === 32) {
        positionAt = receivedAt
        telemetry.position = { north: view.getFloat32(4, true), east: view.getFloat32(8, true), down: view.getFloat32(12, true) }
        telemetry.velocity = { north: view.getFloat32(16, true), east: view.getFloat32(20, true), down: view.getFloat32(24, true) }
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(options.listenPort, '127.0.0.1', () => { socket.off('error', reject); resolve() })
  })
  function read(): Telemetry | undefined {
      if (closed || transportError) return undefined
      telemetry = { ...telemetry, receivedAtMs: Math.min(heartbeatAt, positionAt, batteryAt), positionHealthy: kind === 'sitl' }
      return structuredClone(telemetry)
  }
  function transmit(velocity: Telemetry['velocity']) {
    const timestamp = now()
    const frame = encodeVelocity(velocity, { sequence: sequence++ % 256, targetSystem: systemId, targetComponent: componentId, bootMs: timestamp })
    socket.send(frame, peerPort!, '127.0.0.1', (error) => { if (error) transportError = true })
    lastSetpointAt = timestamp
  }
  return {
    kind, driver, read,
    primeOffboard() {
      if (driver !== 'px4' || kind !== 'sitl') throw new Error('Offboard priming is supported only by the PX4 SITL driver')
      const timestamp = now()
      const t = read()
      if (!t || peerPort === undefined || !Number.isFinite(timestamp) || t.receivedAtMs > timestamp
        || timestamp - t.receivedAtMs > 1000 || !finiteVector(t.position) || !finiteVector(t.velocity)
        || t.batteryPercent < 25 || t.batteryPercent > 100 || t.mode === 'rtl' || t.mode === 'land') {
        primeStarted = -Infinity
        return { ready: false, reason: 'Fresh simulator telemetry and battery reserve required' }
      }
      if (timestamp < lastSetpointAt || timestamp - lastSetpointAt > 400 || !Number.isFinite(primeStarted)) primeStarted = timestamp
      transmit(zero())
      return { ready: timestamp - primeStarted >= 1500, reason: 'Stream zero-velocity setpoints before selecting PX4 Offboard' }
    },
    send(decision: Decision) {
      if (closed || transportError || kind !== 'sitl' || peerPort === undefined) return
      // Release stops the setpoint stream. The autopilot's configured and tested timeout
      // must own link-loss handling, including process crashes and power loss.
      if (decision.kind === 'release') return
      if (driver === 'px4' && (now() - lastSetpointAt > 400 || now() < lastSetpointAt || now() - primeStarted < 1500 || !Number.isFinite(primeStarted) || telemetry.mode !== 'guided')) return
      transmit(decision.kind === 'velocity' ? decision.velocity : zero())
    },
    close() { if (!closed) { closed = true; socket.close() } },
  }
}
