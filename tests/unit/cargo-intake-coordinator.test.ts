import { expect, test } from 'bun:test'
import type { SensorVector } from '../../resources/functions/drone/sensors/types'
import type { VehicleControllerContext, VehiclePayloadCommand } from '../../resources/functions/drone/vehicles/types'
import { vehicleReference } from '../../resources/functions/drone/vehicles/measurements'
import { observation } from '../fixtures/authority/context'
import { createCargoIntakeCoordinator } from '../../resources/functions/drone/cargo/intake'

const declaration = () => ({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, padM: [3, 2, -.1], receiverId: 'carrier-b', containerId: 'parcel-a', massKg: .1, bootId: 102n, sessionId: 202n })

test('modeled intake captures its declaration and rejects mechanism accessors before invoking them', () => {
  let invoked = 0
  const unsafe = { evidence: 'modeled-cargo-intake-mechanism' as const, get request() { invoked++; return () => {} }, cancel() {} }
  expect(() => createCargoIntakeCoordinator(declaration(), unsafe)).toThrow('cargo-intake-mechanism')
  expect(invoked).toBe(0)
  const input = declaration(), adapter = { evidence: 'modeled-cargo-intake-mechanism' as const, request() {}, cancel() {} }
  const coordinator = createCargoIntakeCoordinator(input, adapter), first = coordinator.snapshot()
  input.massKg = .2; input.padM[0] = 8
  const detached = coordinator.snapshot(); detached.declaration.padM[0] = 77
  expect(coordinator.snapshot()).toEqual(first)
  expect(first.physicalFlightEnabled).toBe(false)
  expect(first.identityAuthenticated).toBe(false)
  expect(first.custody.outcome).toBe('not-requested')
  coordinator.port.close(); coordinator.port.close()
})

// Public observed-input policy seam. Declared transport captures exercise receipt
// admission; actual acquisition, bodies and mechanical authority use fleet tests.
function context(nowMs: number, sequence: number, payload: VehiclePayloadCommand | null = null): VehicleControllerContext {
  const estimate = observation(nowMs).estimate
  estimate.bootId = 102n
  estimate.localPosition!.origin = declaration().origin
  estimate.localPosition!.positionM = [3, 2, -.1]
  estimate.localPosition!.covarianceBlocks = [0, 1, 2].map(() => ({ positionM2: .0001, positionVelocityM2S: 0, velocityM2S2: .0001 }))
  const reference = vehicleReference(estimate), capturedAtMs = nowMs - 40
  return { nowMs, enabled: true, estimate,
    measurement: { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'quadcopter', sequence, reference, capturedAtMs, receivedAtMs: nowMs,
      values: { onSurface: true, stopped: true, receiverId: 'carrier-b', siteClear: true, loadAttached: false, stationReady: true, stationContainerId: 'parcel-a', stationSourceEventId: 'source-delivery:release', intakeEventId: '' } },
    measurementPose: { capturedAtMs, reference, positionM: [3, 2, -.1], quaternionWxyz: [1, 0, 0, 0], positionCapturedAtMs: capturedAtMs, positionPredictedToMs: capturedAtMs, attitudeCapturedAtMs: capturedAtMs, attitudePredictedToMs: capturedAtMs, gyroCapturedAtMs: capturedAtMs, attitudePrediction: 'qualified-gyro-hold' },
    controlRate: { evidence: 'modeled-qualified-imu', capturedAtMs: nowMs, reference, angularRateRadS: [0, 0, 0] },
    mission: { version: 2, vehicle: 'quadcopter', evidence: 'owned-vehicle-mission-simulation', physicalFlightEnabled: false, state: 'running', taskId: 'intake', taskKind: 'payload', targetM: [3, 2, -.1], payload, reason: 'task-entered', elapsedMs: 0 } }
}
function command(): VehiclePayloadCommand {
  return { eventId: 'receiving:intake', taskId: 'intake', operation: 'material-receive', containerId: 'parcel-a', issuedAtMs: 1000, expiresAtMs: 5000, positionM: [3, 2, -.1], reference: vehicleReference(context(1000, 1).estimate) }
}
function ready(coordinator: ReturnType<typeof createCargoIntakeCoordinator>) {
  const request = command()
  coordinator.port.observe!(context(1000, 1, request)); coordinator.port.request(request)
  for (let i = 1; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1, request))
  expect(coordinator.snapshot().readiness.captures).toBe(26)
  expect(coordinator.port.poll(1500)).toBeNull()
  expect(coordinator.snapshot().grant).not.toBeNull()
  return request
}
function attached(request: VehiclePayloadCommand, positionM: SensorVector = [3, 2, -.1]) {
  const c = context(1560, 27, request)
  c.measurementPose!.positionM = positionM
  Object.assign(c.measurement!.values, { intakeEventId: request.eventId, intakeSourceEventId: 'source-delivery:release', intakeAtMs: 1504, intakeOutcome: 'attached', loadAttached: true, intakeMassKg: .1 })
  return c
}

test('captured attached receipt cannot commit custody with an out-of-bound or distant ACK position', () => {
  for (const position of [[2000000, 2, -.1], [4.01, 2, -.1]] as SensorVector[]) {
    const coordinator = createCargoIntakeCoordinator(declaration(), { evidence: 'modeled-cargo-intake-mechanism', request() {}, cancel() {} })
    const request = ready(coordinator)
    coordinator.port.observe!(attached(request, position))
    expect(coordinator.port.poll(1560)).toBeNull()
    expect(coordinator.snapshot().custody).toMatchObject({ outcome: 'uncertain', receiptCapturedAtMs: null, acknowledgedAtMs: null })
    coordinator.port.close()
  }
})

test('ordinary capture pose commits a correlated receipt exactly once after the intake event', () => {
  const coordinator = createCargoIntakeCoordinator(declaration(), { evidence: 'modeled-cargo-intake-mechanism', request() {}, cancel() {} })
  const request = ready(coordinator)
  coordinator.port.observe!(attached(request))
  expect(coordinator.port.poll(1560)).toMatchObject({ eventId: request.eventId, outcome: 'confirmed', capturedAtMs: 1520, positionM: [3, 2, -.1] })
  expect(coordinator.snapshot().custody).toMatchObject({ outcome: 'received', mechanismAtMs: 1504, receiptCapturedAtMs: 1520, acknowledgedAtMs: 1560 })
  expect(coordinator.port.poll(1560)).toBeNull()
  coordinator.port.close()
})

test('nonfinite or negative navigation source epochs cannot accumulate readiness or issue an intake grant', () => {
  for (const capturedAtMs of [NaN, Infinity, -Infinity, -1]) {
    const sent: unknown[] = []
    const coordinator = createCargoIntakeCoordinator(declaration(), { evidence: 'modeled-cargo-intake-mechanism', request: value => { sent.push(value) }, cancel() {} })
    const request = command()
    for (let i = 0; i <= 25; i++) {
      const c = context(1000 + i * 20, i + 1, request)
      c.estimate.localPosition!.capturedAtMs = capturedAtMs
      coordinator.port.observe!(c)
      if (i === 0) coordinator.port.request(request)
    }
    expect(coordinator.port.poll(1500)).toBeNull()
    expect(coordinator.snapshot().readiness.captures).toBe(0)
    expect(coordinator.snapshot().grant).toBeNull()
    expect(sent).toEqual([])
    coordinator.port.close()
  }
})

test('valid fractional navigation capture epochs still permit the observed readiness window', () => {
  const sent: unknown[] = []
  const coordinator = createCargoIntakeCoordinator(declaration(), { evidence: 'modeled-cargo-intake-mechanism', request: value => { sent.push(value) }, cancel() {} })
  const request = command()
  for (let i = 0; i <= 25; i++) {
    const c = context(1000 + i * 20, i + 1, request)
    c.estimate.localPosition!.capturedAtMs = c.nowMs - .25
    coordinator.port.observe!(c)
    if (i === 0) coordinator.port.request(request)
  }
  expect(coordinator.port.poll(1500)).toBeNull()
  expect(coordinator.snapshot().readiness.captures).toBe(26)
  expect(sent).toHaveLength(1)
  coordinator.port.close()
})

for (const reentry of ['close', 'poll'] as const) test(`terminal uncertainty revokes pending ownership before cancellation can reenter ${reentry}`, () => {
  const cancelled: string[] = [], reentrantAcks: unknown[] = []
  const coordinator = createCargoIntakeCoordinator(declaration(), { evidence: 'modeled-cargo-intake-mechanism', request() {}, cancel(eventId) {
    cancelled.push(eventId)
    if (reentry === 'close') coordinator.port.close()
    else reentrantAcks.push(coordinator.port.poll(1560))
  } })
  const request = ready(coordinator), foreign = context(1560, 27, request)
  foreign.measurement!.values.intakeEventId = 'another-vehicle:intake'
  coordinator.port.observe!(foreign)
  const ack = coordinator.port.poll(1560)
  if (reentry === 'close') expect(ack).toBeNull()
  else {
    expect(ack).toMatchObject({ eventId: request.eventId, outcome: 'uncertain' })
    expect(reentrantAcks).toEqual([null])
  }
  expect(cancelled).toEqual([request.eventId])
  expect(coordinator.snapshot().custody).toMatchObject({ outcome: 'uncertain', reason: 'intake-receipt-unqualified', receiptCapturedAtMs: null, acknowledgedAtMs: reentry === 'close' ? null : 1560 })
  expect(coordinator.snapshot().grant).toBeNull()
  expect(coordinator.port.poll(1560)).toBeNull()
  coordinator.port.close(); coordinator.port.close()
  expect(cancelled).toEqual([request.eventId])
  expect(() => coordinator.port.request(request)).toThrow('cargo-intake-command-replayed')
})

test('the intake port rejects a negative first clock without accepting or consuming any observation', () => {
  const coordinator = createCargoIntakeCoordinator(declaration(), { evidence: 'modeled-cargo-intake-mechanism', request() {}, cancel() {} })
  expect(() => coordinator.port.observe!(context(-1, 1))).toThrow('cargo-intake-clock')
  expect(() => coordinator.port.poll(-1)).toThrow('cargo-intake-clock')
  expect(coordinator.snapshot().readiness.captures).toBe(0)
  const request = ready(coordinator)
  expect(coordinator.snapshot().grant!.command).toEqual(request)
  coordinator.port.close()
})
