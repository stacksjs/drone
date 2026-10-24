import type { GeodeticOrigin } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { VehicleControllerContext, VehiclePayloadCommand, VehiclePayloadPort, VehiclePayloadAck } from '../vehicles/types'
import { createVehicleMeasurementQualifier, vehicleReference } from '../vehicles/measurements'

interface IntakeDeclaration { origin: GeodeticOrigin, padM: SensorVector, receiverId: string, containerId: string, massKg: number, bootId: bigint, sessionId: bigint }
export interface ModeledCargoIntakeGrant { evidence: 'modeled-cargo-intake-grant-v1', receiverId: string, bootId: bigint, sessionId: bigint, command: VehiclePayloadCommand, sourceEventId: string, issuedAtMs: number, expiresAtMs: number }
export interface ModeledCargoIntakeMechanism { evidence: 'modeled-cargo-intake-mechanism', request(grant: ModeledCargoIntakeGrant): void, cancel(eventId: string): void }
const finiteTuple = (v: unknown, size: number): v is number[] => Array.isArray(v) && v.length === size && Array.from({ length: size }, (_, i) => i).every(i => Object.hasOwn(v, i) && typeof v[i] === 'number' && Number.isFinite(v[i]))
function record(input: unknown, fields: string[]) {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== fields.length) throw new TypeError()
  const result: Record<string, unknown> = {}
  for (const field of fields) { const d = Object.getOwnPropertyDescriptor(input, field); if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw new TypeError(); result[field] = d.value }
  return result
}
function capture(input: unknown): IntakeDeclaration {
  try {
    const v = record(input, ['origin', 'padM', 'receiverId', 'containerId', 'massKg', 'bootId', 'sessionId']), o = record(v.origin, ['latitudeDeg', 'longitudeDeg', 'ellipsoidHeightM'])
    if (o.latitudeDeg !== 0 || o.longitudeDeg !== 0 || o.ellipsoidHeightM !== 100 || !['receiverId', 'containerId'].every(key => typeof v[key] === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v[key] as string))
      || typeof v.massKg !== 'number' || !Number.isFinite(v.massKg) || v.massKg <= 0 || v.massKg > .25 || ![v.bootId, v.sessionId].every(n => typeof n === 'bigint' && n > 0n && n <= 0xffffffffffffffffn)) throw new TypeError()
    if (!Array.isArray(v.padM) || Reflect.ownKeys(v.padM).length !== 4) throw new TypeError()
    const padM = [0, 1, 2].map(i => { const d = Object.getOwnPropertyDescriptor(v.padM, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value') || typeof d.value !== 'number' || !Number.isFinite(d.value) || Math.abs(d.value) > 12) throw new TypeError(); return d.value }) as SensorVector
    if (padM[2] < -1 || padM[2] > 0) throw new TypeError()
    return { origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, padM, receiverId: v.receiverId as string, containerId: v.containerId as string, massKg: v.massKg, bootId: v.bootId as bigint, sessionId: v.sessionId as bigint }
  }
  catch { throw new TypeError('cargo-intake-declaration') }
}

/** Captured receipt policy. The modeled world separately gates every physical intake against live authority. */
export function createCargoIntakeCoordinator(input: unknown, mechanism: ModeledCargoIntakeMechanism) {
  const declaration = capture(input)
  let requestMechanism: ModeledCargoIntakeMechanism['request'], cancelMechanism: ModeledCargoIntakeMechanism['cancel']
  try {
    const m = record(mechanism, ['evidence', 'request', 'cancel'])
    if (m.evidence !== 'modeled-cargo-intake-mechanism' || typeof m.request !== 'function' || typeof m.cancel !== 'function') throw new TypeError()
    requestMechanism = (m.request as ModeledCargoIntakeMechanism['request']).bind(mechanism)
    cancelMechanism = (m.cancel as ModeledCargoIntakeMechanism['cancel']).bind(mechanism)
  }
  catch { throw new TypeError('cargo-intake-mechanism') }
  const qualifier = createVehicleMeasurementQualifier('quadcopter')
  let observed: VehicleControllerContext | null = null, pending: VehiclePayloadCommand | null = null, grant: ModeledCargoIntakeGrant | null = null
  let closed = false, requested = false, attempted = false, lastNow = -1, lastPoll = -1, lastSequence = -1, captures = 0, sinceMs: number | null = null, sinceCaptureMs: number | null = null
  let readyReference: string | null = null, sourceEventId: string | null = null
  const custody: { outcome: 'not-requested' | 'pending' | 'uncertain' | 'received' | 'rejected', requestedAtMs: number | null, grantedAtMs: number | null, mechanismAtMs: number | null, receiptCapturedAtMs: number | null, acknowledgedAtMs: number | null, sourceEventId: string | null, reason: string | null } = { outcome: 'not-requested', requestedAtMs: null, grantedAtMs: null, mechanismAtMs: null, receiptCapturedAtMs: null, acknowledgedAtMs: null, sourceEventId: null, reason: null }
  function clearReadiness() { captures = 0; sinceMs = null; sinceCaptureMs = null; sourceEventId = null }
  function cancel() { if (grant) { const eventId = grant.command.eventId; grant = null; try { cancelMechanism(eventId) } catch { custody.reason ??= 'intake-cancel-unavailable' } } }
  function qualified(c: VehicleControllerContext) {
    const e = c.estimate, p = e.localPosition, a = e.attitude, m = c.measurement, rate = c.controlRate
    if (!c.enabled || e.evidence !== 'fixture' || e.physicalFlightEnabled !== false || !e.health.localPosition || !e.health.tilt || e.nowMs !== c.nowMs || !p || !a || !m || !rate
      || !vehicleReference(e).startsWith(`${declaration.bootId}:`) || m.reference !== vehicleReference(e) || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'WGS84_ELLIPSOID'
      || !p.origin || p.origin.latitudeDeg !== 0 || p.origin.longitudeDeg !== 0 || p.origin.ellipsoidHeightM !== 100 || p.capturedAtMs === null || !Number.isFinite(p.capturedAtMs) || p.capturedAtMs < 0 || c.nowMs - p.capturedAtMs > 200 || p.capturedAtMs > c.nowMs || p.predictedToMs !== c.nowMs
      || !finiteTuple(p.positionM, 3) || !finiteTuple(p.velocityMps, 3) || !finiteTuple(a.quaternionWxyz, 4) || Math.abs(Math.hypot(...a.quaternionWxyz) - 1) > 1e-6 || a.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW'
      || m.capturedAtMs > c.nowMs || c.nowMs - m.capturedAtMs > 80 || m.receivedAtMs > c.nowMs || rate.evidence !== 'modeled-qualified-imu' || !Number.isFinite(rate.capturedAtMs) || rate.capturedAtMs < 0 || rate.reference !== m.reference || rate.capturedAtMs !== a.capturedAtMs || rate.capturedAtMs > c.nowMs || c.nowMs - rate.capturedAtMs > 60 || !finiteTuple(rate.angularRateRadS, 3)
      || m.values.receiverId !== declaration.receiverId || m.values.siteClear !== true || m.values.onSurface !== true || m.values.stopped !== true) return false
    const blocks = p.covarianceBlocks
    if (!Array.isArray(blocks) || blocks.length !== 3 || !blocks.every(b => b && [b.positionM2, b.positionVelocityM2S, b.velocityM2S2].every(Number.isFinite) && b.positionM2 >= 0 && b.velocityM2S2 >= 0 && b.positionVelocityM2S ** 2 <= b.positionM2 * b.velocityM2S2 + 1e-12)) return false
    const sigma = Math.sqrt(Math.max(...blocks.map(b => b.positionM2)))
    return Math.hypot(...p.velocityMps) <= .1 && Math.hypot(...p.positionM.map((n, i) => n - declaration.padM[i]!)) + 3 * sigma <= .2
      && Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (a.quaternionWxyz[1] ** 2 + a.quaternionWxyz[2] ** 2)))) <= .15 && Math.hypot(...rate.angularRateRadS) <= .2
  }
  function ack(nowMs: number, outcome: VehiclePayloadAck['outcome']): VehiclePayloadAck | null {
    const command = pending!, c = observed!, m = c.measurement!, pose = c.measurementPose!
    const result: VehiclePayloadAck = { eventId: command.eventId, taskId: command.taskId, operation: command.operation, containerId: command.containerId, reference: command.reference, capturedAtMs: m.capturedAtMs, positionM: [...pose.positionM], outcome,
      metadata: { modeledOnly: true, receiverId: declaration.receiverId, sourceEventId: custody.sourceEventId ?? 'unavailable', reason: custody.reason ?? 'captured-intake' } }
    // Consume the terminal command before calling the injected adapter. It may
    // synchronously close or poll this port, but cannot consume the same ACK.
    pending = null
    if (outcome !== 'confirmed') cancel()
    else grant = null
    if (closed) return null
    custody.acknowledgedAtMs = nowMs
    return result
  }
  const port: VehiclePayloadPort = {
    observe(input) {
      if (closed) return
      const c = structuredClone(input)
      if (!Number.isSafeInteger(c.nowMs) || c.nowMs < 0 || c.nowMs < lastNow) throw new TypeError('cargo-intake-clock')
      if (lastNow >= 0 && c.nowMs - lastNow > 40) clearReadiness()
      lastNow = c.nowMs
      try { c.measurement = qualifier.qualify(c.measurement, c.nowMs, vehicleReference(c.estimate)) } catch { c.measurement = null; c.measurementPose = null }
      observed = c
      if (pending && (!c.enabled || c.mission.payloadFailure?.eventId === pending.eventId || c.mission.state !== 'running' || c.mission.taskId !== pending.taskId || c.mission.payload?.eventId !== pending.eventId)) { cancel(); custody.outcome = attempted ? 'uncertain' : 'rejected'; custody.reason ??= 'intake-authority-unavailable' }
      const m = c.measurement, event = m?.values.stationSourceEventId, sequence = m?.sequence ?? -1
      const ready = qualified(c) && m?.values.loadAttached === false && m.values.stationReady === true && m.values.stationContainerId === declaration.containerId
        && typeof event === 'string' && event.length > 0 && event.length <= 160 && (readyReference === null || readyReference === m.reference) && (sourceEventId === null || sourceEventId === event)
      if (!ready) clearReadiness()
      if (sequence !== lastSequence) {
        if (ready && sequence > lastSequence) { captures++; sinceMs ??= c.nowMs; sinceCaptureMs ??= m!.capturedAtMs; sourceEventId = event as string; readyReference = m!.reference }
        else clearReadiness()
        lastSequence = sequence
      }
    },
    request(input) {
      if (closed || requested) throw new TypeError('cargo-intake-command-replayed')
      requested = true; pending = structuredClone(input); custody.requestedAtMs = pending.issuedAtMs; custody.outcome = 'pending'
      const c = observed
      if (!c || c.mission.state !== 'running' || c.mission.vehicle !== 'quadcopter' || c.mission.taskKind !== 'payload' || !c.mission.payload || JSON.stringify(c.mission.payload) !== JSON.stringify(pending)
        || pending.operation !== 'material-receive' || pending.containerId !== declaration.containerId || pending.reference !== vehicleReference(c.estimate) || pending.issuedAtMs !== c.nowMs || !Number.isSafeInteger(pending.expiresAtMs) || pending.expiresAtMs <= c.nowMs || pending.expiresAtMs - c.nowMs > 60000 || !qualified(c)) {
        custody.outcome = 'rejected'; custody.reason = 'intake-command-unqualified'
      }
    },
    poll(nowMs) {
      if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs < lastPoll) throw new TypeError('cargo-intake-clock')
      lastPoll = nowMs
      const c = observed, m = c?.measurement, pose = c?.measurementPose
      if (closed || !pending || !c || c.nowMs !== nowMs || !qualified(c) || !m || !pose || pose.reference !== pending.reference || m.reference !== pending.reference || pose.capturedAtMs !== m.capturedAtMs || pose.positionPredictedToMs !== m.capturedAtMs || !finiteTuple(pose.positionM, 3) || !pose.positionM.every(value => Math.abs(value) <= 1e6) || !finiteTuple(pending.positionM, 3) || !pending.positionM.every(value => Math.abs(value) <= 1e6) || Math.hypot(...pose.positionM.map((value, i) => value - pending!.positionM[i]!)) > 1
        || m.capturedAtMs < pending.issuedAtMs || m.capturedAtMs >= pending.expiresAtMs || nowMs >= pending.expiresAtMs) return null
      if (custody.outcome === 'rejected') return ack(nowMs, 'rejected')
      if (custody.outcome === 'uncertain' && custody.reason !== null) return ack(nowMs, 'uncertain')
      if (!attempted && captures >= 26 && sinceMs !== null && nowMs - sinceMs >= 500 && sinceCaptureMs !== null && m.capturedAtMs - sinceCaptureMs >= 500 && sourceEventId !== null) {
        attempted = true; custody.outcome = 'uncertain'; custody.grantedAtMs = nowMs; custody.sourceEventId = sourceEventId
        grant = { evidence: 'modeled-cargo-intake-grant-v1', receiverId: declaration.receiverId, bootId: declaration.bootId, sessionId: declaration.sessionId, command: structuredClone(pending), sourceEventId, issuedAtMs: nowMs, expiresAtMs: Math.min(nowMs + 40, pending.expiresAtMs) }
        try { requestMechanism(structuredClone(grant)) } catch { custody.reason = 'intake-transport-unavailable' }
        if (closed || !pending) return null
        // An attempted mechanism is uncertain until a later captured observation, never this request.
        return null
      }
      if (!attempted || !grant) return null
      const atMs = m.values.intakeAtMs
      const correlated = m.values.intakeEventId === pending.eventId && m.values.intakeSourceEventId === grant.sourceEventId
        && typeof atMs === 'number' && Number.isSafeInteger(atMs) && atMs > grant.issuedAtMs && atMs < grant.expiresAtMs && atMs <= m.capturedAtMs
      if (correlated && m.values.intakeOutcome === 'attached' && m.values.loadAttached === true && m.values.intakeMassKg === declaration.massKg) { custody.outcome = 'received'; custody.mechanismAtMs = atMs; custody.receiptCapturedAtMs = m.capturedAtMs; return ack(nowMs, 'confirmed') }
      if (correlated && m.values.intakeOutcome === 'refused' && m.values.loadAttached === false && m.values.intakeMassKg === 0) { custody.outcome = 'rejected'; custody.mechanismAtMs = atMs as number; custody.receiptCapturedAtMs = m.capturedAtMs; custody.reason = 'point-joint-refused'; return ack(nowMs, 'rejected') }
      if (m.values.intakeEventId !== '' || nowMs > grant.expiresAtMs + 120) { custody.outcome = 'uncertain'; custody.reason = 'intake-receipt-unqualified'; return ack(nowMs, 'uncertain') }
      return null
    },
    close() { if (closed) return; closed = true; cancel(); observed = null; pending = null; if (custody.outcome === 'pending') { custody.outcome = 'rejected'; custody.reason ??= 'intake-not-attempted' }
      else if (custody.outcome === 'uncertain') custody.reason ??= 'intake-receipt-not-confirmed' },
  }
  return { port, snapshot: () => structuredClone({ evidence: 'modeled-cargo-intake-coordinator' as const, physicalFlightEnabled: false as const, identityAuthenticated: false as const, declaration, custody, grant, readiness: { captures, sinceMs, sinceCaptureMs, reference: readyReference, sourceEventId } }) }
}
