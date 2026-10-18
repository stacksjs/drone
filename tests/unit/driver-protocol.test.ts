import { expect, test } from 'bun:test'
import vectors from '../fixtures/drivers/wire.json'
import { decodeDatagram, encodeFrameV2 } from '../../resources/functions/drone/mavlink'

test('MAVLink 2 protocol packets match independent pymavlink fixtures with extension truncation', () => {
  for (const [name, hex] of Object.entries(vectors.packets)) {
    if (name === 'signedHeartbeat') continue
    const frames = decodeDatagram(Uint8Array.fromHex(hex)), frame = frames[0]!
    expect(frames.length).toBe(1)
    expect(frame.version).toBe(2)
    expect(frame.sequence).toBe(11)
    expect(encodeFrameV2(frame.id, frame.payload, 11, frame.systemId, frame.componentId).toHex()).toBe(hex)
  }
})

import { createMavlinkSigning } from '../../resources/functions/drone/drivers/signing'
import { commandPayload, readParameterPayload, setParameterPayload, missionCountPayload, missionAckPayload, waypointPayload } from '../../resources/functions/drone/drivers/messages'
import type { AutopilotDriverId } from '../../resources/functions/drone/drivers/profiles'
import { createDriverProtocol } from '../../resources/functions/drone/drivers/protocol'

const packet = (name: keyof typeof vectors.packets) => decodeDatagram(Uint8Array.fromHex(vectors.packets[name]))[0]!
const waypoint = { command: 16 as const, frame: 6 as const, latitudeDeg: 0.001, longitudeDeg: 0.002, altitudeM: 10, yawDeg: 90 }
test('protocol message builders agree with external wire vectors, including driver-specific integer bytes', () => {
  const cases: [keyof typeof vectors.packets, number, Uint8Array][] = [
    ['command', 76, commandPayload(511, [32, 200000], 1, 1)], ['read', 20, readParameterPayload('TEST_INT', 1, 1)],
    ['setCast', 23, setParameterPayload('TEST_INT', 42, 6, 'c-cast', 1, 1)], ['setBytes', 23, setParameterPayload('TEST_INT', 42, 6, 'bytewise', 1, 1)],
    ['count', 44, missionCountPayload(2, 1, 1)], ['request', 51, missionCountPayload(0, 1, 1)],
    ['missionAck', 47, missionAckPayload(0, 1, 1)], ['item', 73, waypointPayload(waypoint, 0, 1, 1)],
  ]
  for (const [name, id, payload] of cases) expect(encodeFrameV2(id, payload, 11).toHex()).toBe(vectors.packets[name])
})
test('strict signing verifies the independent pymavlink vector, refuses tamper, replay, unsigned and stale clocks', () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i), timestamp = () => 1000000n
  const sign = () => createMavlinkSigning({ key, linkId: 7, timestamp })
  const bytes = Uint8Array.fromHex(vectors.packets.signedHeartbeat), verifier = sign()
  expect(decodeDatagram(bytes)).toEqual([])
  expect(decodeDatagram(bytes, verifier).length).toBe(1)
  expect(decodeDatagram(bytes, verifier)).toEqual([])
  const f = decodeDatagram(bytes, sign())[0]!
  expect(encodeFrameV2(f.id, f.payload, 11, 1, 1, sign()).toHex()).toBe(vectors.packets.signedHeartbeat)
  const altered = bytes.slice(); altered[altered.length - 1]! ^= 1
  expect(decodeDatagram(altered, sign())).toEqual([])
  expect(decodeDatagram(Uint8Array.fromHex(vectors.packets.ack), sign())).toEqual([])
  expect(decodeDatagram(bytes, createMavlinkSigning({ key, linkId: 7, timestamp: () => 8000001n }))).toEqual([])
  let at = 1000000n
  const reversed = createMavlinkSigning({ key, linkId: 7, timestamp: () => at })
  expect(decodeDatagram(bytes, reversed).length).toBe(1)
  at--; expect(decodeDatagram(bytes, reversed)).toEqual([])
})
function session(driver: AutopilotDriverId = 'ardupilot') {
  let now = 0, seq = 0
  const sent: { id: number, payload: Uint8Array }[] = []
  const protocol = createDriverProtocol({ driver, kind: 'sitl', systemId: 1, componentId: 1, now: () => now, transmit(id, payload) { sent.push({ id, payload: payload.slice() }) } })
  function deliver(id: number, payload: Uint8Array, system = 1, component = 1) { protocol.receive(decodeDatagram(encodeFrameV2(id, payload, seq++ % 256, system, component))[0]!) }
  function heartbeat() { const hb = new Uint8Array(9); hb.set([2, driver === 'ardupilot' ? 3 : 12, 0, 4, 3], 4); deliver(0, hb) }
  function ack(command = 511, result = 0, target = 245) { const p = packet('ack').payload.slice(); new DataView(p.buffer).setUint16(0, command, true); p[2] = result; p[8] = target; deliver(77, p) }
  async function discover(bits = 8196n) {
    heartbeat()
    const result = protocol.discover(), version = packet('version').payload.slice()
    new DataView(version.buffer).setBigUint64(0, bits, true)
    deliver(148, version); ack(512)
    return result
  }
  function advance(to: number) { while (now < to) { now = Math.min(to, now + 500); heartbeat(); protocol.tick() } }
  function value(n: number, type = 6, id = 'TEST_INT') {
    const p = packet(driver === 'ardupilot' ? 'valueCast' : 'valueBytes').payload.slice(), v = new DataView(p.buffer)
    p.fill(0, 8, 24); p.set(new TextEncoder().encode(id), 8); p[24] = type
    if (driver === 'ardupilot' || type === 9) v.setFloat32(0, n, true); else v.setInt32(0, n, true)
    deliver(22, p)
  }
  return { protocol, sent, deliver, heartbeat, ack, discover, advance, value, setTime(t: number) { now = t } }
}
test('capability discovery requires matching heartbeat, MAVLink2 and both version and command acknowledgement', async () => {
  const s = session()
  await expect(s.protocol.sendCommand(511, [32, 200000])).rejects.toMatchObject({ code: 'unavailable' })
  const c = await s.discover()
  expect(c.parameterEncoding).toBe('c-cast'); expect(c.encodingEvidence).toBe('explicit-driver-profile'); expect(c.missionInt).toBe(true)
  const px = session('px4'); expect((await px.discover()).parameterEncoding).toBe('bytewise')
  const unsupported = session(); await expect(unsupported.discover(4n)).rejects.toMatchObject({ code: 'invalid-response' })
  const ambiguous = session(); await expect(ambiguous.discover(8196n | 16n | 131072n)).rejects.toMatchObject({ code: 'invalid-response' })
})
test('acknowledged commands filter targets, retry confirmations, serialize and wait for final progress result', async () => {
  const s = session(); await s.discover()
  const result = s.protocol.setMessageRate(32, 5)
  expect(s.sent.filter(p => p.id === 76).at(-1)!.payload).toEqual(commandPayload(511, [32, 200000], 1, 1))
  await expect(s.protocol.readParameter('TEST_INT')).rejects.toMatchObject({ code: 'busy' })
  s.ack(511, 0, 99); s.advance(500)
  expect(s.sent.filter(p => p.id === 76).at(-1)!.payload[32]).toBe(1)
  s.ack(511, 5); expect(s.protocol.snapshot().active!.inProgress).toBe(true)
  const sends = s.sent.filter(p => p.id === 76).length; s.advance(2500)
  expect(s.sent.filter(p => p.id === 76).length).toBe(sends)
  s.ack(); expect((await result).executionConfirmed).toBe(false)
  const rejected = s.protocol.sendCommand(123); s.ack(123, 3)
  await expect(rejected).rejects.toMatchObject({ code: 'rejected' })
})
test('timeouts and aborts quarantine ambiguous command keys, cancel locally and cannot be revived by late replies', async () => {
  const s = session(); await s.discover()
  const expired = s.protocol.sendCommand(123).catch(e => e)
  s.advance(2000)
  expect((await expired).code).toBe('timeout')
  await expect(s.protocol.sendCommand(123)).rejects.toMatchObject({ code: 'ambiguous' })
  const abort = new AbortController(), cancelled = s.protocol.sendCommand(124, [], { signal: abort.signal }).catch(e => e)
  abort.abort(); expect((await cancelled).code).toBe('cancelled')
  s.ack(124); expect(s.protocol.snapshot().active).toBeNull()
  await expect(s.protocol.sendCommand(124)).rejects.toMatchObject({ code: 'ambiguous' })
  const before = s.sent.length
  await expect(s.protocol.sendCommand(125, [], { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'cancelled' })
  expect(s.sent.length).toBe(before)
})
test('heartbeat loss, reversed time, close and changed capabilities fail the session without automatic recovery', async () => {
  for (const mode of ['loss', 'clock', 'close', 'identity'] as const) {
    const s = session(); await s.discover(); const result = s.protocol.sendCommand(123).catch(e => e)
    if (mode === 'loss') { s.setTime(1501); s.heartbeat() }
    if (mode === 'clock') { s.setTime(-1); s.protocol.tick() }
    if (mode === 'close') s.protocol.close()
    if (mode === 'identity') { const v = packet('version').payload.slice(); new DataView(v.buffer).setBigUint64(8, 999n, true); s.deliver(148, v) }
    expect((await result).code).toBe(mode === 'close' ? 'closed' : 'transport-lost')
    await expect(s.protocol.sendCommand(124)).rejects.toBeInstanceOf(Error)
  }
})
test('both parameter encodings read by ID and verify writes through explicit metadata/readback', async () => {
  for (const driver of ['ardupilot', 'px4'] as const) {
    const s = session(driver); await s.discover()
    const read = s.protocol.readParameter('TEST_INT'); s.value(42); expect((await read).value).toBe(42)
    const write = s.protocol.writeParameter('TEST_INT', 43, 6)
    expect(s.sent.at(-1)!.id).toBe(20)
    s.value(42)
    const encoded = s.sent.findLast(p => p.id === 23)!.payload
    expect(new DataView(encoded.buffer)[driver === 'px4' ? 'getInt32' : 'getFloat32'](0, true)).toBe(43)
    s.value(43); expect((await write).value).toBe(43)
    const mismatch = s.protocol.writeParameter('TEST_INT', 45, 9).catch(e => e); s.value(43)
    expect((await mismatch).code).toBe('rejected')
    await expect(s.protocol.writeParameter('TEST_INT', NaN, 6)).rejects.toThrow()
    if (driver === 'ardupilot') await expect(s.protocol.writeParameter('TEST_INT', 16777217, 6)).rejects.toThrow('precision')
  }
})
test('mission upload/download/resume use bounded INT waypoints, request ordering and acknowledged current-item selection', async () => {
  const s = session(); await s.discover()
  const items = [waypoint, { ...waypoint, latitudeDeg: 0.003 }], upload = s.protocol.uploadMission(items)
  s.deliver(47, missionAckPayload(0, 245, 191)); expect(s.protocol.snapshot().active).not.toBeNull()
  s.deliver(51, missionCountPayload(0, 245, 191)); s.deliver(51, missionCountPayload(0, 245, 191)); s.deliver(51, missionCountPayload(1, 245, 191))
  s.deliver(47, missionAckPayload(0, 245, 191)); expect(await upload).toEqual({ count: 2, accepted: true })
  const download = s.protocol.downloadMission(); s.deliver(44, missionCountPayload(2, 245, 191))
  s.deliver(73, waypointPayload(items[1]!, 1, 245, 191)); expect(s.protocol.snapshot().active).not.toBeNull()
  s.deliver(73, waypointPayload(items[0]!, 0, 245, 191)); s.deliver(73, waypointPayload(items[1]!, 1, 245, 191))
  const received = await download; expect(received.map(i => i.latitudeDeg)).toEqual([0.001, 0.003])
  expect(s.sent.at(-1)!.id).toBe(47)
  const resume = s.protocol.resumeMission(1)
  s.ack(224); expect(s.sent.at(-1)!.id).toBe(76)
  s.deliver(42, packet('current').payload)
  expect(new DataView(s.sent.at(-1)!.payload.buffer).getUint16(28, true)).toBe(193)
  s.ack(193); expect(await resume).toEqual({ index: 1, accepted: true, executionConfirmed: false })
  await expect(s.protocol.resumeMission(2)).rejects.toThrow()
  await expect(s.protocol.uploadMission(Array.from({ length: 129 }, () => waypoint))).rejects.toThrow()
})
test('mission cancellation, count changes and unsupported items cannot commit partial plans', async () => {
  for (const mode of ['cancel', 'count', 'frame'] as const) {
    const s = session(); await s.discover(); const abort = new AbortController()
    const result = s.protocol.downloadMission({ signal: abort.signal }).catch(e => e)
    s.deliver(44, missionCountPayload(2, 245, 191))
    if (mode === 'cancel') abort.abort()
    if (mode === 'count') s.deliver(44, missionCountPayload(3, 245, 191))
    if (mode === 'frame') { const p = waypointPayload(waypoint, 0, 245, 191); p[34] = 1; s.deliver(73, p) }
    expect((await result).code).toBe(mode === 'cancel' ? 'cancelled' : 'invalid-response')
    expect(s.protocol.snapshot().knownMissionCount).toBeNull()
    await expect(s.protocol.downloadMission()).rejects.toMatchObject({ code: 'ambiguous' })
  }
})

test('unrelated parameter broadcasts do not abort named reads and empty mission transfers complete', async () => {
  const s = session(); await s.discover()
  const read = s.protocol.readParameter('TEST_INT'); s.value(1, 10, 'UNSUPPORTED')
  expect(s.protocol.snapshot().active).not.toBeNull()
  s.value(42); expect((await read).value).toBe(42)
  const upload = s.protocol.uploadMission([]); s.deliver(47, missionAckPayload(0, 245, 191)); expect((await upload).count).toBe(0)
  const download = s.protocol.downloadMission(); s.deliver(44, missionCountPayload(0, 245, 191)); expect(await download).toEqual([])
})
test('progress cannot extend the hard deadline, and uncertain resume quarantines its command stages', async () => {
  const s = session(); await s.discover(); const progress = s.protocol.sendCommand(123).catch(e => e)
  for (let i = 0; i < 60; i++) { s.ack(123, 5); s.advance((i + 1) * 500) }
  expect((await progress).code).toBe('timeout')
  const t = session(); await t.discover(); const upload = t.protocol.uploadMission([waypoint]); t.deliver(51, missionCountPayload(0, 245, 191)); t.deliver(47, missionAckPayload(0, 245, 191)); await upload
  const abort = new AbortController(), resume = t.protocol.resumeMission(0, { signal: abort.signal }).catch(e => e)
  t.ack(224); const current = packet('current').payload.slice(); new DataView(current.buffer).setUint16(0, 0, true); t.deliver(42, current)
  abort.abort(); expect((await resume).code).toBe('cancelled')
  await expect(t.protocol.sendCommand(224, [0])).rejects.toMatchObject({ code: 'ambiguous' })
  await expect(t.protocol.sendCommand(193, [1])).rejects.toMatchObject({ code: 'ambiguous' })
})

import { runDriverProtocolBench } from '../../resources/functions/drone/drivers/bench'
test('both public UDP factories complete unsigned and signed protocol round trips with a deliberately lost ACK', async () => {
  for (const driver of ['ardupilot', 'px4'] as const) {
    for (const signed of [false, true]) {
      const r = await runDriverProtocolBench({ driver, signed, dropFirstAck: true })
      expect(r.evidence).toBe('scripted-loopback-protocol-peer')
      expect(r.firmwareSitlValidated).toBe(false)
      expect(r.confirmations).toEqual([0, 1])
      expect(r.parameterBefore.value).toBe(42); expect(r.parameterAfter.value).toBe(43)
      expect(r.downloaded.length).toBe(2); expect(r.resume.index).toBe(1)
      expect(r.physicalFlightEnabled).toBe(false)
    }
  }
}, 60000)

import { createSocket } from 'node:dgram'
import { createArduPilotDriver, createPx4Driver } from '../../resources/functions/drone/drivers'
import { encodeFrame } from '../../resources/functions/drone/mavlink'
test('every protocol API remains receive-only on physical drivers, including after caller configuration mutation', async () => {
  for (const factory of [createArduPilotDriver, createPx4Driver]) {
    const peer = createSocket('udp4'); await new Promise<void>(resolve => peer.bind(0, '127.0.0.1', resolve))
    const options = { kind: 'telemetry-only' as 'telemetry-only' | 'sitl', listenPort: 0, sitlPort: peer.address().port }
    const d = await factory(options); options.kind = 'sitl'
    let transmitted = 0; peer.on('message', () => transmitted++)
    try {
      const hb = new Uint8Array(9); hb.set([2, d.driver === 'px4' ? 12 : 3, 0, 4, 3], 4)
      peer.send(encodeFrame(0, hb, 1, 1, 1), d.localPort, '127.0.0.1'); await Bun.sleep(25)
      for (const operation of [() => d.protocol.discover(), () => d.protocol.sendCommand(400, [1]), () => d.protocol.setMessageRate(32, 5), () => d.protocol.readParameter('TEST'), () => d.protocol.writeParameter('TEST', 1, 6), () => d.protocol.uploadMission([waypoint]), () => d.protocol.downloadMission(), () => d.protocol.resumeMission(0)]) await expect(operation()).rejects.toBeInstanceOf(Error)
      await Bun.sleep(40); expect(transmitted).toBe(0); expect(d.protocol.snapshot().kind).toBe('telemetry-only')
    }
    finally { d.close(); peer.close() }
  }
})

import { command as cliCommand } from '@stacksjs/testing'
test('native Stacks conformance CLI exercises signed PX4 and rejects unknown driver profiles', async () => {
  const result = await cliCommand(['drivers:bench', '--driver', 'px4', '--signed', '--drop-first-ack']).withTimeout(60000)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout).confirmations).toEqual([0, 1])
  expect((await cliCommand(['drivers:bench', '--driver', 'unknown']).withTimeout(60000)).exitCode).toBe(1)
}, 180000)

test('fresh responses after wire-sequence wrap cannot be suppressed by earlier completed reads', async () => {
  const s = session(); await s.discover()
  const frame = packet('valueCast')
  for (const seq of [30, 32, 34, 36]) {
    const read = s.protocol.readParameter('TEST_INT')
    s.protocol.receive({ ...frame, sequence: seq })
    expect((await read).value).toBe(42)
  }
  // Heartbeat/telemetry may consume the entire wire sequence space between transactions.
  for (let seq = 37; seq < 286; seq++) s.heartbeat()
  const fresh = s.protocol.readParameter('TEST_INT')
  s.protocol.receive({ ...frame, sequence: 30 })
  expect((await fresh).value).toBe(42)
})
test('zero-tail truncated progress means zero percent, while explicit255 means unknown', async () => {
  for (const percent of [0, 255]) {
    const s = session(); await s.discover()
    const done = s.protocol.sendCommand(123), ack = new Uint8Array(10)
    new DataView(ack.buffer).setUint16(0, 123, true); ack[2] = 5; ack[3] = percent
    s.deliver(77, ack); s.ack(123)
    expect((await done).progress).toBe(percent === 0 ? 0 : null)
  }
})
test('lost final download ACK is re-sent for final-item and empty-plan retries with bounded completion state', async () => {
  for (const count of [0, 1]) {
    const s = session(); await s.discover()
    const transfer = s.protocol.downloadMission(), response = count ? waypointPayload(waypoint, 0, 245, 191) : missionCountPayload(0, 245, 191), id = count ? 73 : 44
    if (count) s.deliver(44, missionCountPayload(1, 245, 191))
    s.deliver(id, response); await transfer
    const acknowledgements = () => s.sent.filter(p => p.id === 47).length
    expect(acknowledgements()).toBe(1)
    // The peer missed the final ACK and retries with a fresh MAVLink sequence.
    s.deliver(id, response); expect(acknowledgements()).toBe(2)
    if (count) {
      const resume = s.protocol.resumeMission(0)
      s.deliver(id, response); expect(acknowledgements()).toBe(3)
      s.ack(224); const current = packet('current').payload.slice(); new DataView(current.buffer).setUint16(0, 0, true); s.deliver(42, current); s.ack(193); await resume
    }
    const before = acknowledgements(); s.advance(10001); s.deliver(id, response)
    expect(acknowledgements()).toBe(before)
  }
})

test('transaction ACKs from wrong sources or legacy wire versions cannot satisfy a MAVLink2 operation', async () => {
  const s = session(); await s.discover(); const result = s.protocol.sendCommand(511)
  const payload = packet('ack').payload
  s.deliver(77, payload, 2, 1); s.deliver(77, payload, 1, 2)
  s.protocol.receive(decodeDatagram(encodeFrame(77, payload.subarray(0, 3), 1, 1, 1))[0]!)
  expect(s.protocol.snapshot().active).not.toBeNull()
  s.ack(); expect((await result).command).toBe(511)
})

import { parameterBytes, parseParameter } from '../../resources/functions/drone/drivers/messages'
test('bytewise uint32 NaN-shaped bits and exactly16-byte IDs survive parameter conversion', () => {
  const raw = packet('valueBytes').payload.slice()
  raw.set(parameterBytes(0x7FC00001, 5, 'bytewise')); raw[24] = 5
  raw.set(new TextEncoder().encode('ABCDEFGHIJKLMNOP'), 8)
  const f = decodeDatagram(encodeFrameV2(22, raw, 255, 1, 1))[0]!
  expect(Number.isNaN(new DataView(raw.buffer).getFloat32(0, true))).toBe(true)
  expect(parseParameter(f, 'bytewise')).toMatchObject({ id: 'ABCDEFGHIJKLMNOP', value: 2143289345, type: 5 })
  expect(readParameterPayload('ABCDEFGHIJKLMNOP', 1, 1).at(-1)).toBe(80)
  expect(() => parameterBytes(2143289345, 5, 'c-cast')).toThrow('precision')
})
