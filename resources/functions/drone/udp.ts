import type { Decision, FlightAdapter, Telemetry } from './types'
import { createSocket } from 'node:dgram'
import type { AutopilotProtocol } from './drivers/protocol'
import { createDriverProtocol } from './drivers/protocol'
import { createMavlinkSigning } from './drivers/signing'
import { decodeDatagram, encodeFrameV2, encodeVelocity } from './mavlink'
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

/** Local MAVProxy/mavlink-router endpoint. Physical hardware is receive-only. */
export async function createUdpAdapter(options: UdpOptions): Promise<AutopilotAdapter> {
  const driver = options.driver ?? 'ardupilot'
  if (driver !== 'ardupilot' && driver !== 'px4') throw new TypeError('Unknown autopilot driver')
  const profile = driverProfiles[driver]
  const kind = options.kind
  if (kind !== 'sitl' && kind !== 'telemetry-only') throw new TypeError('Unknown UDP adapter mode')
  const portValid = (port: number): boolean => Number.isInteger(port) && port > 0 && port <= 65535
  if (!(options.listenPort === 0 || portValid(options.listenPort)) || (options.sitlPort !== undefined && !portValid(options.sitlPort)))
    throw new RangeError('Invalid UDP port')
  const now = options.now ?? (() => performance.now())
  const systemId = options.systemId ?? 1
  const componentId = options.componentId ?? 1
  if (![systemId, componentId].every(id => Number.isInteger(id) && id >= 1 && id <= 255)) {
    throw new RangeError('Invalid autopilot identity')
  }
  const signing = options.signing ? createMavlinkSigning(options.signing) : undefined
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
  const protocol = createDriverProtocol({ driver, kind, systemId, componentId, now, transmit(id, payload) {
    if (closed || transportError || kind !== 'sitl' || peerPort === undefined) throw new Error('No writable simulator peer')
    socket.send(encodeFrameV2(id, payload, sequence++ % 256, 245, 191, signing), peerPort, '127.0.0.1', (error) => { if (error) { transportError = true; protocol.transportLost() } })
  } })
  socket.on('error', () => { transportError = true; protocol.transportLost() })
  socket.on('message', (bytes, remote) => {
    if (remote.address !== '127.0.0.1') return
    if (peerPort !== undefined && remote.port !== peerPort) return
    for (const frame of decodeDatagram(bytes, signing)) {
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
      protocol.receive(frame)
    }
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(options.listenPort, '127.0.0.1', () => { socket.off('error', reject); resolve() })
  })
  const timer = setInterval(() => protocol.tick(), 25)
  timer.unref()
  function read(): Telemetry | undefined {
      if (closed || transportError) return undefined
      telemetry = { ...telemetry, receivedAtMs: Math.min(heartbeatAt, positionAt, batteryAt), positionHealthy: kind === 'sitl' }
      return structuredClone(telemetry)
  }
  function transmit(velocity: Telemetry['velocity']) {
    const timestamp = now()
    const frame = encodeVelocity(velocity, { sequence: sequence++ % 256, targetSystem: systemId, targetComponent: componentId, bootMs: timestamp, signing })
    socket.send(frame, peerPort!, '127.0.0.1', (error) => { if (error) transportError = true })
    lastSetpointAt = timestamp
  }
  return {
    kind, driver, read, protocol, localPort: socket.address().port,
    primeOffboard() {
      if (driver !== 'px4' || kind !== 'sitl') throw new Error('Offboard priming is supported only by the PX4 SITL driver')
      const timestamp = now()
      const t = read()
      if (!t || protocol.snapshot().fault || peerPort === undefined || !Number.isFinite(timestamp) || t.receivedAtMs > timestamp
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
      if (closed || transportError || protocol.snapshot().fault || kind !== 'sitl' || peerPort === undefined) return
      // Release stops the setpoint stream. The autopilot's configured and tested timeout
      // must own link-loss handling, including process crashes and power loss.
      if (decision.kind === 'release') return
      if (driver === 'px4' && (now() - lastSetpointAt > 400 || now() < lastSetpointAt || now() - primeStarted < 1500 || !Number.isFinite(primeStarted) || telemetry.mode !== 'guided')) return
      transmit(decision.kind === 'velocity' ? decision.velocity : zero())
    },
    close() { if (!closed) { closed = true; clearInterval(timer); protocol.close(); socket.close() } },
  }
}
