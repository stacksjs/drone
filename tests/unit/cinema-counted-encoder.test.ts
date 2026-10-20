import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createCountedCinemaGimbal, createCinemaGimbal } from '../../resources/functions/drone/cinema/gimbal'
import { cinemaCountedEncoderMethod, measureCountedCinemaEncoder } from '../../resources/functions/drone/cinema/counted-encoder'
import type { CinemaCountedEncoder } from '../../resources/functions/drone/cinema/counted-encoder'
import type { SensorVector } from '../../resources/functions/drone/sensors/types'

// Function seam: validates declared count/cadence measurement, not physical flight.
test('measures bootstrap and one count per twenty milliseconds without float subtraction', async () => {
  const module = await import('../../resources/functions/drone/cinema/counted-encoder')
  expect(typeof module.measureCountedCinemaEncoder).toBe('function')
  const current = { sequence: 1, capturedAtMs: 580, receivedAtMs: 600, positionCounts: [35, -35, 0], limitSwitch: false }
  const first = module.measureCountedCinemaEncoder({ current, previous: null })
  expect(first.deltaCounts).toBeNull()
  expect(first.velocityRadS).toBeNull()
  const next = module.measureCountedCinemaEncoder({ current: { ...current, sequence: 2, capturedAtMs: 600, receivedAtMs: 620, positionCounts: [36, -36, 1] }, previous: current })
  expect(next.deltaCounts).toEqual([1, -1, 1])
  expect(next.velocityRadS).toEqual([0.05, -0.05, 0.05])
  expect(next.velocityRadS!.every(n => Math.abs(n) <= 0.05)).toBe(true)
})

// Owned producer seam: tests actual fixture measurement/control, not Cinema readiness.
test('exports the separate owned counted gimbal producer', async () => {
  const module = await import('../../resources/functions/drone/cinema/gimbal')
  expect(typeof module.createCountedCinemaGimbal).toBe('function')
})

const producerSchedule = Array.from({ length: 71 }, (_, i): { atMs: number, goal: SensorVector | null } => {
  const atMs = 600 + i * 20
  return { atMs, goal: atMs === 600 ? null : atMs < 1000 ? [0.05, -0.04, 0.03] : atMs < 1400 ? [0.02, 0, -0.02] : [0, 0, 0] }
})
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
function retainFirst(value: unknown) {
  const path = process.env.CINEMA_COUNTED_PRODUCER_EVIDENCE
  if (!path) return
  mkdirSync(path, { recursive: true })
  writeFileSync(`${path}/result.json`, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 })
}

test('owns one counted plant with actual delayed measurements, control and retirement', () => {
  const gimbal = createCountedCinemaGimbal(), packets: CinemaCountedEncoder[] = []
  try {
    for (const step of producerSchedule) {
      packets.push(gimbal.render(step.atMs))
      if (step.goal) gimbal.command(step.goal, step.atMs)
    }
    const beforeRetirement = gimbal.current()
    gimbal.retire(2000)
    const result = { version: 1, evidence: 'owned-counted-gimbal-producer-test', method: cinemaCountedEncoderMethod, commands: producerSchedule, packets, rows: gimbal.rows, current: gimbal.current(), retirement: { atMs: 2000, before: beforeRetirement }, tail: gimbal.tail(), caps: { packetBytes: 512, plantRowBytes: 768, plantRows: 11251, tailRows: 501, encoderRows: 2251 } }
    // Preserve the FULL first actual producer before every assertion.
    retainFirst(result)
    expect(result.packets).toHaveLength(71)
    expect(result.rows).toHaveLength(501)
    expect(result.tail).toHaveLength(501)
    expect(result.packets[0]!.velocityRadS).toBeNull()
    for (const [i, packet] of result.packets.entries()) {
      expect(Object.keys(packet)).toEqual(['version', 'sequence', 'capturedAtMs', 'receivedAtMs', 'positionCounts', 'deltaCounts', 'positionRad', 'velocityRadS', 'limitSwitch'])
      expect(packet.sequence).toBe(i + 1)
      expect(packet.receivedAtMs).toBe(600 + 20 * i)
      expect(packet.capturedAtMs).toBe(packet.receivedAtMs - 20)
      expect(encodedBytes(packet)).toBeLessThanOrEqual(512)
      const captured = result.rows.find(row => row.atMs === packet.capturedAtMs)!
      for (let axis = 0; axis < 3; axis++) {
        const count = packet.positionCounts[axis]!, physical = captured.positionRad[axis]! / 0.001
        // Independent nearest-count interval, not subtraction of rounded radians.
        expect(Number.isSafeInteger(count) && !Object.is(count, -0)).toBe(true)
        expect(physical >= count - 0.5 && physical < count + 0.5).toBe(true)
        expect(packet.positionRad[axis]).toBe(count * 0.001)
        if (i) {
          const delta = count - result.packets[i - 1]!.positionCounts[axis]!
          expect(packet.deltaCounts![axis]).toBe(delta)
          expect(packet.velocityRadS![axis]).toBe(delta * 0.05)
          expect(Math.abs(packet.velocityRadS![axis]!) <= 0.05).toBe(Math.abs(delta) <= 1)
        }
      }
      expect(packet.limitSwitch).toBe(captured.positionRad.some((n, axis) => Math.abs(n) > [20, 45, 45][axis]! * Math.PI / 180))
    }
    for (const row of result.rows) { expect(encodedBytes(row)).toBeLessThanOrEqual(768); expect(row.atMs % 4).toBe(0) }
    for (const step of producerSchedule.slice(1, -1)) {
      const next = result.rows.find(row => row.atMs === step.atMs + 4)!, packet = result.packets.find(p => p.receivedAtMs === step.atMs)!
      expect(next.requestedAtMs).toBe(step.atMs)
      for (let axis = 0; axis < 3; axis++) expect(next.requestedTorqueNm[axis]).toBe(Math.max(-0.02, Math.min(0.02, 0.12 * (step.goal![axis]! - packet.positionRad[axis]!) - 0.04 * packet.velocityRadS![axis]!)))
    }
    expect(result.current).toEqual(beforeRetirement)
    expect(result.tail[0]!.positionRad).toEqual(result.current.positionRad)
    expect(result.tail[0]!.velocityRadS).toEqual(result.current.velocityRadS)
    expect(result.tail[0]!.appliedTorqueNm).toEqual(result.current.appliedTorqueNm)
    expect(result.tail[0]!.requestedTorqueNm).toEqual([0, 0, 0])
    for (const [i, row] of result.tail.entries()) { expect(row.atMs).toBe(2000 + i * 4); expect(encodedBytes(row)).toBeLessThanOrEqual(768); expect(row.requestedTorqueNm).toEqual([0, 0, 0]) }
  }
  catch (error) {
    const path = process.env.CINEMA_COUNTED_PRODUCER_EVIDENCE
    if (path) writeFileSync(`${path}/failure.json`, JSON.stringify({ name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : 'unknown', commands: producerSchedule, packets, rows: gimbal.rows, current: gimbal.current() }) + '\n', { flag: 'wx', mode: 0o600 })
    throw error
  }
})

// Persistent concrete type consumers. No public measurement/provider overload.
if (false) {
  const legacy = createCinemaGimbal(), counted = createCountedCinemaGimbal(), packet = counted.render(600)
  counted.command([0, 0, 0], 620)
  legacy.command([0, 0, 0], { sequence: 1, capturedAtMs: 580, receivedAtMs: 600, positionRad: [0, 0, 0], velocityRadS: null, limitSwitch: false }, 600)
  // @ts-expect-error Counted commands have no caller measurement parameter.
  counted.command([0, 0, 0], packet, 620)
  // @ts-expect-error Legacy commands still require their measured packet.
  legacy.command([0, 0, 0], 620)
  // @ts-expect-error Counted rows are an owned snapshot accessor, not assignable state.
  counted.rows = []
  // @ts-expect-error Measurement metadata cannot be reconfigured.
  cinemaCountedEncoderMethod.quantumRad = 1
  // @ts-expect-error Factories expose no generic provider.
  createCountedCinemaGimbal<number>()
  // @ts-expect-error Legacy packet lacks required count evidence.
  const countedPacket: CinemaCountedEncoder = legacy.render(600)
  void countedPacket
}

function countTick(sequence = 1, positionCounts: number[] = [0, 0, 0]) { return { sequence, capturedAtMs: 580 + 20 * (sequence - 1), receivedAtMs: 600 + 20 * (sequence - 1), positionCounts, limitSwitch: false } }
function expectInputFailure(input: unknown) {
  try { measureCountedCinemaEncoder(input); throw new Error('accepted invalid input') }
  catch (error) { expect(error).toBeInstanceOf(TypeError); expect((error as Error).message).toBe('cinema-counted-encoder-input') }
}
function expectUnavailable(call: () => unknown) {
  try { call(); throw new Error('accepted invalid call') }
  catch (error) { expect(error).toBeInstanceOf(RangeError); expect((error as Error).message).toBe('cinema-unqualified-result') }
}

test('preserves literal count units across offsets, signed changes and global limits', () => {
  for (const offset of [0, 35, -35]) {
    const previous = countTick(1, [offset, offset, offset])
    const result = measureCountedCinemaEncoder({ current: countTick(2, [offset + 1, offset - 1, offset + 2]), previous })
    expect(result.deltaCounts).toEqual([1, -1, 2])
    expect(result.velocityRadS).toEqual([0.05, -0.05, 0.1])
    expect(result.velocityRadS!.map(n => Math.abs(n) <= 0.05)).toEqual([true, true, false])
    const negative = measureCountedCinemaEncoder({ current: countTick(2, [offset - 2, offset, offset]), previous })
    expect(negative.velocityRadS).toEqual([-0.1, 0, 0])
  }
  const bounds = measureCountedCinemaEncoder({ current: countTick(2, [-8000, 8000, 0]), previous: countTick(1, [8000, -8000, 0]) })
  expect(bounds.deltaCounts).toEqual([-16000, 16000, 0])
  expect(bounds.velocityRadS).toEqual([-800, 800, 0])
  expect(bounds.positionRad).toEqual([-8, 8, 0])
  const final = measureCountedCinemaEncoder({ current: countTick(2221), previous: countTick(2220) })
  expect(final.receivedAtMs).toBe(45000)
  expect(encodedBytes(bounds)).toBeLessThanOrEqual(512)
})

test('rejects malformed count input and both-tick global binding without reading getters or proxy traps', () => {
  const valid = { current: countTick(), previous: null }
  const invalid: unknown[] = [null, [], 0, Object.create(null), { ...valid, extra: 1 }, { current: countTick() }, { ...valid, [Symbol('key')]: true }, Object.defineProperty({ ...valid }, 'hidden', { value: 1 }), Object.create(valid)]
  for (const value of [NaN, Infinity, 0.5, 8001, -8001, Number.MAX_SAFE_INTEGER + 1, -0, '0', null]) {
    invalid.push({ current: countTick(1, [value as number, 0, 0]), previous: null })
    invalid.push({ current: countTick(2), previous: countTick(1, [0, value as number, 0]) })
  }
  invalid.push({ current: countTick(3), previous: { ...countTick(2), capturedAtMs: 580, receivedAtMs: 600 } })
  invalid.push({ current: countTick(2), previous: null }, { current: countTick(), previous: countTick() }, { current: countTick(3), previous: countTick(1) }, { current: countTick(2222), previous: countTick(2221) })
  for (const field of ['sequence', 'capturedAtMs', 'receivedAtMs']) {
    invalid.push({ current: { ...countTick(2), [field]: 0 }, previous: countTick() })
    invalid.push({ current: countTick(3), previous: { ...countTick(2), [field]: 0 } })
  }
  invalid.push({ current: { ...countTick(), limitSwitch: 0 }, previous: null }, { current: { ...countTick(), positionCounts: [0, 0] }, previous: null }, { current: { ...countTick(), positionCounts: [0, , 0] }, previous: null })
  const extraTuple = [0, 0, 0]; Object.defineProperty(extraTuple, 'hidden', { value: 1 })
  invalid.push({ current: { ...countTick(), positionCounts: extraTuple }, previous: null })
  let effects = 0
  const trap = () => { effects++; throw new Error('must not run') }
  invalid.push(new Proxy(valid, { get: trap, ownKeys: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }))
  invalid.push({ current: new Proxy(countTick(), { get: trap, ownKeys: trap, getPrototypeOf: trap }), previous: null })
  invalid.push({ current: { ...countTick(), positionCounts: new Proxy([0, 0, 0], { get: trap, ownKeys: trap, getPrototypeOf: trap }) }, previous: null })
  invalid.push(Object.defineProperty({ previous: null }, 'current', { enumerable: true, get: trap }))
  invalid.push({ current: Object.defineProperty({ ...countTick() }, 'sequence', { enumerable: true, get: trap }), previous: null })
  const accessorTuple = [0, 0, 0]; Object.defineProperty(accessorTuple, '0', { enumerable: true, get: trap })
  invalid.push({ current: { ...countTick(), positionCounts: accessorTuple }, previous: null })
  const revoked = Proxy.revocable(valid, {}); revoked.revoke(); invalid.push(revoked.proxy)
  for (const input of invalid) expectInputFailure(input)
  expect(effects).toBe(0)
})

test('returns detached packets and immutable flat measurement metadata', () => {
  const previous = countTick(), current = countTick(2, [1, -1, 2]), input = { current, previous }
  const packet = measureCountedCinemaEncoder(input)
  current.positionCounts[0] = 90; previous.positionCounts[1] = 90
  expect(packet.positionCounts).toEqual([1, -1, 2])
  expect(packet.deltaCounts).toEqual([1, -1, 2])
  packet.positionCounts[0] = 100; packet.deltaCounts![0] = 100; packet.positionRad[0] = 100; packet.velocityRadS![0] = 100
  expect(current.positionCounts).toEqual([90, -1, 2])
  expect(Object.isFrozen(cinemaCountedEncoderMethod)).toBe(true)
  expect(Object.getPrototypeOf(cinemaCountedEncoderMethod)).toBe(Object.prototype)
  expect(Object.keys(cinemaCountedEncoderMethod)).toEqual(['version', 'method', 'quantumRad', 'intervalMs', 'delayMs', 'rateUnitRadS', 'countLimit', 'deltaLimit', 'rounding'])
  expect(cinemaCountedEncoderMethod).toEqual({ version: 1, method: 'count-difference-v1', quantumRad: 0.001, intervalMs: 20, delayMs: 20, rateUnitRadS: 0.05, countLimit: 8000, deltaLimit: 16000, rounding: 'nearest-ties-positive' })
  expect(Reflect.set(cinemaCountedEncoderMethod, 'quantumRad', 1)).toBe(false)
  expect(encodedBytes(cinemaCountedEncoderMethod)).toBeLessThanOrEqual(512)
})

test('counted commands use the private current packet and all returned histories are detached', () => {
  const gimbal = createCountedCinemaGimbal(), first = gimbal.render(600)
  first.velocityRadS = [999, 999, 999]
  expectUnavailable(() => gimbal.command([0, 0, 0], 600))
  const packet = gimbal.render(620)
  packet.positionCounts[0] = 999; packet.deltaCounts![0] = 999; packet.positionRad[0] = 999; packet.velocityRadS![0] = 999
  const rows = gimbal.rows; rows[0]!.positionRad[0] = 999; rows.pop()
  const current = gimbal.current(); current.positionRad[0] = 999
  const goal: SensorVector = [0.01, 0, 0]
  gimbal.command(goal, 620); goal[0] = 999
  gimbal.render(640)
  const commanded = gimbal.rows.find(row => row.atMs === 624)!
  expect(commanded.requestedTorqueNm).toEqual([0.0012, 0, 0])
  expect(gimbal.rows[0]!.positionRad).toEqual([0, 0, 0])
  expect(gimbal.current().positionRad[0]).not.toBe(999)
  expect(gimbal.rows).not.toBe(gimbal.rows)
  expect(Object.getOwnPropertyDescriptor(gimbal, 'rows')!.enumerable).toBe(true)
  gimbal.retire(640)
  const tail = gimbal.tail(); tail[0]!.positionRad[0] = 999; tail[1]!.requestedTorqueNm[0] = 999; tail.pop()
  expect(gimbal.tail()).toHaveLength(501)
  expect(gimbal.tail()[0]!.positionRad[0]).not.toBe(999)
  expect(gimbal.tail()[1]!.requestedTorqueNm).toEqual([0, 0, 0])
})

test('rejects counted commands and epochs before mutation while retaining repeated-command semantics', () => {
  const gimbal = createCountedCinemaGimbal(), control = createCountedCinemaGimbal()
  expectUnavailable(() => gimbal.render(620))
  expectUnavailable(() => Reflect.apply(gimbal.retire, undefined, [null]))
  expectUnavailable(() => Reflect.apply(gimbal.retire, undefined, [undefined]))
  expectUnavailable(() => gimbal.tail())
  for (const owned of [gimbal, control]) { owned.render(600); owned.render(620); owned.command([0.02, 0, 0], 620); owned.command([0.01, 0, 0], 620) }
  let effects = 0
  const trap = () => { effects++; throw new Error('must not run') }
  const accessor = [0, 0, 0]; Object.defineProperty(accessor, '0', { enumerable: true, get: trap })
  const goals: unknown[] = [null, [], [0, 0], [NaN, 0, 0], [Infinity, 0, 0], [1, 0, 0], ['0', 0, 0], [0, , 0], accessor, new Proxy([0, 0, 0], { get: trap, ownKeys: trap, getPrototypeOf: trap })]
  const before = gimbal.rows
  for (const goal of goals) expectUnavailable(() => Reflect.apply(gimbal.command, undefined, [goal, 620]))
  expectUnavailable(() => Reflect.apply(gimbal.command, undefined, [[0, 0, 0], { velocityRadS: [0, 0, 0] }, 620]))
  expectUnavailable(() => gimbal.command([0, 0, 0], 600))
  expectUnavailable(() => gimbal.render(620))
  expectUnavailable(() => gimbal.render(NaN))
  expectUnavailable(() => gimbal.retire(600))
  expect(gimbal.rows).toEqual(before)
  expect(effects).toBe(0)
  gimbal.render(640); control.render(640)
  expect(gimbal.rows).toEqual(control.rows)
  expect(gimbal.current()).toEqual(control.current())
  gimbal.retire(640)
  const retired = gimbal.rows
  expectUnavailable(() => gimbal.command([0, 0, 0], 640))
  expectUnavailable(() => gimbal.render(660))
  expectUnavailable(() => gimbal.retire(640))
  expect(gimbal.rows).toEqual(retired)
})

test('preserves the legacy direct rows alias and three-argument measured command', () => {
  const legacy = createCinemaGimbal()
  expect(legacy.rows).toBe(legacy.rows)
  legacy.rows[0]!.positionRad[0] = 0.001
  expect(legacy.current().positionRad[0]).toBe(0.001)
  const untouched = createCinemaGimbal(); untouched.render(600)
  const packet = untouched.render(620)
  untouched.command([0.01, 0, 0], packet, 620)
  untouched.render(640)
  expect(untouched.rows.find(row => row.atMs === 624)!.requestedTorqueNm).toEqual([0.0012, 0, 0])
})
