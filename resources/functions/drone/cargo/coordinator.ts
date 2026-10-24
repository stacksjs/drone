import type { GeodeticOrigin } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { VehicleControllerContext, VehiclePayloadAck, VehiclePayloadCommand, VehiclePayloadPort } from '../vehicles/types'
import { geodeticToEcef } from '../estimation/frames'
import { authorityPolicy } from '../authority/supervisor'
import { createVehicleMeasurementQualifier, vehicleReference } from '../vehicles/measurements'

export interface CargoDeliveryDeclaration {
  origin: GeodeticOrigin
  site: { id: string, recipientId: string, containerId: string, positionM: SensorVector, radiusM: number }
  releaseHeightM: number
}
export interface CargoDeliveryCustody {
  outcome: 'not-released' | 'in-transit' | 'received' | 'uncertain'
  containerId: string
  siteId: string
  recipientId: string
  requestedAtMs: number | null
  mechanismCapturedAtMs: number | null
  receiptCapturedAtMs: number | null
  acknowledgedAtMs: number | null
  reason: string | null
  mechanismOutcome: 'not-requested' | 'requested' | 'open' | 'jammed'
}
export interface ModeledCargoMechanism {
  evidence: 'modeled-cargo-mechanism'
  request(command: VehiclePayloadCommand): void
  cancel(eventId: string): void
}
function record(input: unknown, fields: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== fields.length) throw new TypeError('cargo-delivery-declaration')
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(input, field)
    if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw new TypeError('cargo-delivery-declaration')
    result[field] = d.value
  }
  return result
}
export function captureCargoDeliveryDeclaration(input: unknown): CargoDeliveryDeclaration {
  const top = record(input, ['origin', 'site', 'releaseHeightM']), site = record(top.site, ['id', 'recipientId', 'containerId', 'positionM', 'radiusM'])
  const origin = record(top.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM'])
  if (!['id', 'recipientId', 'containerId'].every(key => typeof site[key] === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(site[key] as string))
    || typeof site.radiusM !== 'number' || !Number.isFinite(site.radiusM) || site.radiusM < .1 || site.radiusM > 2
    || typeof top.releaseHeightM !== 'number' || !Number.isFinite(top.releaseHeightM) || top.releaseHeightM < .3 || top.releaseHeightM > 3
    || !Object.values(origin).every(value => typeof value === 'number' && Number.isFinite(value)) || !Array.isArray(site.positionM) || site.positionM.length !== 3 || Reflect.ownKeys(site.positionM).length !== 4) throw new TypeError('cargo-delivery-declaration')
  const positionM = [0, 1, 2].map(i => {
    const d = Object.getOwnPropertyDescriptor(site.positionM, String(i))
    if (!d?.enumerable || !Object.hasOwn(d, 'value') || typeof d.value !== 'number' || !Number.isFinite(d.value) || Math.abs(d.value) > 5000) throw new TypeError('cargo-delivery-declaration')
    return d.value
  }) as SensorVector
  const capturedOrigin = origin as unknown as GeodeticOrigin
  geodeticToEcef(capturedOrigin)
  return { origin: { ...capturedOrigin }, site: { id: site.id as string, recipientId: site.recipientId as string, containerId: site.containerId as string, positionM, radiusM: site.radiusM }, releaseHeightM: top.releaseHeightM }
}
function finiteTuple(value: unknown, size: number) {
  return Array.isArray(value) && value.length === size && Array.from({ length: size }, (_, i) => i).every(i => Object.hasOwn(value, i) && typeof value[i] === 'number' && Number.isFinite(value[i]))
}

/** Captured modeled release/custody policy behind the shared vehicle payload port. No physical IO. */
export function createCargoDeliveryCoordinator(input: unknown, mechanism: ModeledCargoMechanism) {
  const declaration = captureCargoDeliveryDeclaration(input), { site } = declaration
  if (!mechanism || mechanism.evidence !== 'modeled-cargo-mechanism' || typeof mechanism.request !== 'function' || typeof mechanism.cancel !== 'function') throw new TypeError('cargo-delivery-modeled-mechanism')
  const delivery: CargoDeliveryCustody = { outcome: 'not-released', containerId: site.containerId, siteId: site.id, recipientId: site.recipientId, requestedAtMs: null, mechanismCapturedAtMs: null, receiptCapturedAtMs: null, acknowledgedAtMs: null, reason: null, mechanismOutcome: 'not-requested' }
  const measurements = createVehicleMeasurementQualifier('quadcopter')
  let pending: VehiclePayloadCommand | null = null, observed: VehicleControllerContext | null = null
  let closed = false, requested = false, lastPollMs = -1, lastSequence = -1, readyCount = 0, readyStartMs: number | null = null, readyReference: string | null = null, refused: string | null = null
  let lastObservedAtMs: number | null = null, releaseAttempted = false, readyCaptureStartMs: number | null = null
  function ready(context: VehicleControllerContext) {
    const e = context.estimate, m = context.measurement, p = e.localPosition, a = e.attitude, q = a?.quaternionWxyz, rate = context.controlRate
    if (!context.enabled || context.estimate.evidence !== 'fixture' || !context.estimate.health.localPosition || !context.estimate.health.tilt || !m || !p || !q || !rate
      || e.physicalFlightEnabled !== false || e.nowMs !== context.nowMs || a?.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'WGS84_ELLIPSOID'
      || p.capturedAtMs === null || !Number.isFinite(p.capturedAtMs) || p.capturedAtMs < 0 || p.capturedAtMs > context.nowMs || context.nowMs - p.capturedAtMs > 200 || p.predictedToMs !== context.nowMs
      || !finiteTuple(p.positionM, 3) || !finiteTuple(p.velocityMps, 3) || !finiteTuple(q, 4) || Math.abs(Math.hypot(...q) - 1) > 1e-6 || !finiteTuple(rate.angularRateRadS, 3)
      || !Array.isArray(p.covarianceBlocks) || p.covarianceBlocks.length !== 3 || !p.covarianceBlocks.every(b => b && [b.positionM2, b.positionVelocityM2S, b.velocityM2S2].every(Number.isFinite) && b.positionM2 >= 0 && b.velocityM2S2 >= 0 && b.positionVelocityM2S ** 2 <= b.positionM2 * b.velocityM2S2 + 1e-12)
      || m.reference !== vehicleReference(context.estimate) || m.capturedAtMs > context.nowMs || context.nowMs - m.capturedAtMs > 80 || m.receivedAtMs > context.nowMs
      || rate.evidence !== 'modeled-qualified-imu' || rate.reference !== m.reference || !Number.isSafeInteger(rate.capturedAtMs) || rate.capturedAtMs > context.nowMs || context.nowMs - rate.capturedAtMs > 60 || rate.capturedAtMs !== context.estimate.attitude?.capturedAtMs
      || m.values.siteId !== site.id || m.values.recipientId !== site.recipientId || m.values.siteClear !== true || m.values.recipientPresent !== true || m.values.loadAttached !== true
      || !p.origin || p.origin.latitudeDeg !== declaration.origin.latitudeDeg || p.origin.longitudeDeg !== declaration.origin.longitudeDeg || p.origin.ellipsoidHeightM !== declaration.origin.ellipsoidHeightM) return false
    const speed = Math.hypot(...p.velocityMps), sigma = Math.sqrt(Math.max(...p.covarianceBlocks.map(block => block.positionM2)))
    const horizontal = Math.hypot(p.positionM[0]! - site.positionM[0], p.positionM[1]! - site.positionM[1]), heightM = site.positionM[2] - p.positionM[2]!
    return speed <= .18 && horizontal + 3 * sigma + speed * .08 <= site.radiusM && Math.abs(heightM - declaration.releaseHeightM) <= .2
      && Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q[1] ** 2 + q[2] ** 2)))) <= .2 && Math.hypot(...rate.angularRateRadS) <= .5
  }
  function cancel() {
    const command = pending
    pending = null
    if (command && releaseAttempted) {
      try { mechanism.cancel(command.eventId) }
      catch { delivery.reason ??= 'mechanism-cancel-unavailable' }
    }
  }
  const port: VehiclePayloadPort = {
    observe(input) {
      const context = structuredClone(input)
      if (lastObservedAtMs !== null && context.nowMs - lastObservedAtMs > authorityPolicy.schedulerGapMs) { readyCount = 0; readyStartMs = null; readyCaptureStartMs = null }
      lastObservedAtMs = context.nowMs
      try { context.measurement = measurements.qualify(context.measurement, context.nowMs, vehicleReference(context.estimate)) }
      catch { context.measurement = null; context.measurementPose = null }
      observed = context
      if (pending && (context.mission.payloadFailure?.eventId === pending.eventId || !context.enabled)) {
        cancel()
        if (delivery.mechanismOutcome === 'open' || delivery.outcome === 'uncertain') { delivery.outcome = 'uncertain'; delivery.reason ??= 'receipt-not-confirmed' }
        else { delivery.outcome = 'not-released'; delivery.reason ??= 'receipt-not-confirmed' }
      }
      const sequence = context.measurement?.sequence ?? -1, reference = context.measurement?.reference ?? null
      const qualified = ready(context) && (readyReference === null || reference === readyReference)
      if (!qualified) { readyCount = 0; readyStartMs = null; readyCaptureStartMs = null }
      if (sequence === lastSequence && reference === readyReference) return
      if (qualified && (lastSequence < 0 || sequence > lastSequence)) { readyCount++; readyStartMs ??= context.nowMs; readyCaptureStartMs ??= context.measurement!.capturedAtMs }
      else { readyCount = 0; readyStartMs = null; readyCaptureStartMs = null }
      lastSequence = sequence; readyReference = reference
    },
    request(command) {
      if (closed || requested || pending !== null) throw new TypeError('cargo-delivery-command-replayed')
      requested = true; pending = structuredClone(command); delivery.requestedAtMs = command.issuedAtMs; delivery.mechanismOutcome = 'requested'
      const c = observed, scoped = c?.mission.payload
      if (!c || !scoped || c.mission.version !== 2 || c.mission.vehicle !== 'quadcopter' || c.mission.evidence !== 'owned-vehicle-mission-simulation' || c.mission.physicalFlightEnabled !== false || c.mission.state !== 'running' || c.mission.taskKind !== 'payload' || command.taskId !== c.mission.taskId || command.operation !== 'material-drop' || command.containerId !== site.containerId
        || typeof command.eventId !== 'string' || command.eventId.length < 1 || command.eventId.length > 160 || !Number.isSafeInteger(command.expiresAtMs) || command.expiresAtMs - c.nowMs > 10000
        || !finiteTuple(command.positionM, 3) || !c.estimate.localPosition || !command.positionM.every((value, i) => value === c.estimate.localPosition!.positionM[i])
        || JSON.stringify(scoped) !== JSON.stringify(command) || command.reference !== vehicleReference(c.estimate) || command.issuedAtMs !== c.nowMs || command.expiresAtMs <= c.nowMs
        || !ready(c) || readyCount < 26 || readyStartMs === null || c.nowMs - readyStartMs < 500 || readyCaptureStartMs === null || !c.measurement || c.measurement.capturedAtMs - readyCaptureStartMs < 500) { refused = 'release-evidence-unqualified'; delivery.reason = refused }
      else {
        releaseAttempted = true
        delivery.outcome = 'uncertain'
        try { mechanism.request(structuredClone(command)) }
        catch { refused = 'mechanism-transport-unavailable'; delivery.reason = refused }
      }
    },
    poll(nowMs): VehiclePayloadAck | null {
      if (!Number.isSafeInteger(nowMs) || nowMs < lastPollMs) throw new RangeError('cargo-delivery-clock')
      lastPollMs = nowMs
      const c = observed, m = c?.measurement, pose = c?.measurementPose
      if (!pending || closed || !c?.enabled || c.nowMs !== nowMs || !m || m.reference !== pending.reference || m.capturedAtMs < pending.issuedAtMs || m.capturedAtMs >= pending.expiresAtMs
        || nowMs >= pending.expiresAtMs || nowMs - m.capturedAtMs > 80 || m.receivedAtMs > nowMs || !pose || pose.reference !== m.reference || pose.capturedAtMs !== m.capturedAtMs || pose.positionPredictedToMs !== m.capturedAtMs || !finiteTuple(pose.positionM, 3) || !pose.positionM.every(value => Math.abs(value) <= 1e6)) return null
      if (releaseAttempted && m.values.mechanismEventId === pending.eventId && m.values.mechanismJammed === true && m.values.loadAttached === true) {
        delivery.mechanismCapturedAtMs ??= m.capturedAtMs; delivery.mechanismOutcome = 'jammed'; delivery.outcome = 'not-released'; refused = 'mechanism-jammed'; delivery.reason = refused
      }
      if (releaseAttempted && m.values.mechanismEventId === pending.eventId && m.values.mechanismOpen === true && m.values.loadAttached === false) { delivery.mechanismCapturedAtMs ??= m.capturedAtMs; delivery.mechanismOutcome = 'open'; delivery.outcome = 'in-transit' }
      const received = releaseAttempted && delivery.mechanismOutcome === 'open' && delivery.mechanismCapturedAtMs !== null && m.values.mechanismEventId === pending.eventId && m.values.mechanismOpen === true && m.values.mechanismJammed === false && m.values.loadAttached === false
        && m.values.receiptEventId === pending.eventId && m.values.receiptContainerId === pending.containerId
        && m.values.recipientId === site.recipientId && m.values.siteId === site.id && m.values.recipientPresent === true && m.values.siteClear === true
      if (releaseAttempted && m.values.receiptEventId !== '' && !received) { refused = 'receipt-scope-mismatch'; delivery.reason = refused; delivery.outcome = 'uncertain' }
      if (!refused && !received) return null
      const command = pending
      if (refused) cancel()
      else pending = null
      delivery.acknowledgedAtMs = nowMs
      if (refused && releaseAttempted && delivery.outcome !== 'not-released') delivery.outcome = 'uncertain'
      if (received && !refused) { delivery.receiptCapturedAtMs = m.capturedAtMs; delivery.outcome = 'received' }
      return { eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: command.containerId, reference: command.reference, capturedAtMs: m.capturedAtMs,
        positionM: [...pose.positionM], outcome: refused ? delivery.outcome === 'uncertain' ? 'uncertain' : 'rejected' : 'confirmed',
        metadata: { modeledOnly: true, expectedSiteId: site.id, expectedRecipientId: site.recipientId, observedSiteId: typeof m.values.siteId === 'string' ? m.values.siteId : 'unqualified', observedRecipientId: typeof m.values.recipientId === 'string' ? m.values.recipientId : 'unqualified' } }
    },
    close() {
      closed = true; cancel(); observed = null
      if (delivery.outcome === 'in-transit' || delivery.outcome === 'uncertain') { delivery.outcome = 'uncertain'; delivery.reason ??= 'receipt-not-confirmed' }
    },
  }
  return { port, snapshot: () => structuredClone({ evidence: 'modeled-cargo-delivery-coordinator' as const, physicalFlightEnabled: false as const, identityAuthenticated: false as const, declaration, delivery, readiness: { distinctCaptures: readyCount, sinceMs: readyStartMs, sinceCaptureMs: readyCaptureStartMs, reference: readyReference } }) }
}
