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
    (c: VehicleControllerContext) => { c.measurementPose!.capturedAtMs++ },
    (c: VehicleControllerContext) => { c.measurementPose!.positionM[0] += 0.3 },
    (c: VehicleControllerContext) => { c.estimate.localPosition!.capturedAtMs = 1 },
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
