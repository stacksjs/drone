import type { Behavior, Target, Telemetry } from '../../resources/functions/drone'
import { describe, expect, test } from 'bun:test'
import { createGpsTargetSource, createController, createSimulator, decide, defaultLimits, follow, gpsToLocal, zero } from '../../resources/functions/drone'
import fixtures from '../fixtures/mavlink.json'
import { decodeDatagram, encodeFrame, encodeVelocity } from '../../resources/functions/drone/mavlink'

const telemetry = (): Telemetry => ({ position: { north: -20, east: 0, down: -12 }, velocity: zero(), mode: 'guided', armed: true, positionHealthy: true, batteryPercent: 90, receivedAtMs: 1000 })
const target = (): Target => ({ id: 'pilot', position: zero(), headingRadians: 0, confidence: 1, accuracyMeters: 1, receivedAtMs: 1000 })
const behavior = follow({ distanceMeters: 10, altitudeMeters: 12, gain: 0.5 })
const run = (overrides: Partial<Parameters<typeof decide>[0]> = {}) => decide({ telemetry: telemetry(), target: target(), targetId: 'pilot', enabled: true, nowMs: 1000, behavior, ...overrides })

describe('public flight decision boundary', () => {
  test('follows behind target heading and caps speed', () => {
    expect(run()).toEqual({ kind: 'velocity', velocity: { north: 3, east: 0, down: 0 }, reason: 'follow' })
  })
  test('stops following when the pilot selects another mode', () => {
    expect(run({ telemetry: { ...telemetry(), mode: 'manual' } }).kind).toBe('release')
  })
  test('cannot move an unarmed aircraft', () => {
    expect(run({ telemetry: { ...telemetry(), armed: false } }).kind).toBe('release')
  })
  test('stale and future telemetry release authority', () => {
    for (const receivedAtMs of [-1, 1001, Number.NaN])
      expect(run({ telemetry: { ...telemetry(), receivedAtMs } }).kind).toBe('release')
  })
  test('lost position and unknown battery release authority', () => {
    expect(run({ telemetry: { ...telemetry(), positionHealthy: false } }).kind).toBe('release')
    for (const batteryPercent of [-1, 24, 101, Number.NaN])
      expect(run({ telemetry: { ...telemetry(), batteryPercent } }).kind).toBe('release')
  })
  test('lost or unselected targets hold instead of switching people', () => {
    expect(run({ target: undefined }).kind).toBe('hold')
    expect(run({ target: { ...target(), id: 'someone-else' } }).kind).toBe('hold')
    expect(run({ target: { ...target(), receivedAtMs: -1000 } }).kind).toBe('hold')
  })
  test('low-confidence and inaccurate fixes hold', () => {
    expect(run({ target: { ...target(), confidence: 0.5 } }).kind).toBe('hold')
    expect(run({ target: { ...target(), accuracyMeters: 10 } }).kind).toBe('hold')
  })
  test('malformed vectors never reach the command transport', () => {
    expect(run({ telemetry: { ...telemetry(), position: { north: Number.NaN, east: 0, down: -12 } } }).kind).toBe('release')
    expect(run({ behavior: { name: 'bad', velocity: () => ({ north: Infinity, east: 0, down: 0 }) } }).kind).toBe('hold')
  })
  test('plugin exceptions and input mutation cannot bypass checks', () => {
    const plugin: Behavior = { name: 'broken', velocity: () => { throw new Error('broken') } }
    expect(run({ behavior: plugin }).reason).toBe('Behavior failed')
    const input = telemetry()
    run({ telemetry: input, behavior: { name: 'mutating', velocity: ({ telemetry: t }) => { t.position.north = 1000; return zero() } } })
    expect(input.position.north).toBe(-20)
  })
  test('predicts horizontal fence crossing', () => {
    const t = { ...telemetry(), position: { north: 79, east: 0, down: -12 } }
    expect(run({ telemetry: t, target: { ...target(), position: { north: 50, east: 0, down: 0 } }, behavior: { name: 'outbound', velocity: () => ({ north: 3, east: 0, down: 0 }) } }).reason).toBe('Predicted fence or altitude breach')
  })
  test('predicts altitude crossing in down-positive coordinates', () => {
    expect(run({ telemetry: { ...telemetry(), position: { north: -20, east: 0, down: -29 } }, behavior: { name: 'up', velocity: () => ({ north: 0, east: 0, down: -1 }) } }).kind).toBe('hold')
  })
  test('checks closest separation along the segment, not only its endpoint', () => {
    const t = { ...telemetry(), position: { north: -6, east: 0, down: -12 } }
    expect(run({ telemetry: t, behavior: { name: 'cross-target', velocity: () => ({ north: 3, east: 0, down: 0 }) } }).reason).toBe('Predicted target separation breach')
  })
  test('invalid limits fail before evaluating a plugin', () => {
    expect(() => run({ limits: { ...defaultLimits, predictionSeconds: 0 } })).toThrow()
  })
})

describe('controller lifecycle', () => {
  test('leases expire, disable releases, and close is idempotent', () => {
    const sim = createSimulator()
    const controller = createController(sim.adapter, behavior, { targetId: 'pilot' })
    controller.setTarget({ ...target(), receivedAtMs: 0 })
    expect(controller.tick(0).kind).toBe('release')
    controller.enable(0, 500)
    expect(controller.tick(0).kind).toBe('velocity')
    expect(controller.tick(501).kind).toBe('release')
    controller.disable()
    controller.close()
    controller.close()
    expect(() => controller.enable(1000)).toThrow()
  })
  test('another target cannot poison the selected target stream', () => {
    const sim = createSimulator()
    const controller = createController(sim.adapter, behavior, { targetId: 'pilot' })
    controller.setTarget({ ...target(), id: 'bystander', receivedAtMs: 10000 })
    controller.setTarget({ ...target(), receivedAtMs: 0 })
    controller.enable(0)
    expect(controller.tick(0).kind).toBe('velocity')
  })
  test('backwards clocks revoke a lease', () => {
    const sim = createSimulator()
    const controller = createController(sim.adapter, behavior, { targetId: 'pilot' })
    controller.setTarget({ ...target(), receivedAtMs: 0 })
    controller.enable(0)
    controller.tick(100)
    expect(controller.tick(50).kind).toBe('release')
  })
})

describe('simulation behavior', () => {
  test('moves, loses a target, resumes and releases on low battery', () => {
    const sim = createSimulator()
    sim.command('start')
    for (let n = 0; n < 10; n++) sim.step()
    expect(sim.snapshot().trail.length).toBe(10)
    sim.command('lose-target')
    expect(sim.step().decision.kind).toBe('hold')
    sim.command('restore-target')
    expect(sim.step().decision.kind).toBe('velocity')
    sim.command('low-battery')
    expect(sim.step().decision.kind).toBe('release')
    sim.command('pause')
    const before = sim.snapshot().nowMs
    expect(sim.step().nowMs).toBe(before)
  })
  test('validates configuration and keeps snapshots isolated', () => {
    const sim = createSimulator()
    expect(() => sim.configure({ distanceMeters: Number.NaN, altitudeMeters: 12 })).toThrow()
    expect(() => sim.step(Infinity)).toThrow()
    const snapshot = sim.snapshot()
    snapshot.telemetry.position.north = 999
    expect(sim.snapshot().telemetry.position.north).toBe(-10)
  })
  test('stays in the envelope for a ten-minute deterministic run', () => {
    const sim = createSimulator()
    sim.command('start')
    for (let i = 0; i < 3000; i++) {
      const t = sim.step().telemetry
      expect(Math.hypot(t.position.north, t.position.east)).toBeLessThanOrEqual(80)
      expect(-t.position.down).toBeGreaterThanOrEqual(8)
      expect(-t.position.down).toBeLessThanOrEqual(30)
      expect(Math.hypot(t.velocity.north, t.velocity.east)).toBeLessThanOrEqual(3.000001)
    }
  })
})

describe('wire and coordinate contracts', () => {
  test('north/east GPS conversion and altitude reference', () => {
    const local = gpsToLocal({ latitude: 0, longitude: 0 }, { latitude: 0.001, longitude: 0.001, altitudeMeters: 12 })
    expect(local.north).toBeCloseTo(111.195, 2)
    expect(local.east).toBeCloseTo(111.195, 2)
    expect(local.down).toBe(-12)
    expect(() => gpsToLocal({ latitude: 90, longitude: 0 }, { latitude: 90, longitude: 0, altitudeMeters: 12 })).toThrow()
  })
  test('MAVLink velocity payload uses verified common.xml offsets and mask', () => {
    const packet = encodeVelocity({ north: 1, east: 2, down: -0.5 })
    const frame = decodeDatagram(packet)[0]!
    expect(frame.id).toBe(84)
    const view = new DataView(frame.payload.buffer)
    expect(view.getFloat32(16, true)).toBe(1)
    expect(view.getFloat32(20, true)).toBe(2)
    expect(view.getFloat32(24, true)).toBe(-0.5)
    expect(view.getUint16(48, true)).toBe(3527)
    expect(frame.payload[52]).toBe(1)
  })
  test('rejects corrupted frames and untrusted payloads', () => {
    const packet = encodeVelocity(zero())
    packet[20] = packet[20]! ^ 1
    expect(decodeDatagram(packet)).toEqual([])
    expect(decodeDatagram(new Uint8Array([0xFE]))).toEqual([])
    expect(() => encodeVelocity({ north: Infinity, east: 0, down: 0 })).toThrow()
  })
  test('accepts multiple v1 frames and ignores unknown dialects', () => {
    const packet = encodeFrame(0, new Uint8Array(9))
    const both = new Uint8Array(packet.length * 2)
    both.set(packet); both.set(packet, packet.length)
    expect(decodeDatagram(both).length).toBe(2)
  })
})

// Fixtures generated with pymavlink 2.4.50, rather than our own encoder.
test('matches independent pymavlink wire fixtures and refuses signed packets', () => {
  expect(Buffer.from(encodeVelocity({ north: 1, east: 2, down: -0.5 })).toString('hex')).toBe(fixtures.v1Velocity)
  for (const hex of [fixtures.v1Velocity, fixtures.v2Velocity]) {
    const frame = decodeDatagram(Buffer.from(hex, 'hex'))[0]!
    expect(frame.id).toBe(84)
    expect(new DataView(frame.payload.buffer).getFloat32(24, true)).toBe(-0.5)
  }
  expect(decodeDatagram(Buffer.from(fixtures.signedV2Velocity, 'hex'))).toEqual([])
})

test('paired GPS sources reject jumps and use local monotonic time', () => {
  let now = 100
  const source = createGpsTargetSource({ targetId: 'pilot', origin: { latitude: 0, longitude: 0 }, now: () => now })
  const fix = { latitude: 0, longitude: 0, accuracyMeters: 1, headingRadians: 0 }
  expect(source.update(fix).receivedAtMs).toBe(100)
  now = 200
  expect(() => source.update({ ...fix, latitude: 1 })).toThrow('jump')
  now = 300
  expect(source.update(fix).id).toBe('pilot')
  expect(() => source.update(fix)).toThrow('Out-of-order')
})

test('future-dated enable cannot extend a short autonomy lease', () => {
  const sim = createSimulator()
  const controller = createController(sim.adapter, behavior, { targetId: 'pilot' })
  controller.setTarget({ ...target(), receivedAtMs: 0 })
  controller.enable(1000000, 1000)
  expect(controller.tick(0).kind).toBe('release')
  expect(controller.tick(1000000).kind).toBe('release')
})

test('custom behaviors determine simulated motion across multiple steps', () => {
  const sim = createSimulator({ behavior: { name: 'custom-east', velocity: () => ({ north: 0, east: 1, down: 0 }) } })
  sim.command('start')
  for (let i = 0; i < 5; i++) expect(sim.step().decision.reason).toBe('custom-east')
  expect(sim.snapshot().telemetry.position.north).toBe(-10)
  expect(sim.snapshot().telemetry.position.east).toBeCloseTo(1, 6)
})
