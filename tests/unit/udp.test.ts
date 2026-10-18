import { createSocket } from 'node:dgram'
import { describe, expect, test } from 'bun:test'
import fixtures from '../fixtures/mavlink.json'
import { decodeDatagram, encodeFrame } from '../../resources/functions/drone/mavlink'
import type { UdpOptions } from '../../resources/functions/drone/udp'
import { createUdpAdapter } from '../../resources/functions/drone/udp'

async function bindPeer() {
  const socket = createSocket('udp4')
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve))
  return socket
}
async function unusedPort() {
  const peer = await bindPeer()
  const port = peer.address().port
  peer.close()
  return port
}
async function waitUntil(condition: () => boolean) {
  const deadline = performance.now() + 1500
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('UDP test timed out')
    await Bun.sleep(10)
  }
}
function dataFrames() {
  const battery = new Uint8Array(31)
  new DataView(battery.buffer).setInt8(30, 90)
  const position = new Uint8Array(28)
  const view = new DataView(position.buffer)
  view.setFloat32(4, -20, true)
  view.setFloat32(12, -12, true)
  return [Buffer.from(fixtures.v2Heartbeat, 'hex'), encodeFrame(1, battery, 1, 1, 1), encodeFrame(32, position, 2, 1, 1)]
}

describe('real loopback UDP boundary', () => {
  test('physical telemetry mode never transmits, even if asked to move', async () => {
    const peer = await bindPeer()
    const port = await unusedPort()
    const options: UdpOptions = { kind: 'telemetry-only', listenPort: port }
    const adapter = await createUdpAdapter(options)
    options.kind = 'sitl' // Mutating caller config must not promote a physical receiver.
    let replies = 0
    peer.on('message', () => replies++)
    try {
      for (const packet of dataFrames()) peer.send(packet, port, '127.0.0.1')
      await waitUntil(() => adapter.read()?.batteryPercent === 90)
      expect(adapter.read()?.position.down).toBe(-12)
      expect(adapter.read()?.positionHealthy).toBe(false)
      expect(adapter.kind).toBe('telemetry-only')
      adapter.send({ kind: 'velocity', velocity: { north: 1, east: 0, down: 0 }, reason: 'test' })
      adapter.send({ kind: 'hold', reason: 'test' })
      await Bun.sleep(50)
      expect(replies).toBe(0)
    }
    finally { adapter.close(); peer.close() }
  })
  test('SITL learns its return port, emits setpoints and stops on release', async () => {
    const peer = await bindPeer()
    const port = await unusedPort()
    const adapter = await createUdpAdapter({ kind: 'sitl', listenPort: port })
    const packets: Uint8Array[] = []
    peer.on('message', packet => packets.push(packet))
    try {
      for (const packet of dataFrames()) peer.send(packet, port, '127.0.0.1')
      await waitUntil(() => Number.isFinite(adapter.read()?.receivedAtMs))
      expect(adapter.read()?.armed).toBe(true)
      expect(adapter.read()?.mode).toBe('guided')
      adapter.send({ kind: 'velocity', velocity: { north: 1, east: 0, down: 0 }, reason: 'test' })
      await waitUntil(() => packets.length === 1)
      expect(decodeDatagram(packets[0]!)[0]?.id).toBe(84)
      adapter.send({ kind: 'release', reason: 'test' })
      await Bun.sleep(50)
      expect(packets.length).toBe(1)
    }
    finally { adapter.close(); peer.close() }
  })
  test('partial streams and wrong systems cannot refresh all telemetry', async () => {
    const peer = await bindPeer()
    const port = await unusedPort()
    const adapter = await createUdpAdapter({ kind: 'sitl', listenPort: port })
    try {
      peer.send(Buffer.from(fixtures.v1Heartbeat, 'hex'), port, '127.0.0.1')
      await Bun.sleep(20)
      expect(adapter.read()?.receivedAtMs).toBe(-Infinity)
      const battery = new Uint8Array(31)
      battery[30] = 80
      peer.send(encodeFrame(1, battery, 0, 2, 1), port, '127.0.0.1')
      await Bun.sleep(20)
      expect(adapter.read()?.batteryPercent).toBe(-1)
    }
    finally { adapter.close(); peer.close() }
  })
  test('one fresh field does not hide stale fields and a second peer is ignored', async () => {
    const peer = await bindPeer()
    const other = await bindPeer()
    const port = await unusedPort()
    let now = 100
    const adapter = await createUdpAdapter({ kind: 'sitl', listenPort: port, now: () => now })
    try {
      for (const packet of dataFrames()) peer.send(packet, port, '127.0.0.1')
      await waitUntil(() => adapter.read()?.receivedAtMs === 100)
      now = 2000
      peer.send(Buffer.from(fixtures.v2Heartbeat, 'hex'), port, '127.0.0.1')
      const changed = new Uint8Array(31)
      changed[30] = 20
      other.send(encodeFrame(1, changed, 0, 1, 1), port, '127.0.0.1')
      await Bun.sleep(30)
      expect(adapter.read()?.receivedAtMs).toBe(100)
      expect(adapter.read()?.batteryPercent).toBe(90)
    }
    finally { adapter.close(); peer.close(); other.close() }
  })
})
