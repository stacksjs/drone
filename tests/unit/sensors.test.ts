import { beforeAll, describe, expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { join } from 'node:path'
import fixture from '../fixtures/sensors/bench-v1.json'
import runtimeFixtures from '../fixtures/mavlink.json'
import { decodeSensorFrame } from '../../resources/functions/drone/sensors/protocol'
import { convertImu, convertPressure, validateSensorCalibrations } from '../../resources/functions/drone/sensors/calibration'
import { createSensorPipeline, sensorAnchorFromHandshake } from '../../resources/functions/drone/sensors/pipeline'
import { createSensorReplay, parseSensorDataset } from '../../resources/functions/drone/sensors/replay'
import { inspectSensorCapture } from '../../resources/functions/drone/sensors/capture'
import { createSimulator } from '../../resources/functions/drone/simulator'
import { buildRuntime } from '../../resources/functions/drone/runtime/build'
import { commandFrame, encodeRuntimeFrame } from '../../resources/functions/drone/runtime/protocol'
import type { SensorKind, ImuMeasurement, PressureMeasurement, GnssMeasurement } from '../../resources/functions/drone/sensors/types'

const dataset = parseSensorDataset(fixture)
const anchor = { ...dataset.anchor, bootId: BigInt(dataset.anchor.bootId), boardUs: BigInt(dataset.anchor.boardUs) }
const first = (kind: SensorKind) => dataset.records.find(r => decodeSensorFrame(Uint8Array.fromHex(r.hex)).kind === kind)!
const bytes = (kind: SensorKind) => Uint8Array.fromHex(first(kind).hex)
function mutate(input: Uint8Array, change: (data: Uint8Array, view: DataView) => void) {
  const result = new Uint8Array(input), view = new DataView(result.buffer)
  change(result, view); view.setUint32(124, Bun.hash.crc32(result.subarray(0, 124)), true)
  return result
}
const pipeline = () => createSensorPipeline({ anchor, calibrations: dataset.calibrations })
const sensor = (p: ReturnType<typeof pipeline>, kind: SensorKind, now: number) => p.snapshot(now).sensors.find(s => s.kind === kind)!

describe('sensor wire, calibration and frames', () => {
  test('independent fixture CRCs, identity, signed bytes and timestamp fields decode', () => {
    expect(decodeSensorFrame(bytes('imu'))).toMatchObject({ kind: 'imu', bootId: 0x1122334455667788n, capturedUs: 1000000n, completedUs: 1000100n, sequence: 1, uncertaintyUs: 2000 })
    for (const row of dataset.records) expect(decodeSensorFrame(Uint8Array.fromHex(row.hex)).sequence).toBeGreaterThan(0)
    expect(() => decodeSensorFrame(bytes('imu').subarray(0, 127))).toThrow()
    expect(() => decodeSensorFrame(bytes('imu').with(2, 2))).toThrow()
    expect(() => decodeSensorFrame(mutate(bytes('imu'), (b, v) => v.setUint32(32, 0x8000, true)))).toThrow()
    expect(() => decodeSensorFrame(mutate(bytes('imu'), b => { b[100] = 1 }))).toThrow()
  })
  test('known BMP280 integer vector returns 25.08 C and 100653.25390625 Pa', () => {
    const result = convertPressure(decodeSensorFrame(bytes('barometer')).payload)
    expect(result.temperatureC).toBe(25.08)
    expect(result.pressurePa).toBe(100653.25390625)
    expect(result.variancePa2).toBeNull()
  })
  test('sensor axes map to right-handed BODY_FRD specific force and angular rate', () => {
    const raw = decodeSensorFrame(bytes('imu')).payload
    const view = new DataView(raw.buffer)
    view.setInt16(10, 16384, false) // sensor +Y, 1000 deg/s at configured full scale.
    const result = convertImu(raw, dataset.calibrations.imu)
    expect(result.frame).toBe('BODY_FRD')
    expect(result.specificForceMps2[2]).toBeCloseTo(-9.80665, 8)
    expect(result.angularRateRadS[1]).toBeCloseTo(-17.4532925199433, 8)
    expect(result.specificForceVariance).toEqual([0.0004, 0.0009, 0.0016])
  })
  test('bias, scale, linear thermal terms and covariance follow the calibrated mount', () => {
    const cal = structuredClone(dataset.calibrations.imu!)
    cal.axes = [2, 1, -3]; cal.accelBias = [1, 2, 3]; cal.accelScale = [2, 1, 1]
    const raw = decodeSensorFrame(bytes('imu')).payload
    new DataView(raw.buffer).setInt16(0, 1325, false) // approximately 35 C.
    const value = convertImu(raw, validateSensorCalibrations({ imu: cal }).imu)
    expect(value.specificForceMps2[0]).toBe(-2)
    expect(value.specificForceMps2[1]).toBeCloseTo(-2.2, 3)
    expect(value.specificForceVariance).toEqual([0.0009, 0.0016, 0.0016])
    const pressure = convertPressure(decodeSensorFrame(bytes('barometer')).payload, { ...dataset.calibrations.barometer!, offsetPa: 10, tempSlopePaPerC: 2 })
    expect(pressure.pressurePa).toBeCloseTo(100643.09390625, 8)
    expect(pressure.variancePa2).toBe(4)
  })
  test('reflected mounts, invalid calibration ranges, saturation and bad factory trim are rejected', () => {
    for (const axes of [[1, 2, -3], [1, 1, 3], [4, 2, 3]]) expect(() => validateSensorCalibrations({ imu: { ...dataset.calibrations.imu!, axes: axes as [number, number, number] } })).toThrow()
    expect(() => validateSensorCalibrations({ imu: { ...dataset.calibrations.imu!, accelScale: [0, 1, 1] } })).toThrow()
    const raw = decodeSensorFrame(bytes('imu')).payload; new DataView(raw.buffer).setInt16(2, -32768, false)
    expect(() => convertImu(raw)).toThrow('saturation')
    const baro = decodeSensorFrame(bytes('barometer')).payload; baro[12] = 0; baro[13] = 0
    expect(() => convertPressure(baro)).toThrow('trim')
  })
})

describe('sensor clocks and independent health', () => {
  test('fresh packets retain capture time rather than refreshing it to receipt time', () => {
    const p = pipeline(); expect(p.ingest(bytes('imu'), first('imu').receivedAtMs).accepted).toBe(true)
    const observation = sensor(p, 'imu', 20).observation!
    expect(observation.estimatedCaptureMs).toBe(0)
    expect(observation.transportAgeUpperMs).toBeCloseTo(20.004, 6)
    expect(observation.measurementAgeUpperMs).toBeCloseTo(22.004, 6)
    expect(observation.receivedAtMs).not.toBe(observation.estimatedCaptureMs)
  })
  test('dropouts expire without a new packet and do not share another sensor age', () => {
    const replay = createSensorReplay(fixture)
    replay.advanceTo(1000)
    const result = replay.advanceTo(1200)
    expect(result.sensors.find(s => s.kind === 'imu')!.quality).toContain('dropout-or-stale')
    expect(result.sensors.find(s => s.kind === 'barometer')!.healthy).toBe(true)
    expect(replay.advanceTo(1500).sensors.find(s => s.kind === 'barometer')!.healthy).toBe(false)
  })
  test('fresh sequence numbers cannot hide repeated raw IMU values', () => {
    const p = pipeline(); p.ingest(bytes('imu'), first('imu').receivedAtMs)
    const repeated = mutate(bytes('imu'), (b, v) => { v.setUint32(4, 2, true); v.setBigUint64(16, 1500000n, true); v.setBigUint64(24, 1500100n, true) })
    expect(p.ingest(repeated, 515).accepted).toBe(true)
    expect(sensor(p, 'imu', 515).quality).toContain('stuck-suspected')
    expect(sensor(p, 'imu', 515).healthy).toBe(false)
  })
  test('pressure repeats latch suspected stuck state until the raw measurement changes', () => {
    const p = pipeline(); p.ingest(bytes('barometer'), 30)
    const repeat = mutate(bytes('barometer'), (b, v) => { v.setUint32(4, 2, true); v.setBigUint64(16, 3000000n, true); v.setBigUint64(24, 3010000n, true) })
    p.ingest(repeat, 2030)
    expect(sensor(p, 'barometer', 2030).quality).toContain('stuck-suspected')
    const changed = mutate(repeat, (b, v) => { v.setUint32(4, 3, true); v.setBigUint64(16, 3100000n, true); v.setBigUint64(24, 3110000n, true); b[46] = b[46]! ^ 16 })
    p.ingest(changed, 2130)
    expect(sensor(p, 'barometer', 2130).healthy).toBe(true)
  })
  test('delayed, future, replayed and reversed frames fail closed', () => {
    for (const change of [
      (b: Uint8Array, v: DataView) => { v.setBigUint64(16, 900000n, true); v.setBigUint64(24, 900100n, true) },
      (b: Uint8Array, v: DataView) => { v.setBigUint64(16, 2000000n, true); v.setBigUint64(24, 2000100n, true) },
      (b: Uint8Array, v: DataView) => { v.setBigUint64(24, 1040000n, true) },
    ]) { const p = pipeline(); expect(p.ingest(mutate(bytes('imu'), change), 15).accepted).toBe(false) }
    const p = pipeline(); p.ingest(bytes('imu'), 15)
    expect(p.ingest(bytes('imu'), 16).accepted).toBe(false)
    expect(sensor(p, 'imu', 16).healthy).toBe(false)
  })
  test('bus failure clears measurements, bad boots and clock reversals require a new anchor', () => {
    const p = pipeline(); p.ingest(bytes('imu'), 15)
    const failure = mutate(bytes('imu'), (b, v) => { v.setUint32(4, 2, true); v.setBigUint64(16, 1001000n, true); v.setBigUint64(24, 1001100n, true); v.setUint32(32, 10, true) })
    expect(p.ingest(failure, 16)).toMatchObject({ accepted: false, reason: 'sensor-bus-error' })
    expect(sensor(p, 'imu', 16).observation).toBeNull()
    const changed = pipeline()
    expect(changed.ingest(mutate(bytes('imu'), (b, v) => v.setBigUint64(8, 22n, true)), 15).accepted).toBe(false)
    expect(changed.ingest(bytes('imu'), 16).accepted).toBe(false)
    const clock = pipeline(); clock.ingest(bytes('imu'), 15)
    expect(() => clock.snapshot(14)).toThrow('clock')
    expect(clock.ingest(bytes('imu'), 16).accepted).toBe(false)
  })
  test('unmeasured calibration and out-of-range temperature are visible quality states', () => {
    const raw = createSensorPipeline({ anchor }); raw.ingest(bytes('imu'), 15)
    expect(sensor(raw, 'imu', 15).quality).toContain('uncalibrated')
    const p = pipeline()
    expect(p.ingest(mutate(bytes('imu'), (b, v) => v.setInt16(44, 6000, false)), 15).accepted).toBe(true)
    expect(sensor(p, 'imu', 15).quality).toContain('temperature-outside-calibration')
    const original = dataset.calibrations.imu!.accelBias[0]
    const independent = pipeline(); dataset.calibrations.imu!.accelBias[0] = 100
    independent.ingest(bytes('imu'), 15)
    expect((sensor(independent, 'imu', 15).observation!.value as ImuMeasurement).specificForceMps2[0]).toBe(0)
    dataset.calibrations.imu!.accelBias[0] = original
  })
  test('qualified handshake bounds clock offset, uncertainty and anchor lifetime', () => {
    const status = { ...commandFrame('hello', 1, anchor.bootId, 77n), kind: 'status' as const, flags: 67, ticks: 1, stateBytes: 88, sampleTimeUs: anchor.boardUs }
    const result = sensorAnchorFromHandshake({ startedMs: 10, receivedMs: 12, sessionId: 77n, status })
    expect(result).toMatchObject({ localMs: 11, uncertaintyUs: 2500, source: 'handshake' })
    expect(() => sensorAnchorFromHandshake({ startedMs: 10, receivedMs: 32, sessionId: 77n, status })).toThrow()
    expect(() => sensorAnchorFromHandshake({ startedMs: 10, receivedMs: 12, sessionId: 78n, status })).toThrow()
    const p = pipeline(); p.ingest(bytes('imu'), 15)
    expect(sensor(p, 'imu', 5001).quality).toContain('clock-anchor-expired')
  })
  test('clock refresh retains age and stuck history, and rejects offset jumps', () => {
    const p = pipeline(); p.ingest(bytes('imu'), 15)
    p.reanchor({ ...anchor, boardUs: anchor.boardUs + 4000000n, localMs: 4000 }, 4000)
    expect(sensor(p, 'imu', 4000).quality).toContain('dropout-or-stale')
    expect(sensor(p, 'imu', 4000).observation!.timeUncertaintyUs).toBe(2800)
    const repeat = mutate(bytes('imu'), (b, v) => { v.setUint32(4, 2, true); v.setBigUint64(16, 7000000n, true); v.setBigUint64(24, 7000100n, true) })
    expect(p.ingest(repeat, 6015).accepted).toBe(true)
    expect(sensor(p, 'imu', 6015).quality).toContain('stuck-suspected')
    expect(() => p.reanchor({ ...anchor, boardUs: anchor.boardUs + 5000000n, localMs: 6100 }, 6100)).toThrow('disagrees')
    p.reanchor({ ...anchor, bootId: 33n, boardUs: 0n, localMs: 6200 }, 6200)
    expect(sensor(p, 'imu', 6200).observation).toBeNull()
  })
  test('unvalidated hardware timing cannot imply a bounded measurement age', () => {
    const p = pipeline()
    p.ingest(mutate(bytes('imu'), (b, v) => v.setUint32(32, 41, true)), 15)
    const result = sensor(p, 'imu', 15)
    expect(result.quality).toContain('timing-unvalidated')
    expect(result.observation!.measurementAgeUpperMs).toBeNull()
    expect(result.healthy).toBe(false)
  })
  test('a refresh preserves backwards mapping drift at the pressure age boundary', () => {
    const p = pipeline()
    p.ingest(mutate(bytes('barometer'), (b, v) => { v.setBigUint64(16, 1100000n, true); v.setBigUint64(24, 1110000n, true) }), 130)
    expect(sensor(p, 'barometer', 390).healthy).toBe(false)
    p.reanchor({ ...anchor, boardUs: 1390000n, localMs: 390 }, 390)
    const result = sensor(p, 'barometer', 390)
    expect(result.observation!.measurementAgeUpperMs).toBeCloseTo(300.058, 6)
    expect(result.healthy).toBe(false)
  })
  test('GNSS uses WGS84 heights and NED velocity while flagging unaligned measurement epochs', () => {
    const p = pipeline(); p.ingest(bytes('gnss'), first('gnss').receivedAtMs)
    const observation = sensor(p, 'gnss', 40).observation!
    const value = observation.value as GnssMeasurement
    expect(value).toMatchObject({ latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100, mslHeightM: 70, velocityNedMps: [1, 2, -0.5], positionVarianceNedM2: [2.25, 2.25, 6.25] })
    expect(observation.measurementAgeUpperMs).toBeNull()
    expect(observation.quality).toContain('measurement-epoch-unaligned')
    expect(observation.healthy).toBe(false)
  })
  test('GNSS fix quality and source epoch are checked separately from packet timestamps', () => {
    const invalid = pipeline(); expect(invalid.ingest(mutate(bytes('gnss'), b => { b[64] = 2 }), 30).accepted).toBe(false)
    const p = pipeline(); p.ingest(bytes('gnss'), 30)
    const repeat = mutate(bytes('gnss'), (b, v) => { v.setUint32(4, 2, true); v.setBigUint64(16, 2000000n, true); v.setBigUint64(24, 2009000n, true) })
    expect(p.ingest(repeat, 1030)).toMatchObject({ accepted: false, reason: 'gnss-epoch-stalled-or-reversed' })
    const rollover = pipeline()
    rollover.ingest(mutate(bytes('gnss'), (b, v) => v.setUint32(44, 604799000, true)), 30)
    const next = mutate(repeat, (b, v) => v.setUint32(44, 0, true))
    expect(rollover.ingest(next, 1030).accepted).toBe(true)
  })
})

let nativeDirectory: string
beforeAll(async () => { nativeDirectory = (await buildRuntime()).directory }, 20000)
describe('native capture and simulator replay', () => {
  test('the native C++ codec preserves independently encoded records byte-for-byte', async () => {
    const wire = Buffer.concat(['imu', 'barometer', 'gnss'].map(kind => Buffer.from(bytes(kind as SensorKind))))
    const child = Bun.spawn([join(nativeDirectory, 'drone_sensor_tests'), '--roundtrip'], { stdin: wire, stdout: 'pipe', stderr: 'pipe' })
    const output = new Uint8Array(await new Response(child.stdout).arrayBuffer())
    expect(await child.exited).toBe(0)
    expect(output).toEqual(new Uint8Array(wire))
  })
  test('replay supplies the same typed stream to the existing simulation clock', () => {
    const replay = createSensorReplay(fixture), sim = createSimulator({ sensorReplay: createSensorReplay(fixture) })
    sim.command('start')
    for (let i = 1; i <= 5; i++) {
      const snapshot = sim.step(200)
      expect(snapshot.sensors).toEqual(replay.advanceTo(i * 200))
      expect(snapshot.decision.kind).toBe('velocity')
      expect(snapshot.sensors!.physicalFlightEnabled).toBe(false)
    }
    const paused = sim.snapshot().sensors
    sim.command('pause'); sim.step(200)
    expect(sim.snapshot().sensors).toEqual(paused)
  })
  test('recorded clock refreshes support longer captures and EOF remains stale', () => {
    const row = mutate(bytes('imu'), (b, v) => { v.setBigUint64(16, 7000000n, true); v.setBigUint64(24, 7000100n, true) })
    const extended = { ...fixture, anchors: [{ receivedAtMs: 4000, anchor: { ...fixture.anchor, boardUs: String(anchor.boardUs + 4000000n), localMs: 4000 } }], records: [{ receivedAtMs: 6015, hex: row.toHex() }] }
    const replay = createSensorReplay(extended)
    expect(replay.advanceTo(6015).accepted).toBe(1)
    const sim = createSimulator({ sensorReplay: createSensorReplay(fixture) }); sim.command('start')
    for (let i = 0; i < 601; i++) sim.step(1000)
    expect(sim.snapshot().sensors!.nowMs).toBe(601000)
    expect(sim.snapshot().sensors!.sensors.every(s => !s.healthy)).toBe(true)
    expect(() => createSensorReplay({ ...extended, anchors: [{ ...extended.anchors[0], anchor: { ...extended.anchors[0]!.anchor, localMs: 3000 } }] })).toThrow()
  })
  test('recorded wire inspection resynchronizes without granting a live clock anchor', () => {
    const status = encodeRuntimeFrame({ ...commandFrame('hello', 1, anchor.bootId, 77n), kind: 'status', flags: 67 })
    const data = Buffer.concat([Buffer.from([255, 1, 2]), Buffer.from(bytes('imu')), Buffer.from(status), Buffer.from(bytes('imu').with(124, 0)), Buffer.from(bytes('barometer')), Buffer.from(bytes('gnss')), Buffer.from([1, 2])])
    expect(inspectSensorCapture(data)).toMatchObject({ evidence: 'recorded-unanchored-wire', counts: { imu: 1, barometer: 1, gnss: 1 }, discardedBytes: 133, physicalFlightEnabled: false })
    expect(() => inspectSensorCapture(new Uint8Array(1048577))).toThrow('1 MiB')
  })
  test('datasets reject out-of-order receipts, forged evidence categories and oversized input', () => {
    const bad = structuredClone(fixture); bad.records[1]!.receivedAtMs = -1
    expect(() => createSensorReplay(bad)).toThrow()
    expect(() => createSensorReplay({ ...fixture, evidence: 'bench-capture' })).toThrow('clock source')
    expect(() => createSensorReplay({ ...fixture, records: Array.from({ length: 4097 }, () => fixture.records[0]) })).toThrow('bounded')
    const replay = createSensorReplay(fixture); replay.advanceTo(100)
    expect(() => replay.advanceTo(99)).toThrow()
  })
  test('native Stacks command runs the replay and reports invalid CLI values', async () => {
    const result = await command(['sensors:replay', 'tests/fixtures/sensors/bench-v1.json', '--at-ms', '500']).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).evidence).toBe('synthetic-register-fixture')
    const invalid = await command(['sensors:replay', 'tests/fixtures/sensors/bench-v1.json', '--at-ms', 'nan']).withTimeout(60000)
    expect(invalid.exitCode).toBe(1)
  }, 180000)
})
