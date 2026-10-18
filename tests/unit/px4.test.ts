import { createSocket } from 'node:dgram'
import { expect, test } from 'bun:test'
import { decodeAutopilotMode } from '../../resources/functions/drone/drivers/profiles'
import { createArduPilotDriver, createPx4Driver } from '../../resources/functions/drone/drivers'
import { decodeDatagram, encodeFrame } from '../../resources/functions/drone/mavlink'

async function bind() {
  const socket = createSocket('udp4')
  await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve))
  return socket
}
async function port() { const s = await bind(); const p = s.address().port; s.close(); return p }
async function until(condition: () => boolean) {
  const deadline = performance.now() + 1500
  while (!condition()) { if (performance.now() > deadline) throw new Error('UDP timeout'); await Bun.sleep(10) }
}
function heartbeat(autopilot = 12, mode = 6 << 16) {
  const payload = new Uint8Array(9)
  const view = new DataView(payload.buffer)
  view.setUint32(0, mode, true)
  payload.set([2, autopilot, 129, 4, 3], 4)
  return encodeFrame(0, payload, 0, 1, 1)
}
function state() {
  const battery = new Uint8Array(31); battery[30] = 90
  const position = new Uint8Array(28); new DataView(position.buffer).setFloat32(12, -12, true)
  return [encodeFrame(1, battery, 1, 1, 1), encodeFrame(32, position, 2, 1, 1)]
}

test('PX4 custom modes are decoded independently of ArduPilot mode values', () => {
  expect(decodeAutopilotMode('px4', 6 << 16)).toBe('guided')
  expect(decodeAutopilotMode('px4', (4 << 16) | (5 << 24))).toBe('rtl')
  expect(decodeAutopilotMode('px4', (4 << 16) | (6 << 24))).toBe('land')
  expect(decodeAutopilotMode('px4', 4)).toBe('manual')
  expect(decodeAutopilotMode('ardupilot', 4)).toBe('guided')
})

test('PX4 prime is explicit, finite, rate-checked and never available for hardware', async () => {
  const peer = await bind()
  const receivePort = await port()
  let now = 0
  const driver = await createPx4Driver({ kind: 'sitl', listenPort: receivePort, now: () => now })
  const packets: Uint8Array[] = []
  peer.on('message', data => packets.push(data))
  const sendState = () => { for (const data of [heartbeat(), ...state()]) peer.send(data, receivePort, '127.0.0.1') }
  try {
    expect(driver.primeOffboard().ready).toBe(false)
    sendState()
    await until(() => driver.read()?.receivedAtMs === 0)
    driver.send({ kind: 'velocity', reason: 'unprimed', velocity: { north: 1, east: 0, down: 0 } })
    await Bun.sleep(20)
    expect(packets.length).toBe(0)
    for (let step = 0; step <= 8; step++) {
      now = step * 200
      sendState()
      await Bun.sleep(5)
      expect(driver.primeOffboard().ready).toBe(step === 8)
    }
    driver.send({ kind: 'velocity', reason: 'primed', velocity: { north: 1, east: 0, down: 0 } })
    await until(() => packets.length === 10)
    const last = decodeDatagram(packets.at(-1)!)[0]!
    expect(new DataView(last.payload.buffer).getFloat32(16, true)).toBe(1)
    now += 600
    driver.send({ kind: 'velocity', reason: 'gap', velocity: { north: 1, east: 0, down: 0 } })
    await Bun.sleep(20)
    expect(packets.length).toBe(10)
    sendState(); await Bun.sleep(10)
    expect(driver.primeOffboard().ready).toBe(false)
  }
  finally { driver.close(); peer.close() }
  const hardware = await createPx4Driver({ kind: 'telemetry-only', listenPort: await port() })
  try { expect(() => hardware.primeOffboard()).toThrow('SITL') }
  finally { hardware.close() }
})

test('drivers refuse the other autopilot heartbeat and retain an immutable profile', async () => {
  const peer = await bind()
  const receivePort = await port()
  const driver = await createPx4Driver({ kind: 'sitl', listenPort: receivePort })
  try {
    peer.send(heartbeat(3, 4), receivePort, '127.0.0.1')
    for (const data of state()) peer.send(data, receivePort, '127.0.0.1')
    await Bun.sleep(25)
    expect(driver.read()?.receivedAtMs).toBe(-Infinity)
    expect(driver.driver).toBe('px4')
    peer.send(heartbeat(), receivePort, '127.0.0.1')
    for (const data of state()) peer.send(data, receivePort, '127.0.0.1')
    await until(() => Number.isFinite(driver.read()?.receivedAtMs))
    expect(driver.read()?.mode).toBe('guided')
  }
  finally { driver.close(); peer.close() }
  const ardu = await createArduPilotDriver({ kind: 'telemetry-only', listenPort: await port() })
  try { expect(ardu.driver).toBe('ardupilot'); expect(() => ardu.primeOffboard()).toThrow() }
  finally { ardu.close() }
})
