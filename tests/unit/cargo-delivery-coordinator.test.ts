import { expect, test } from 'bun:test'
import type { SensorVector } from '../../resources/functions/drone/sensors/types'
import type { VehicleControllerContext, VehiclePayloadCommand } from '../../resources/functions/drone/vehicles/types'
import { createCargoDeliveryCoordinator } from '../../resources/functions/drone/cargo/coordinator'
import { vehicleReference } from '../../resources/functions/drone/vehicles/measurements'
import { observation } from '../fixtures/authority/context'

const declaration = { origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, site: { id: 'receiver-west', recipientId: 'recipient-west', containerId: 'parcel-west', positionM: [2, -1, 0] as SensorVector, radiusM: .35 }, releaseHeightM: 1 }
function context(nowMs: number, sequence: number): VehicleControllerContext {
  const estimate = observation(nowMs).estimate
  estimate.localPosition!.positionM = [2, -1, -1]
  estimate.localPosition!.covarianceBlocks = [0, 1, 2].map(() => ({ positionM2: .0001, positionVelocityM2S: 0, velocityM2S2: .0001 }))
  const reference = vehicleReference(estimate), capturedAtMs = nowMs - 40
  return { nowMs, enabled: true, estimate,
    measurement: { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'quadcopter', sequence, reference, capturedAtMs, receivedAtMs: nowMs,
      values: { onSurface: false, stopped: false, siteId: 'receiver-west', recipientId: 'recipient-west', siteClear: true, recipientPresent: true, loadAttached: true, mechanismOpen: false, mechanismJammed: false, mechanismEventId: '', receiptEventId: '', receiptContainerId: 'parcel-west' } },
    measurementPose: { capturedAtMs, reference, positionM: [2, -1, -1], quaternionWxyz: [1, 0, 0, 0], positionCapturedAtMs: capturedAtMs, positionPredictedToMs: capturedAtMs, attitudeCapturedAtMs: capturedAtMs, attitudePredictedToMs: capturedAtMs, gyroCapturedAtMs: capturedAtMs, attitudePrediction: 'qualified-gyro-hold' },
    controlRate: { evidence: 'modeled-qualified-imu', capturedAtMs: nowMs, reference, angularRateRadS: [0, 0, 0] },
    mission: { version: 2, vehicle: 'quadcopter', evidence: 'owned-vehicle-mission-simulation', physicalFlightEnabled: false, state: 'running', taskId: 'release', taskKind: 'payload', targetM: [2, -1, -1], payload: null, reason: 'task-entered', elapsedMs: 0 } }
}
function command(c: VehicleControllerContext): VehiclePayloadCommand {
  return { eventId: 'delivery-west:release', taskId: 'release', operation: 'material-drop', containerId: 'parcel-west', issuedAtMs: c.nowMs, expiresAtMs: c.nowMs + 1500, positionM: [2, -1, -1], reference: vehicleReference(c.estimate) }
}

// Public policy seam, with declared capture fixtures as transport observations.
// Actual raw sensors/physics remain covered by the delivery runtime campaign.
test('a caller-selected delivery site releases once and requires captured mechanism and recipient evidence', () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(structuredClone(value)), cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const ready = context(1500, 26), request = command(ready)
  ready.mission.payload = request; coordinator.port.observe!(ready); coordinator.port.request(request)
  expect(sent).toEqual([request])
  expect(coordinator.snapshot().delivery.outcome).toBe('uncertain')
  expect(coordinator.port.poll(1500)).toBeNull()
  const opened = context(1560, 29); opened.mission.payload = request
  Object.assign(opened.measurement!.values, { loadAttached: false, mechanismOpen: true, mechanismEventId: request.eventId })
  coordinator.port.observe!(opened)
  expect(coordinator.port.poll(1560)).toBeNull()
  expect(coordinator.snapshot().delivery.outcome).toBe('in-transit')
  const received = context(1580, 30); received.mission.payload = request
  Object.assign(received.measurement!.values, { loadAttached: false, mechanismOpen: true, mechanismEventId: request.eventId, receiptEventId: request.eventId })
  coordinator.port.observe!(received)
  expect(coordinator.port.poll(1580)).toMatchObject({ outcome: 'confirmed', capturedAtMs: 1540, positionM: [2, -1, -1], metadata: { expectedSiteId: 'receiver-west', expectedRecipientId: 'recipient-west' } })
  expect(coordinator.snapshot().delivery).toMatchObject({ outcome: 'received', siteId: 'receiver-west', recipientId: 'recipient-west', mechanismCapturedAtMs: 1520, receiptCapturedAtMs: 1540 })
  expect(coordinator.port.poll(1600)).toBeNull()
  expect(() => coordinator.port.request(request)).toThrow('cargo-delivery-command-replayed')
  expect(sent).toHaveLength(1)
})

test('an aging retained packet breaks readiness even when its sequence has not changed', () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const retained = context(1560, 26), previous = context(1500, 26)
  retained.measurement = previous.measurement; retained.measurementPose = previous.measurementPose
  coordinator.port.observe!(retained)
  expect(coordinator.snapshot().readiness.distinctCaptures).toBe(0)
  const fresh = context(1580, 27), request = command(fresh)
  fresh.mission.payload = request; coordinator.port.observe!(fresh); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  expect(coordinator.snapshot().delivery).toMatchObject({ outcome: 'not-released', reason: 'release-evidence-unqualified' })
})

test('release readiness rejects gyro evidence from another estimator reference', () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  for (let i = 0; i <= 25; i++) {
    const c = context(1000 + i * 20, i + 1); c.controlRate!.reference = 'another-reference'
    coordinator.port.observe!(c)
  }
  const c = context(1500, 26), request = command(c); c.controlRate!.reference = 'another-reference'; c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  expect(coordinator.snapshot().delivery.reason).toBe('release-evidence-unqualified')
})

test('retiming a packet with an unchanged sequence cannot preserve a release window', () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const retimed = context(1540, 26), request = command(retimed)
  retimed.mission.payload = request; coordinator.port.observe!(retimed); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  expect(coordinator.snapshot().readiness.distinctCaptures).toBe(0)
})

test('a fresh packet after an unobserved scheduling gap must rebuild the readiness window', () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const afterGap = context(1660, 27), request = command(afterGap)
  afterGap.mission.payload = request; coordinator.port.observe!(afterGap); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  expect(coordinator.snapshot().readiness).toMatchObject({ distinctCaptures: 1, sinceMs: 1660 })
})

test('a receiver claim cannot turn captured jammed and attached cargo into received custody', () => {
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request() {}, cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const c = context(1500, 26), request = command(c); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  const contradictory = context(1560, 29); contradictory.mission.payload = request
  Object.assign(contradictory.measurement!.values, { mechanismEventId: request.eventId, mechanismJammed: true, receiptEventId: request.eventId })
  coordinator.port.observe!(contradictory)
  expect(coordinator.port.poll(1560)?.outcome).not.toBe('confirmed')
  expect(coordinator.snapshot().delivery.outcome).not.toBe('received')
  expect(coordinator.snapshot().delivery.receiptCapturedAtMs).toBeNull()
})

test('ambient mechanism and receipt fields cannot confirm a release that the policy refused to dispatch', () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  const unready = context(1500, 1), request = command(unready); unready.mission.payload = request
  coordinator.port.observe!(unready); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  const claimed = context(1560, 2); claimed.mission.payload = request
  Object.assign(claimed.measurement!.values, { mechanismOpen: true, loadAttached: false, mechanismEventId: request.eventId, receiptEventId: request.eventId })
  coordinator.port.observe!(claimed)
  expect(coordinator.port.poll(1560)?.outcome).toBe('rejected')
  expect(coordinator.snapshot().delivery).toMatchObject({ outcome: 'not-released', mechanismCapturedAtMs: null, receiptCapturedAtMs: null, reason: 'release-evidence-unqualified' })
})

const invalidEstimates: [string, (c: VehicleControllerContext) => void][] = [
  ['zero attitude quaternion', c => { c.estimate.attitude!.quaternionWxyz = [0, 0, 0, 0] }],
  ['non-unit attitude quaternion', c => { c.estimate.attitude!.quaternionWxyz = [2, 0, 0, 0] }],
  ['future position capture', c => { c.estimate.localPosition!.capturedAtMs = c.nowMs + 1 }],
  ['stale position capture', c => { c.estimate.localPosition!.capturedAtMs = c.nowMs - 201 }],
  ['unpredicted position', c => { c.estimate.localPosition!.predictedToMs = c.nowMs - 20 }],
  ['wrong estimator time', c => { c.estimate.nowMs = c.nowMs - 20 }],
  ['negative velocity variance', c => { c.estimate.localPosition!.covarianceBlocks[0]!.velocityM2S2 = -1 }],
  ['indefinite covariance', c => { c.estimate.localPosition!.covarianceBlocks[0]!.positionVelocityM2S = 1 }],
]
for (const [label, corrupt] of invalidEstimates) test(`release readiness refuses ${label}`, () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  for (let i = 0; i <= 25; i++) { const c = context(1000 + i * 20, i + 1); corrupt(c); coordinator.port.observe!(c) }
  const c = context(1500, 26), request = command(c); corrupt(c); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  expect(coordinator.snapshot().delivery.reason).toBe('release-evidence-unqualified')
})

const invalidCommands: [string, (request: VehiclePayloadCommand) => void][] = [
  ['another task', request => { request.taskId = 'another-task' }],
  ['a different issue-time position', request => { request.positionM = [100, 0, -1] }],
  ['an unbounded lease', request => { request.expiresAtMs = Infinity }],
  ['a lease beyond the native task ceiling', request => { request.expiresAtMs += 10000 }],
  ['a fractional deadline', request => { request.expiresAtMs += .5 }],
  ['an empty event', request => { request.eventId = '' }],
]
for (const [label, corrupt] of invalidCommands) test(`release request refuses ${label}`, () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const c = context(1500, 26), request = command(c); corrupt(request); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  expect(coordinator.snapshot().delivery.reason).toBe('release-evidence-unqualified')
})

test('a throwing mechanism retains dispatch uncertainty and is cancelled once without a release retry', () => {
  const sent: VehiclePayloadCommand[] = [], cancelled: string[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request(value) { sent.push(value); throw new Error('private adapter detail') }, cancel: eventId => { cancelled.push(eventId) } })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const c = context(1500, 26), request = command(c); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  expect(coordinator.snapshot().delivery).toMatchObject({ outcome: 'uncertain', reason: 'mechanism-transport-unavailable' })
  coordinator.port.close(); coordinator.port.close()
  expect(sent).toHaveLength(1)
  expect(cancelled).toEqual([request.eventId])
  expect(coordinator.snapshot().delivery.outcome).toBe('uncertain')
  expect(() => coordinator.port.request(request)).toThrow('cargo-delivery-command-replayed')
})

test('a captured receipt cannot silently clear a mechanism dispatch failure', () => {
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request() { throw new Error('private transport detail') }, cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const c = context(1500, 26), request = command(c); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  const claimed = context(1560, 29); claimed.mission.payload = request
  Object.assign(claimed.measurement!.values, { mechanismOpen: true, loadAttached: false, mechanismEventId: request.eventId, receiptEventId: request.eventId })
  coordinator.port.observe!(claimed)
  expect(coordinator.port.poll(1560)?.outcome).toBe('uncertain')
  expect(coordinator.snapshot().delivery).toMatchObject({ outcome: 'uncertain', receiptCapturedAtMs: null, reason: 'mechanism-transport-unavailable' })
})

test('loss of authority after dispatch preserves uncertain custody and cancels the pending mechanism', () => {
  const cancelled: string[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request() {}, cancel: eventId => { cancelled.push(eventId) } })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const c = context(1500, 26), request = command(c); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  const revoked = context(1520, 27); revoked.enabled = false; revoked.mission.payload = request
  coordinator.port.observe!(revoked)
  expect(coordinator.port.poll(1520)).toBeNull()
  expect(cancelled).toEqual([request.eventId])
  expect(coordinator.snapshot().delivery).toMatchObject({ outcome: 'uncertain', reason: 'receipt-not-confirmed', receiptCapturedAtMs: null })
})

test('configuration and snapshots are detached and getter declarations never run', () => {
  const input = structuredClone(declaration)
  const coordinator = createCargoDeliveryCoordinator(input, { evidence: 'modeled-cargo-mechanism', request() {}, cancel() {} })
  input.site.id = 'mutated-site'; input.site.positionM[0] = 900
  const snapshot = coordinator.snapshot(); snapshot.declaration.site.positionM[0] = 800; snapshot.delivery.outcome = 'received'
  expect(coordinator.snapshot().declaration).toEqual(declaration)
  expect(coordinator.snapshot().delivery.outcome).toBe('not-released')
  let reads = 0
  const getter = { ...declaration, get releaseHeightM() { reads++; return 1 } }
  expect(() => createCargoDeliveryCoordinator(getter, { evidence: 'modeled-cargo-mechanism', request() {}, cancel() {} })).toThrow('cargo-delivery-declaration')
  expect(reads).toBe(0)
  expect(() => createCargoDeliveryCoordinator({ ...declaration, extra: true }, { evidence: 'modeled-cargo-mechanism', request() {}, cancel() {} })).toThrow('cargo-delivery-declaration')
})

test('terminal uncertainty cancels a possibly queued release before clearing the event', () => {
  let queued: VehiclePayloadCommand | null = null
  const cancelled: string[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request(value) { queued = value; throw new Error('queued before failure') }, cancel(eventId) { cancelled.push(eventId); if (queued?.eventId === eventId) queued = null } })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const c = context(1500, 26), request = command(c); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  const fresh = context(1560, 29); fresh.mission.payload = request
  coordinator.port.observe!(fresh)
  expect(coordinator.port.poll(1560)?.outcome).toBe('uncertain')
  expect(queued).toBeNull()
  const revoked = context(1580, 30); revoked.enabled = false
  coordinator.port.observe!(revoked); coordinator.port.close()
  expect(cancelled).toEqual([request.eventId])
  expect(coordinator.snapshot().delivery.outcome).toBe('uncertain')
})

test('receipt admission refuses a non-finite captured ACK position', () => {
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request() {}, cancel() {} })
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(context(1000 + i * 20, i + 1))
  const c = context(1500, 26), request = command(c); c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  const claimed = context(1560, 29); claimed.mission.payload = request; claimed.measurementPose!.positionM = [NaN, 0, -1]
  Object.assign(claimed.measurement!.values, { mechanismOpen: true, loadAttached: false, mechanismEventId: request.eventId, receiptEventId: request.eventId })
  coordinator.port.observe!(claimed)
  expect(coordinator.port.poll(1560)).toBeNull()
  expect(coordinator.snapshot().delivery.receiptCapturedAtMs).toBeNull()
  expect(coordinator.snapshot().delivery.outcome).not.toBe('received')
})

test('variable transport lag cannot shorten the required source-capture readiness interval', () => {
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(declaration, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  let last = context(1000, 1)
  for (let i = 0; i <= 25; i++) {
    last = context(1000 + i * 20, i + 1)
    last.measurement!.capturedAtMs = last.nowMs - 20 - i * 2
    coordinator.port.observe!(last)
  }
  // 26 fresh captures span only450ms even though receipt observations span500ms.
  const request = command(last); last.mission.payload = request
  coordinator.port.observe!(last); coordinator.port.request(request)
  expect(sent).toHaveLength(0)
  expect(coordinator.snapshot().delivery.reason).toBe('release-evidence-unqualified')
})

test('a declared non-default origin, elevated site and release height use their own metric geometry', () => {
  const selected = { origin: { latitudeDeg: 50, longitudeDeg: 8, ellipsoidHeightM: 500 }, site: { id: 'receiver-north', recipientId: 'recipient-north', containerId: 'parcel-north', positionM: [4, 3, 2] as SensorVector, radiusM: .4 }, releaseHeightM: .6 }
  const sent: VehiclePayloadCommand[] = []
  const coordinator = createCargoDeliveryCoordinator(selected, { evidence: 'modeled-cargo-mechanism', request: value => sent.push(value), cancel() {} })
  function selectedContext(nowMs: number, sequence: number) {
    const c = context(nowMs, sequence)
    c.estimate.localPosition!.origin = { ...selected.origin }; c.estimate.localPosition!.positionM = [4, 3, 1.4]
    Object.assign(c.measurement!.values, { siteId: selected.site.id, recipientId: selected.site.recipientId, receiptContainerId: selected.site.containerId })
    c.measurementPose!.positionM = [4, 3, 1.4]; c.mission.targetM = [4, 3, 1.4]
    return c
  }
  for (let i = 0; i <= 25; i++) coordinator.port.observe!(selectedContext(1000 + i * 20, i + 1))
  const c = selectedContext(1500, 26), request = command(c)
  request.positionM = [4, 3, 1.4]; request.containerId = selected.site.containerId; c.mission.payload = request
  coordinator.port.observe!(c); coordinator.port.request(request)
  expect(sent).toEqual([request])
  expect(coordinator.snapshot().declaration).toEqual(selected)
  expect(coordinator.snapshot().delivery).toMatchObject({ outcome: 'uncertain', siteId: 'receiver-north', recipientId: 'recipient-north', containerId: 'parcel-north' })
})
