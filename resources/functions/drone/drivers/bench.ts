import type { AutopilotDriverId } from './profiles'
import type { MissionWaypoint } from './messages'
import { createArduPilotDriver, createPx4Driver } from './index'
import { createMavlinkSigning } from './signing'
import type { MavlinkFrame } from '../mavlink'
import { encodeFrameV2 } from '../mavlink'
import { createDriverBenchPeer } from './bench-peer'
import { driverProfiles } from './profiles'
import { messageView, missionAckPayload, missionCountPayload, normalizeWaypoint, parameterBytes, parseWaypoint, waypointPayload } from './messages'

/** Scripted protocol peer, not an ArduPilot/PX4 firmware process or a flight simulator. */
export async function runDriverProtocolBench(options: { driver: AutopilotDriverId, transport?: 'udp' | 'tcp', dropFirstAck?: boolean, signed?: boolean }) {
  const { driver } = options
  if (!['ardupilot', 'px4'].includes(driver)) throw new TypeError('Choose ardupilot or px4')
  const transport = options.transport ?? 'udp'
  if (transport !== 'udp' && transport !== 'tcp') throw new TypeError('Choose udp or tcp')
  const dropFirstAck = options.dropFirstAck === true, signed = options.signed === true
  const encoding = driver === 'px4' ? 'bytewise' : 'c-cast'
  // Public conformance key. Never use this fixture key on a deployed link.
  const key = Uint8Array.from({ length: 32 }, (_, i) => i)
  const timestamp = () => BigInt(Math.floor((Date.now() - Date.UTC(2015, 0, 1)) * 100))
  const peerSigning = signed ? createMavlinkSigning({ key, linkId: 1, timestamp }) : undefined
  let sequence = 0, dropped = 0, integer = 42, peerError: Error | null = null
  let mission: Required<MissionWaypoint>[] = [], staged: Required<MissionWaypoint>[] = [], uploadCount = 0
  const confirmations: number[] = []
  const send = (id: number, payload: Uint8Array) => {
    peer.send(encodeFrameV2(id, payload, sequence++ % 256, 1, 1, peerSigning))
  }
  const ack = (command: number, result = 0) => { const p = new Uint8Array(10); new DataView(p.buffer).setUint16(0, command, true); p.set([result, 100], 2); p.set([245, 191], 8); send(77, p) }
  const heartbeat = () => { const p = new Uint8Array(9); p.set([2, driverProfiles[driver].autopilotId, 0, 4, 3], 4); send(0, p) }
  const value = () => { const p = new Uint8Array(25), v = new DataView(p.buffer); p.set(parameterBytes(integer, 6, encoding)); v.setUint16(4, 1, true); p.set(new TextEncoder().encode('BENCH_INT'), 8); p[24] = 6; send(22, p) }
  function receive(frames: MavlinkFrame[]) {
    try {
      for (const frame of frames) {
        if (frame.systemId !== 245 || frame.componentId !== 191) continue
        const p = frame.payload, v = messageView(frame)
        if (frame.id === 76) {
          const command = v.getUint16(28, true)
          if (command === 512 && v.getFloat32(0, true) === 148) {
            const version = new Uint8Array(60), vv = new DataView(version.buffer)
            vv.setBigUint64(0, 8196n | (driver === 'px4' ? 16n : 131072n), true); vv.setBigUint64(8, 48879n, true)
            send(148, version); ack(command)
          }
          else if (command === 511) {
            confirmations.push(p[32]!)
            if (dropFirstAck && dropped === 0) dropped++; else ack(command)
          }
          else if (command === 224) {
            const index = v.getFloat32(0, true)
            if (!Number.isInteger(index) || index < 0 || index >= mission.length) { ack(command, 2); continue }
            ack(command)
            const current = new Uint8Array(6)
            const cv = new DataView(current.buffer)
            cv.setUint16(0, index, true)
            cv.setUint16(2, mission.length, true)
            current.set([3, 1], 4)
            send(42, current)
          }
          else if (command === 193) ack(command)
          else ack(command, 3)
        }
        if (frame.id === 20 && new TextDecoder().decode(p.subarray(4, 20)).replace(/\0.*$/, '') === 'BENCH_INT') value()
        if (frame.id === 23 && new TextDecoder().decode(p.subarray(6, 22)).replace(/\0.*$/, '') === 'BENCH_INT') {
          integer = encoding === 'bytewise' ? v.getInt32(0, true) : v.getFloat32(0, true)
          // Deliberately omit PARAM_SET echo, exercising explicit readback for both profiles.
        }
        if (frame.id === 44) {
          uploadCount = v.getUint16(0, true); staged = []
          if (uploadCount > 128) throw new Error('Fixture mission budget exceeded')
          if (uploadCount === 0) { mission = []; send(47, missionAckPayload(0, 245, 191)) }
          else send(51, missionCountPayload(0, 245, 191))
        }
        if (frame.id === 73) {
          const index = v.getUint16(28, true)
          if (index === staged.length) staged.push(parseWaypoint(frame))
          if (staged.length === uploadCount) { mission = staged.map(i => ({ ...i })); send(47, missionAckPayload(0, 245, 191)) }
          else send(51, missionCountPayload(staged.length, 245, 191))
        }
        if (frame.id === 43) send(44, missionCountPayload(mission.length, 245, 191))
        if (frame.id === 51) { const index = v.getUint16(0, true); if (mission[index]) send(73, waypointPayload(mission[index]!, index, 245, 191)) }
        if (frame.id === 47 && p[2] === 15) staged = []
      }
    }
    catch (error) { peerError = error instanceof Error ? error : new Error(String(error)) }
  }
  const peer = await createDriverBenchPeer(transport, peerSigning, receive, error => { peerError = error })
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000)
  let adapter: Awaited<ReturnType<typeof createArduPilotDriver>> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  try {
    const factory = driver === 'px4' ? createPx4Driver : createArduPilotDriver
    const signing = signed ? { key, linkId: 2, timestamp } : undefined
    adapter = await factory(transport === 'tcp' ? { transport, kind: 'sitl', port: peer.port, signing } : { kind: 'sitl', listenPort: 0, sitlPort: peer.port, signing })
    peer.start(adapter.localPort); heartbeat(); heartbeatTimer = setInterval(heartbeat, 250)
    const readyDeadline = performance.now() + 5000
    while (!Number.isFinite(adapter.protocol.snapshot().lastHeartbeatAtMs)) { if (performance.now() > readyDeadline || peerError) throw peerError ?? new Error('Fixture discovery heartbeat timeout'); await Bun.sleep(10) }
    const operation = { signal: controller.signal }, protocol = adapter.protocol
    const capabilities = await protocol.discover(operation), rate = await protocol.setMessageRate(32, 5, operation)
    const parameterBefore = await protocol.readParameter('BENCH_INT', operation), parameterAfter = await protocol.writeParameter('BENCH_INT', 43, 6, operation)
    const missionItems: MissionWaypoint[] = [{ command: 16, frame: 6, latitudeDeg: 0.001, longitudeDeg: 0.002, altitudeM: 10 }, { command: 16, frame: 6, latitudeDeg: 0.003, longitudeDeg: 0.004, altitudeM: 12, yawDeg: 90 }]
    const uploaded = await protocol.uploadMission(missionItems, operation), downloaded = await protocol.downloadMission(operation), resume = await protocol.resumeMission(1, operation)
    if (peerError) throw peerError
    if (JSON.stringify(downloaded) !== JSON.stringify(missionItems.map(normalizeWaypoint))) throw new Error('Fixture mission readback mismatch')
    return { evidence: 'scripted-loopback-protocol-peer' as const, driver, transport, signed, physicalFlightEnabled: false as const, firmwareSitlValidated: false as const, hardwareValidated: false as const, capabilities, rate, confirmations, droppedAcks: dropped, parameterBefore, parameterAfter, uploaded, downloaded, resume }
  }
  finally { clearTimeout(timeout); if (heartbeatTimer) clearInterval(heartbeatTimer); adapter?.close(); await peer.close() }
}
