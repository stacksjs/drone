import { expect, test } from 'bun:test'
import type { VehicleControllerContext, VehiclePayloadCommand } from '../../resources/functions/drone/vehicles/types'
import { surfacePayloadContext } from '../fixtures/surface/context'
import { createSubseaCapture } from '../../resources/functions/drone/vehicles/subsea/payload'

function captureContext(command: VehiclePayloadCommand, nowMs = command.issuedAtMs): VehicleControllerContext {
  const c = surfacePayloadContext(command, nowMs)
  c.mission.vehicle = 'subsea'
  c.estimate.localPosition!.altitudeDatum = 'LOCAL_WATER_SURFACE'
  c.estimate.localPosition!.positionM = [2, 0, 2]
  const capturedAtMs = nowMs - 60
  c.measurement = { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'subsea', sequence: capturedAtMs / 20, reference: command.reference, capturedAtMs, receivedAtMs: nowMs, values: { onSurface: false, stopped: true, calibration: 'subsea-dvl-pressure-v1', clockSigmaMs: 1, pressurePa: 121435.5, surfacePressurePa: 101325, waterDensityKgM3: 1025, dvlVelocityBodyMps: [0, 0, 0], angularRateBodyRadS: [0, 0, 0], dvlLocked: true, leak: false, tetherLengthM: 4, tetherTensionN: 2, linkConnected: true, emergency: false, bottomRangeM: 8, structureRangeM: 2, cameraLuma: Array.from({ length: 16 }, (_, i) => i * 16), cameraFrameId: `subsea-model-${capturedAtMs / 20}-${capturedAtMs}` } }
  c.measurementPose = { capturedAtMs, reference: command.reference, positionM: [2, 0, 2], quaternionWxyz: [1, 0, 0, 0], positionCapturedAtMs: capturedAtMs - 60, positionPredictedToMs: capturedAtMs, attitudeCapturedAtMs: capturedAtMs, attitudePredictedToMs: capturedAtMs, gyroCapturedAtMs: capturedAtMs, attitudePrediction: 'qualified-gyro-hold' }
  return c
}
const command: VehiclePayloadCommand = { eventId: 'inspection-event', taskId: 'capture', operation: 'inspection-capture', containerId: null, issuedAtMs: 1000, expiresAtMs: 2000, positionM: [2, 0, 2], reference: '1:0,0,0,0,0' }

test('inspection waits for a new qualified camera and sonar capture and acknowledges its owned capture epoch', () => {
  const port = createSubseaCapture()
  port.observe!(captureContext(command)); port.request(command)
  expect(port.poll(1000)).toBeNull()
  port.observe!(captureContext(command, 1040)); expect(port.poll(1040)).toBeNull()
  const c = captureContext(command, 1060)
  port.observe!(c); c.measurement!.values.cameraFrameId = 'changed-after-observe'
  const ack = port.poll(1060)!
  expect(ack.outcome).toBe('confirmed'); expect(ack.capturedAtMs).toBe(1000)
  expect(ack.positionM).toEqual([2, 0, 2]); expect(ack.metadata!.cameraFrameId).toBe('subsea-model-50-1000')
  expect(ack.metadata!.physicalImageVerified).toBe(false)
  expect(port.poll(1080)).toBeNull()
  expect(() => port.request(command)).toThrow()
  port.close()
})

test('inspection latches intervening authority and command-scope loss, and rejects captures outside the owned pose envelope', () => {
  const changes: ((c: VehicleControllerContext) => void)[] = [
    c => { c.enabled = false }, c => { c.mission.state = 'aborted' }, c => { c.mission.state = 'paused' }, c => { c.mission.payload = null }, c => { c.mission.taskId = 'other' }, c => { c.mission.taskKind = 'waypoint' },
    c => { c.mission.payload!.eventId = 'other' }, c => { c.mission.payload!.taskId = 'other' }, c => { c.mission.payload!.operation = 'camera-still' }, c => { c.mission.payload!.containerId = 'other' }, c => { c.mission.payload!.reference = '2:0,0,0,0,0' }, c => { c.mission.payload!.issuedAtMs++ }, c => { c.mission.payload!.expiresAtMs++ }, c => { c.mission.payload!.positionM[0]++ },
  ]
  for (const change of changes) {
    const port = createSubseaCapture()
    port.observe!(captureContext(command)); port.request(command)
    const bad = captureContext(command, 1020); change(bad); port.observe!(bad)
    port.observe!(captureContext(command, 1060))
    expect(port.poll(1060)!.outcome).toBe('uncertain')
    expect(() => port.request(command)).toThrow()
  }
  for (const change of [
    (c: VehicleControllerContext) => { c.measurementPose = null },
    (c: VehicleControllerContext) => { c.measurementPose!.positionM[0] = NaN },
    (c: VehicleControllerContext) => { c.measurementPose!.quaternionWxyz = [1, 1, 1, 1] },
    (c: VehicleControllerContext) => { c.measurementPose!.capturedAtMs++ },
    (c: VehicleControllerContext) => { c.measurementPose!.positionM[0] += 0.3 },
    (c: VehicleControllerContext) => { c.estimate.localPosition!.capturedAtMs = 1 },
    (c: VehicleControllerContext) => { c.estimate.localPosition!.positionM[0] = Infinity },
    (c: VehicleControllerContext) => { c.estimate.localPosition!.velocityMps[0] = NaN },
    (c: VehicleControllerContext) => { c.estimate.localPosition!.positionM = [1, 2] as unknown as [number, number, number] },
    (c: VehicleControllerContext) => { c.measurement!.values.leak = true },
    (c: VehicleControllerContext) => { c.measurement!.values.linkConnected = false },
    (c: VehicleControllerContext) => { c.measurement!.values.tetherTensionN = 40 },
    (c: VehicleControllerContext) => { c.measurement!.values.dvlLocked = false },
    (c: VehicleControllerContext) => { c.measurement!.values.cameraLuma = [1] },
  ]) {
    const port = createSubseaCapture(); port.observe!(captureContext(command)); port.request(command)
    const bad = captureContext(command, 1060); change(bad); port.observe!(bad)
    expect(port.poll(1060)!.outcome).toBe('uncertain')
  }
})

import { createVehicleMissionEngine } from '../../resources/functions/drone/missions/vehicle'
import { reduceSubseaInspection } from '../../resources/functions/drone/vehicles/subsea/inspection'
import type { VehicleMissionObservation, VehicleMissionPlan } from '../../resources/functions/drone/vehicles/types'
function inspectionRecording() {
  const move = { acceptanceM: 0.2, maxArrivalSpeedMps: 0.12, settleMs: 0, timeoutMs: 1000 }
  const plan: VehicleMissionPlan = { version: 2, vehicle: 'subsea', id: 'inspection-fixture', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 8, minDownM: -0.1, maxDownM: 8 }, rallyM: [0, 0, 0], power: { availableWh: 10, maxW: 100, reservePercent: 30 }, start: 'start', tasks: [
    { id: 'start', kind: 'start', next: 'dive' }, { id: 'dive', kind: 'waypoint', positionM: [2, 0, 2], ...move, next: 'capture' }, { id: 'capture', kind: 'payload', operation: 'inspection-capture', containerId: null, timeoutMs: 1000, next: 'return' }, { id: 'return', kind: 'return', ...move, next: 'stop' }, { id: 'stop', kind: 'stop', positionM: [0, 0, 0], ...move },
  ] }
  const engine = createVehicleMissionEngine(plan), port = createSubseaCapture()
  const observation = (atMs: number): VehicleMissionObservation => ({ kind: 'simulation', nowMs: atMs, reference: command.reference, origin: plan.origin, healthy: true, positionM: atMs === 1000 ? [0, 0, 0] : [2, 0, 2], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 100, onGround: atMs === 1000, payloadAck: null })
  engine.step(observation(1000), 'start'); engine.step(observation(1020)); const pending = engine.step(observation(1040)).payload!
  port.observe!(captureContext(pending, 1040)); port.request(pending)
  engine.step(observation(1060)); engine.step(observation(1080))
  const c = captureContext(pending, 1100); port.observe!(c)
  engine.step({ ...observation(1100), payloadAck: port.poll(1100) })
  return { trace: engine.trace(), path: [{ atMs: 1100, measurement: c.measurement, measurementPose: c.measurementPose! }] }
}

test('inspection evidence joins exact acknowledged camera pixels, sonar and capture pose without global location claims', () => {
  const recording = inspectionRecording()
  const artifact = reduceSubseaInspection(recording.path, recording.trace)
  expect(artifact.physicalValidation).toBe(false); expect(artifact.frames).toHaveLength(1)
  const capture = artifact.frames[0]!
  expect(capture.capturedAtMs).toBe(1040); expect(capture.positionM).toEqual([2, 0, 2])
  expect(capture.camera.pixels).toEqual([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240])
  expect(new TextDecoder().decode(new Uint8Array(capture.camera.bytes.slice(0, 11)))).toBe('P5\n4 4\n255\n')
  expect(capture.camera.bytes).toHaveLength(27); expect(capture.sonar.rangeM).toBe(2)
  expect(capture.pose.positionCapturedAtMs).toBe(980); expect(capture.pose.attitudePredictedToMs).toBe(1040)
  recording.path[0]!.measurement!.values.cameraLuma = [1]
  expect(capture.camera.pixels).toHaveLength(16)
})

test('inspection export rejects unacknowledged, relabeled or conflicting capture records and understated clock assumptions', () => {
  for (const change of [
    (r: ReturnType<typeof inspectionRecording>) => { r.path[0]!.measurement!.values.cameraFrameId = 'subsea-model-99-1040' },
    (r: ReturnType<typeof inspectionRecording>) => { r.path[0]!.measurement!.values.structureRangeM = 3 },
    (r: ReturnType<typeof inspectionRecording>) => { (r.path[0]!.measurement!.values.cameraLuma as number[])[0] = 255 },
    (r: ReturnType<typeof inspectionRecording>) => { r.path[0]!.measurementPose!.quaternionWxyz = [0, 0, 0, 1] },
    (r: ReturnType<typeof inspectionRecording>) => { r.path[0]!.measurementPose!.positionM[0] += 0.1 },
    (r: ReturnType<typeof inspectionRecording>) => { r.path[0]!.measurementPose!.attitudeCapturedAtMs = 1 },
    (r: ReturnType<typeof inspectionRecording>) => { r.trace.rows.at(-1)!.observation.payloadAck!.capturedAtMs++ },
    (r: ReturnType<typeof inspectionRecording>) => { r.path = [] },
    (r: ReturnType<typeof inspectionRecording>) => { r.path.push(structuredClone(r.path[0]!)); r.path[1]!.measurement!.values.cameraLuma = Array(16).fill(42) },
  ]) {
    const recording = inspectionRecording(); change(recording)
    expect(() => reduceSubseaInspection(recording.path, recording.trace)).toThrow()
  }
  const r = inspectionRecording()
  expect(() => reduceSubseaInspection(r.path, r.trace, { positionSigmaM: 0.1, attitudeSigmaRad: 0.02, timeSigmaMs: 0.5, rangeSigmaM: 0.05 })).toThrow()
})
