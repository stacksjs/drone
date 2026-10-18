import { expect, test } from 'bun:test'
import { createPayloadPoseTimeline } from '../../resources/functions/drone/payloads/pose'
import { observation } from '../fixtures/authority/context'

test('capture metadata selects a nearby qualified estimator pose rather than the later ACK receipt time', () => {
  const timeline = createPayloadPoseTimeline()
  for (const at of [1000, 1020, 1040]) { const e = observation(at).estimate; e.localPosition!.positionM[0] = at / 100; timeline.record(e, at) }
  const result = timeline.associate({ capturedAtMs: 1022, clockUncertaintyMs: 1, evidence: 'fixture' }, timeline.snapshot().revision)
  expect(result.status).toBe('associated')
  expect(result.pose!.positionM[0]).toBe(10.2)
  expect(result.pose!.snapshotAtMs).toBe(1020)
  expect(result.offsetMs).toBe(-2)
  expect(result.georeferenced).toBe(false)
})

import type { CameraPayloadAdapter, PayloadBusContract, PayloadCaptureAck } from '../../resources/functions/drone/payloads/types'
import { createPayloadCaptureSession, jpegDimensions } from '../../resources/functions/drone/payloads/capture'
import { createReplayCameraPayload, payloadFixtureJpeg } from '../../resources/functions/drone/payloads/replay'
import { openCameraPayloadProcess } from '../../resources/functions/drone/payloads/process'
import { validatePayloadBus, payloadInventory } from '../../resources/functions/drone/payloads/catalog'
import { runPayloadBench, payloadJson } from '../../resources/functions/drone/payloads/bench'
import { savePayloadCapture } from '../../resources/functions/drone/payloads/artifact'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

function rig(fault: 'none' | 'lost-ack' | 'wrong-identity' | 'stale-clock' = 'none') {
  let time = 1000, triggers = 0
  const poses = createPayloadPoseTimeline()
  poses.record(observation(time).estimate, time)
  const adapter = createReplayCameraPayload({ now: () => time, captureAt: () => 1020, fault, onTrigger() { triggers++; time = 1040; poses.record(observation(1020).estimate, 1040) } })
  return { poses, adapter, session: createPayloadCaptureSession({ adapter, poses, now: () => time }), triggers: () => triggers }
}

test('owned sensor and estimator bench associates the exposure, retains epochs and rejects each failure exactly once', async () => {
  const normal = await runPayloadBench()
  expect(normal.capture!.association.pose!.snapshotAtMs).toBe(620)
  expect(normal.capture!.association.pose!.positionMeasurementAtMs).toBe(600)
  expect(normal.capture!.sensorTimingCalibrated).toBe(false)
  expect(normal.capture!.physicalFlightEnabled).toBe(false)
  for (const scenario of ['wrong-identity', 'stale-clock', 'lost-ack', 'pose-reset'] as const) {
    const result = await runPayloadBench(scenario)
    expect(result.outcome).toBe('rejected'); expect(result.triggers).toBe(1); expect(result.capture).toBeNull()
  }
  await expect(runPayloadBench('other' as never)).rejects.toThrow('Unknown payload scenario')
}, 15000)

test('pose reference reset, evidence change, unhealthy input and duplicate time invalidate in-flight association', () => {
  for (const change of ['boot', 'reset', 'origin', 'evidence', 'health', 'duplicate'] as const) {
    const poses = createPayloadPoseTimeline(), first = observation(1000).estimate
    expect(poses.record(first, 1000)).toBe(true)
    const revision = poses.snapshot().revision, next = observation(1020).estimate
    if (change === 'boot') next.bootId = 56n
    if (change === 'reset') next.resets.position++
    if (change === 'origin') next.localPosition!.origin!.ellipsoidHeightM++
    if (change === 'evidence') next.evidence = 'handshake'
    if (change === 'health') next.health.tilt = false
    if (change === 'duplicate') next.nowMs = 1000
    poses.record(next, 1020)
    expect(poses.associate({ capturedAtMs: 1020, clockUncertaintyMs: 0, evidence: 'fixture' }, revision).status).toBe('unavailable')
  }
})

test('pose timeline copies values, bounds memory and refuses stale or unqualified component times', () => {
  const poses = createPayloadPoseTimeline(), e = observation(1000).estimate
  poses.record(e, 1000); e.localPosition!.positionM[0] = 999
  const associate = (at: number, uncertainty = 0, evidence: 'fixture' | 'hardware' = 'fixture') => poses.associate({ capturedAtMs: at, clockUncertaintyMs: uncertainty, evidence }, poses.snapshot().revision)
  expect(associate(1000).pose!.positionM[0]).toBe(0)
  associate(1000).pose!.positionM[0] = 123
  expect(associate(1000).pose!.positionM[0]).toBe(0)
  expect(associate(1040, 1).status).toBe('unavailable')
  expect(associate(1000, 0, 'hardware').status).toBe('unavailable')
  for (let t = 1020; t <= 7000; t += 20) poses.record(observation(t).estimate, t)
  expect(poses.snapshot().samples).toBe(128)
  expect(associate(1000).status).toBe('unavailable')
  const stale = observation(7020).estimate; stale.attitude!.capturedAtMs = 6900
  expect(poses.record(stale, 7020)).toBe(false)
  expect(poses.snapshot().samples).toBe(0)
  expect(poses.record(observation(7000).estimate, 6999)).toBe(false)
})

test('real pose association requires handshake evidence and still never claims georeferencing', () => {
  const poses = createPayloadPoseTimeline(), e = observation(1000).estimate
  e.evidence = 'handshake'; poses.record(e, 1000)
  const association = poses.associate({ capturedAtMs: 1000, clockUncertaintyMs: 2, evidence: 'hardware' }, poses.snapshot().revision)
  expect(association.status).toBe('associated'); expect(association.georeferenced).toBe(false)
})

test('optional pose is explicitly unavailable while requirePose retires an already triggered capture', async () => {
  const a = rig(); a.poses.clear()
  // Invalidate again while the adapter is pending, after its onTrigger records a pose.
  const original = a.adapter.capture
  a.adapter.capture = async (...args) => { const ack = await original(...args); a.poses.clear(); return ack }
  expect((await a.session.capture()).association.status).toBe('unavailable'); a.session.close()
  const b = rig(), originalB = b.adapter.capture
  b.adapter.capture = async (...args) => { const ack = await originalB(...args); b.poses.clear(); return ack }
  await expect(b.session.capture({ requirePose: true })).rejects.toThrow('no qualified pose')
  await expect(b.session.capture()).rejects.toThrow('closed')
})

test('capture admission snapshots a required pose before awaiting the camera', async () => {
  const r = rig(), original = r.adapter.capture
  r.adapter.capture = async (...args) => { const ack = await original(...args); r.poses.clear(); return ack }
  const options = { requirePose: true }, capture = r.session.capture(options)
  options.requirePose = false
  await expect(capture).rejects.toThrow('no qualified pose')
  expect(r.triggers()).toBe(1)
})

test('cancellation, close, one-pending limit and timeout never retry an ambiguous shutter', async () => {
  const a = rig('lost-ack'), controller = new AbortController(), first = a.session.capture({ signal: controller.signal })
  await expect(a.session.capture()).rejects.toThrow('Only one')
  controller.abort(); await expect(first).rejects.toThrow('cancelled')
  await expect(a.session.capture()).rejects.toThrow('closed'); expect(a.triggers()).toBe(1)
  const b = rig('lost-ack'), second = b.session.capture(); b.session.close()
  await expect(second).rejects.toThrow('closed'); expect(b.triggers()).toBe(1)
  const c = rig('lost-ack'); await expect(c.session.capture()).rejects.toThrow('timed out'); expect(c.triggers()).toBe(1)
  const d = rig(), cancelled = new AbortController(); cancelled.abort()
  await expect(d.session.capture({ signal: cancelled.signal })).rejects.toThrow('before trigger'); expect(d.triggers()).toBe(0); d.session.close()
}, 10000)

test('untrusted ACK timing, identity, image and metadata fail closed', async () => {
  const mutations: ((ack: PayloadCaptureAck) => void)[] = [
    a => { a.sequence++ }, a => { a.sessionId = 'other' }, a => { a.deviceId = 'other' }, a => { a.evidence = 'hardware' },
    a => { a.capturedAtMs = 999 }, a => { a.acknowledgedAtMs = 1041 }, a => { a.clockUncertaintyMs = 6 }, a => { a.exposureTimeUs = NaN },
    a => { a.width++ }, a => { a.jpeg = new Uint8Array(524289) }, a => { a.jpeg[0] = 0 }, a => { a.jpeg = undefined as never },
  ]
  for (const mutate of mutations) {
    const r = rig(), original = r.adapter.capture
    r.adapter.capture = async (...args) => { const ack = await original(...args); mutate(ack); return ack }
    await expect(r.session.capture()).rejects.toThrow()
    await expect(r.session.capture()).rejects.toThrow('closed'); expect(r.triggers()).toBe(1)
  }
  expect(jpegDimensions(payloadFixtureJpeg())).toEqual({ width: 8, height: 8 })
  expect(() => jpegDimensions(new Uint8Array(30))).toThrow('JPEG')
})

test('malformed capabilities are closed before issuing any trigger', () => {
  const r = rig(), descriptor = r.adapter.describe()
  const adapter: CameraPayloadAdapter = { ...r.adapter, describe: () => ({ ...descriptor, maxImageBytes: Infinity }) }
  expect(() => createPayloadCaptureSession({ adapter, poses: r.poses })).toThrow('descriptor')
  expect(r.triggers()).toBe(0)
})

const worker = resolve(import.meta.dir, '../fixtures/payloads/worker.ts')
const openPeer = (fault = 'none') => openCameraPayloadProcess({ command: [process.execPath, worker, fault], evidence: 'fixture' })
test('bounded child IPC handles fragmented records and maps the child monotonic clock', async () => {
  const adapter = await openPeer(), session = createPayloadCaptureSession({ adapter, poses: createPayloadPoseTimeline() })
  try {
    const capture = await session.capture()
    expect(capture.camera.evidence).toBe('fixture')
    expect(capture.capturedAtMs).toBeGreaterThanOrEqual(capture.command.issuedAtMs)
    expect(capture.receivedAtMs).toBeGreaterThan(capture.capturedAtMs)
    expect(capture.byteLength).toBe(137)
    expect(capture.association.status).toBe('unavailable')
    const again = await session.capture(); expect(again.command.sequence).toBe(2)
  }
  finally { session.close() }
}, 60000)

test('child disconnection, stale clocks and wrong-boot ACKs retire the process', async () => {
  for (const fault of ['exit', 'stale', 'wrong-boot', 'slow-sync']) {
    const adapter = await openPeer(fault), session = createPayloadCaptureSession({ adapter, poses: createPayloadPoseTimeline() })
    try { await expect(session.capture()).rejects.toThrow(); await expect(session.capture()).rejects.toThrow('closed') }
    finally { session.close() }
  }
  await expect(openPeer('oversize')).rejects.toThrow('budget')
}, 60000)

test('closing a child with a pending exposure rejects without waiting for its ACK', async () => {
  const adapter = await openPeer('lost-ack'), session = createPayloadCaptureSession({ adapter, poses: createPayloadPoseTimeline() })
  const capture = session.capture(); session.close()
  await expect(capture).rejects.toThrow('closed')
}, 60000)

test('bus contracts enforce finite single-request budgets and disabled-load actuator settings', () => {
  const common = { timeoutMs: 100, maxTransferBytes: 64, maxQueueDepth: 1 as const }
  const contracts: PayloadBusContract[] = [
    { ...common, kind: 'csi', model: 'IMX500', connector: 'CAM/DISP0' },
    { ...common, kind: 'spi', controller: 0, chipSelect: 0, mode: 0, clockHz: 1000000 },
    { ...common, kind: 'i2c', controller: 1, address7bit: 64, clockHz: 400000 },
    { ...common, kind: 'uart', device: '/dev/ttyAMA0', baud: 115200 },
    ...(['can', 'dronecan', 'cyphal'] as const).map(kind => ({ ...common, kind, interface: 'can0', bitrate: 1000000, nodeId: 1 })),
    { ...common, kind: 'gpio', chip: 0, line: 12, inactiveLevel: 0 },
    { ...common, kind: 'pwm', frequencyHz: 50, minPulseUs: 1000, maxPulseUs: 2000, neutralPulseUs: 1500 },
    { ...common, kind: 'dshot', rateKbps: 300, neutralCommand: 0 },
    { ...common, kind: 'power-monitor', transport: 'i2c', maxVoltageV: 60, maxCurrentA: 100, calibrationId: 'bench-v1' },
  ]
  for (const c of contracts) { expect(() => validatePayloadBus(c)).not.toThrow(); expect(() => validatePayloadBus({ ...c, timeoutMs: Infinity })).toThrow(); expect(() => validatePayloadBus({ ...c, maxQueueDepth: 2 } as never)).toThrow() }
  expect(() => validatePayloadBus({ ...common, kind: 'pwm', frequencyHz: 1000, minPulseUs: 1000, maxPulseUs: 2000, neutralPulseUs: 500 })).toThrow()
  expect(() => validatePayloadBus({ ...common, kind: 'i2c', controller: 1, address7bit: 0, clockHz: 400000 })).toThrow()
  expect(payloadInventory.filter(c => c.implementation !== 'deferred').map(c => c.family)).toEqual(['pi-ai-camera'])
})

test('artifact pairs preserve the hash and exact boot ID and never overwrite a directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-payload-'))
  try {
    const capture = (await runPayloadBench()).capture!, target = join(directory, 'new-capture')
    const files = await savePayloadCapture(capture, target), manifest = JSON.parse(await readFile(files.manifest, 'utf8'))
    expect(manifest.jpeg).toBeUndefined(); expect(manifest.association.pose.bootId).toBe('55'); expect(manifest.sha256).toBe(capture.sha256)
    expect(new Uint8Array(await readFile(files.image))).toEqual(capture.jpeg)
    await expect(savePayloadCapture(capture, target)).rejects.toThrow('EEXIST')
    await expect(savePayloadCapture({ ...capture, sha256: 'wrong' }, join(directory, 'invalid'))).rejects.toThrow('disagree')
    expect(payloadJson({ bootId: 18446744073709551615n })).toContain('18446744073709551615')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})

import { command as cliCommand } from '@stacksjs/testing'
test('native Stacks payload commands discover the adapter bench and export acknowledged artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'drone-payload-cli-'))
  try {
    const result = await cliCommand(['payloads:bench']).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).capture.association.pose.snapshotAtMs).toBe(620)
    const exported = await cliCommand(['payloads:capture', '--output', join(directory, 'capture')]).withTimeout(60000)
    expect(exported.exitCode).toBe(0)
    expect(JSON.parse(await readFile(join(directory, 'capture/capture.json'), 'utf8')).camera.evidence).toBe('fixture')
    expect((await cliCommand(['payloads:capture', '--driver', 'other', '--output', join(directory, 'invalid')]).withTimeout(60000)).exitCode).toBe(1)
    expect((await cliCommand(['payloads:bench', '--scenario', 'other']).withTimeout(60000)).exitCode).toBe(1)
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 240000)


test('camera startup silence expires and an ignored SIGTERM is escalated after cancelling an active capture', async () => {
  await expect(openPeer('no-hello')).rejects.toThrow('startup timed out')
  const directory = await mkdtemp(join(tmpdir(), 'drone-payload-kill-')), marker = join(directory, 'phase.json')
  // Clock qualification has its own real-clock test; isolate cancellation and escalation here.
  const now = () => 1000
  const adapter = await openCameraPayloadProcess({ command: [process.execPath, worker, 'ignore-term', marker], evidence: 'fixture', now })
  const session = createPayloadCaptureSession({ adapter, poses: createPayloadPoseTimeline(), now }), controller = new AbortController()
  try {
    const capture = session.capture({ signal: controller.signal }).then(() => null, error => error as Error)
    const until = performance.now() + 1500
    while (!await Bun.file(marker).exists() && performance.now() < until) await Bun.sleep(5)
    if (!await Bun.file(marker).exists()) throw new Error(`Capture phase was not reached: ${(await capture)?.message}`)
    const phase = JSON.parse(await readFile(marker, 'utf8')) as { pid: number, phase: string }
    expect(phase.phase).toBe('capture')
    controller.abort()
    expect((await capture)?.message).toContain('cancelled')
    const alive = () => { try { process.kill(phase.pid, 0); return true } catch { return false } }
    const killUntil = performance.now() + 3000
    while (alive() && performance.now() < killUntil) await Bun.sleep(10)
    expect(alive()).toBe(false)
  }
  finally { session.close(); await rm(directory, { recursive: true, force: true }) }
}, 60000)
