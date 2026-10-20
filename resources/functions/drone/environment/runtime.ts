import type { MissionSimulationContext } from '../missions/simulation'
import type { MissionSnapshot, MissionState, MissionTrace } from '../missions/engine'
import type { EnvironmentProfile, V3 } from './plan'
import type { Diagnostic, EnvironmentCalibration, PacketRecord, RawPacket } from './sensor'
import { simulateMission } from '../missions/simulation'
import { parseMissionTrace } from '../missions/engine'
import { missionContains } from '../missions/plan'
import { createPayloadPoseTimeline } from '../payloads/pose'
import { nedToGeodetic } from '../estimation/frames'
import { compact, dataRecord, denseArray, environmentLimits, environmentMission, environmentModel, environmentPolicy, finite, integer, normalizeEnvironmentInput, sha256, unavailable, vector } from './plan'
import { createEnvironmentDetector, fitEnvironmentCalibration, reduceEnvironmentCount, validateRawEnvironmentPacket } from './sensor'

export const environmentFailureReasons = ['instrument-clock', 'model-envelope', 'model-render-failure', 'observe-failure', 'resource-limit', 'mission-not-running', 'navigation-unqualified', 'position-covariance-invalid', 'reference-changed', 'collection-authority-lost', 'collection-fence', 'declared-exclusion', 'declared-site-closed', 'capture-pose-unqualified', 'detector-packet-identity', 'detector-packet-timing', 'detector-calibration-domain', 'detector-packet-deadline'] as const
export type EnvironmentFailure = typeof environmentFailureReasons[number]
export interface Observation {
  id: string, sequence: number, capturedAtMs: number, receivedAtMs: number, sourceId: 'environment-detector-1', calibrationId: 'environment-adc-synthetic-v1', rawSha256: string, reference: string, positionM: V3,
  geodetic: { latitudeDeg: number, longitudeDeg: number, ellipsoidHeightM: number }, positionSnapshotAtMs: number, positionMeasurementAtMs: number, positionPredictedToMs: number, attitudeMeasurementAtMs: number,
  priorMissionObservedAtMs: number, priorMissionTaskId: string, valueU: number, valueAbsBoundU: number, positionVarianceNedM2: V3, positionClockTravelBoundM: 0.003, clockUncertaintyMs: 1, band: 'low' | 'high' | 'transit', reviewStatus: 'required',
}
export interface CustodyLink { version: 1, sequence: number, observationSha256: string, previousSha256: string, sha256: string }
export interface DatasetReceipt { directory: string, manifestSha256: string, files: 5, bytes: number }
export interface EnvironmentCounts {
  renderAttempts: number, renderedRows: number, observeAttempts: number, scheduledCaptures: number, deliveredPackets: number, suppressedPackets: number, unreceivedPackets: number, admittedObservations: number, deliveredNotAdmitted: number, discardedPackets: number, lowObservations: number, highObservations: number, transitObservations: number, contextsCreated: number, contextsRemoved: number, retirements: number,
}
export interface EnvironmentFault {
  kind: 'none' | EnvironmentProfile, scheduledCaptureAtMs: number | null, scheduledDecisionAtMs: number | null, observedAtMs: number | null, priorMissionState: MissionState | null, priorMissionObservedAtMs: number | null, priorMissionTaskId: string | null, nativeDecisionAtMs: number | null, nativeState: MissionState | null, earlierAirborneObservations: number, demonstrated: boolean,
}
export interface EnvironmentRetirement {
  atMs: number, reason: string, failedAtMs: number | null, lastRenderAttemptAtMs: number | null, lastRenderedAtMs: number | null, lastObserveAttemptAtMs: number | null, closeCount: 1, pendingCapturesRetired: number, captureContextsCleared: number, acquisitionRetired: true, plantPropagationAfterRetirement: false, lastPlantMotorsN: Diagnostic['plantMotorsN'] | null, boardCommandMotorsN: Diagnostic['plantMotorsN'],
}
export interface EnvironmentSummary {
  version: 1, profile: EnvironmentProfile, evidence: 'owned-environment-physics-simulation', physicalFlightEnabled: false, status: 'completed' | 'aborted' | 'blocked' | 'incomplete', reason: string | null, qualified: boolean, nativeMissionState: MissionState, nativeMissionReason: string, observations: number, lowObservations: number, highObservations: number, deliveredPackets: number, discardedPackets: number, lastObservationAtMs: number | null, faultDemonstrated: boolean, boardCommandNeutral: boolean, acquisitionRetired: true, plantPropagationAfterRetirement: false, reviewStatus: 'required', dataset: DatasetReceipt | null,
}
type NativeMissionRun = ReturnType<typeof simulateMission>
export interface EnvironmentRun {
  version: 1, profile: EnvironmentProfile, evidence: 'owned-environment-physics-simulation', physicalFlightEnabled: false,
  model: ReturnType<typeof environmentModel>, calibration: EnvironmentCalibration, policy: ReturnType<typeof environmentPolicy>,
  mission: { evidence: NativeMissionRun['evidence'], physicalFlightEnabled: false, boardOutputsInhibited: true, scenario: 'nominal', recovered: boolean, budget: NativeMissionRun['budget'], result: MissionSnapshot, authorityState: NativeMissionRun['authority']['state'], boardCommandMotorsN: Diagnostic['plantMotorsN'] },
  trace: MissionTrace, diagnostics: Diagnostic[], packets: PacketRecord[], observations: Observation[], custody: CustodyLink[], counts: EnvironmentCounts, fault: EnvironmentFault, retirement: EnvironmentRetirement, summary: EnvironmentSummary,
}
interface Capture {
  kind: 'initial-ready' | 'not-airborne' | 'airborne'
  revision: number
  reference: string | null
  positionVarianceNedM2: V3 | null
  priorMissionObservedAtMs: number | null
  priorMissionTaskId: string
}
export interface QualifiedEnvironmentNavigation { reference: string, positionM: V3, velocityMps: V3, positionVarianceNedM2: V3, positionMeasurementAtMs: number, attitudeMeasurementAtMs: number }
/** Actual estimator-only policy input. Truth never crosses this boundary. */
export function qualifyEnvironmentNavigation(context: MissionSimulationContext, expectedReference: string | null = null): QualifiedEnvironmentNavigation {
  const e = context.estimate, p = e.localPosition, a = e.attitude, now = context.nowMs
  const fail = (reason: EnvironmentFailure): never => { throw new Error(reason) }
  const fresh = (at: unknown, age: number) => typeof at === 'number' && Number.isFinite(at) && at >= 0 && at <= now && now - at <= age
  if (e.evidence !== 'fixture' || e.physicalFlightEnabled !== false || e.bootId !== 55n || e.nowMs !== now || !e.health.tilt || !e.health.localPosition || !p || !a || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'WGS84_ELLIPSOID' || !p.origin || p.origin.latitudeDeg !== 0 || p.origin.longitudeDeg !== 0 || p.origin.ellipsoidHeightM !== 100 || a.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || !fresh(a.capturedAtMs, 60) || !fresh(p.capturedAtMs, 200) || p.predictedToMs !== now) return fail('navigation-unqualified')
  let positionM: V3, velocityMps: V3
  try {
    positionM = vector(p.positionM); velocityMps = vector(p.velocityMps)
    const q = denseArray(a.quaternionWxyz, 4, 4).map(n => finite(n, -1, 1))
    if (Math.abs(Math.hypot(...q) - 1) > 1e-6 || Math.hypot(...velocityMps) > 3) return fail('navigation-unqualified')
  }
  catch { return fail('navigation-unqualified') }
  let positionVarianceNedM2: V3
  try {
    positionVarianceNedM2 = denseArray(p.covarianceBlocks, 3, 3).map(block => {
      const variance = finite((block as { positionM2: number }).positionM2, 0, 1e6)
      if (variance === 0) return unavailable()
      return variance
    }) as V3
  }
  catch { return fail('position-covariance-invalid') }
  const resetValues = ['attitude', 'position', 'boot', 'manual', 'clock'].map(key => integer(e.resets[key as keyof typeof e.resets], 0, 1e6))
  const reference = `55:${resetValues.join(',')}`
  if (reference.length > 120 || expectedReference !== null && reference !== expectedReference) return fail('reference-changed')
  if (context.authority !== 'autonomous') return fail('collection-authority-lost')
  if (!missionContains(environmentMission(), positionM)) return fail('collection-fence')
  return { reference, positionM, velocityMps, positionVarianceNedM2, positionMeasurementAtMs: p.capturedAtMs!, attitudeMeasurementAtMs: a.capturedAtMs! }
}
export function qualifyEnvironmentPacket(input: unknown, scheduled: Pick<PacketRecord, 'sequence' | 'capturedAtMs' | 'dueAtMs'>, nowMs: number, calibration = fitEnvironmentCalibration()): { packet: RawPacket, valueU: number, reason: EnvironmentFailure | null } {
  const packet = validateRawEnvironmentPacket(input)
  if (packet.sourceId !== 'environment-detector-1' || packet.sessionId !== 'environment-fixture-v1' || packet.sequence !== scheduled.sequence) return { packet, valueU: 0, reason: 'detector-packet-identity' }
  if (packet.clockDomain !== 'fixture-monotonic-ms' || packet.clockUncertaintyMs !== 1 || packet.capturedAtMs !== scheduled.capturedAtMs || packet.receivedAtMs !== nowMs || nowMs !== scheduled.dueAtMs || packet.receivedAtMs - packet.capturedAtMs !== 60) return { packet, valueU: 0, reason: 'detector-packet-timing' }
  try { return { packet, valueU: reduceEnvironmentCount(packet.counts, calibration), reason: null } }
  catch { return { packet, valueU: 0, reason: 'detector-calibration-domain' } }
}
export function createEnvironmentCustody(observation: Observation, previousSha256 = '0'.repeat(64)): CustodyLink {
  const data = { version: 1 as const, sequence: observation.sequence, observationSha256: sha256(compact(observation)), previousSha256 }
  return { ...data, sha256: sha256(compact(data)) }
}
/** One finite unchanged native mission. No caller world, clock, sensor adapter or authority callback. */
export function simulateEnvironment(input: unknown = {}): EnvironmentRun {
  const { profile } = normalizeEnvironmentInput(input)
  const model = environmentModel(), calibration = fitEnvironmentCalibration(), policy = environmentPolicy(profile), plan = environmentMission()
  if (calibration.slope !== 103 || calibration.offset !== 911) return unavailable()
  const detector = createEnvironmentDetector(profile), timeline = createPayloadPoseTimeline()
  const observations: Observation[] = [], custody: CustodyLink[] = [], contexts = new Map<number, Capture>()
  let failure: EnvironmentFailure | null = null, failedAtMs: number | null = null, lastObserveAttemptAtMs: number | null = null
  let observeAttempts = 0, contextsCreated = 0, contextsRemoved = 0, reference: string | null = null, observedFault: { atMs: number, mission: MissionSnapshot, priorAtMs: number } | null = null
  const selectedFailure = profile === 'sensor-loss' ? 'detector-packet-deadline' : profile === 'site-closure' ? 'declared-site-closed' : null
  function latch(reason: EnvironmentFailure, atMs: number, context?: MissionSimulationContext, priorAtMs?: number | null) {
    if (failure !== null) return
    failure = reason; failedAtMs = atMs
    if (reason === selectedFailure && context && priorAtMs !== null && priorAtMs !== undefined) observedFault = { atMs, mission: structuredClone(context.mission), priorAtMs }
  }
  function remove(capturedAtMs: number) { if (contexts.delete(capturedAtMs)) contextsRemoved++ }
  function store(atMs: number, capture: Capture) { if (contexts.size >= 2 || contexts.has(atMs)) throw new Error('resource-limit'); contexts.set(atMs, capture); contextsCreated++ }
  function observe(context: MissionSimulationContext): 'abort' | undefined {
    const previousObserve = lastObserveAttemptAtMs
    observeAttempts++; lastObserveAttemptAtMs = context.nowMs
    const now = context.nowMs, priorAtMs = now === 600 ? null : previousObserve
    try {
      for (const zone of policy.declaredRevisions) if (zone.effectiveAtMs <= now && !policy.appliedRevisions.some(applied => applied.revision === zone.revision)) policy.appliedRevisions.push(structuredClone(zone))
      if (failure) return 'abort'
      if (now === 600 && context.mission.state === 'ready' && priorAtMs === null) {
        store(now, { kind: 'initial-ready', revision: timeline.snapshot().revision, reference: null, positionVarianceNedM2: null, priorMissionObservedAtMs: null, priorMissionTaskId: context.mission.taskId })
        return undefined
      }
      if (priorAtMs !== now - 20) { latch('instrument-clock', now); return 'abort' }
      if (context.mission.state !== 'running') { latch('mission-not-running', now); return 'abort' }
      const navigation = qualifyEnvironmentNavigation(context, reference)
      reference ??= navigation.reference
      for (const zone of policy.appliedRevisions) {
        const inflation = 0.2 + 3 * Math.sqrt(Math.max(navigation.positionVarianceNedM2[0], navigation.positionVarianceNedM2[1])) + 3 * (now - navigation.positionMeasurementAtMs + 1) / 1000
        if (Math.hypot(navigation.positionM[0] - zone.centerM[0], navigation.positionM[1] - zone.centerM[1]) <= zone.radiusM + inflation) { latch(zone.revision === 2 ? 'declared-site-closed' : 'declared-exclusion', now, context, priorAtMs); return 'abort' }
      }
      if (!timeline.record(context.estimate, now)) { latch('capture-pose-unqualified', now); return 'abort' }
      if (now % 100 === 0) store(now, { kind: navigation.positionM[2] > -0.7 ? 'not-airborne' : 'airborne', revision: timeline.snapshot().revision, reference: navigation.reference, positionVarianceNedM2: [...navigation.positionVarianceNedM2], priorMissionObservedAtMs: priorAtMs, priorMissionTaskId: context.mission.taskId })
      const due = detector.receive(now)
      if (!due) return undefined
      if (!due.packet) { latch('detector-packet-deadline', now, context, priorAtMs); remove(due.capturedAtMs); return 'abort' }
      const qualified = qualifyEnvironmentPacket(due.packet, due, now, calibration)
      const capture = contexts.get(due.capturedAtMs)
      let rejected = qualified.reason
      let association: ReturnType<typeof timeline.associate> | null = null
      if (!rejected && (!capture || capture.kind !== 'initial-ready' && (capture.reference !== navigation.reference || !(association = timeline.associate({ capturedAtMs: due.capturedAtMs, clockUncertaintyMs: 1, evidence: 'fixture' }, capture.revision)).pose || association.status !== 'associated' || association.offsetMs !== 0))) rejected = 'capture-pose-unqualified'
      if (rejected) { due.admission = 'rejected'; due.reason = rejected; latch(rejected, now); remove(due.capturedAtMs); return 'abort' }
      if (capture!.kind !== 'airborne') { due.admission = 'not-airborne'; due.reason = capture!.kind; remove(due.capturedAtMs); return undefined }
      const pose = association!.pose!
      if (pose.snapshotAtMs !== due.capturedAtMs || pose.positionPredictedToMs !== due.capturedAtMs || pose.bootId !== 55n || pose.origin.latitudeDeg !== 0 || pose.origin.longitudeDeg !== 0 || pose.origin.ellipsoidHeightM !== 100 || pose.evidence !== 'fixture' || pose.frame !== 'LOCAL_NED' || pose.altitudeDatum !== 'WGS84_ELLIPSOID' || pose.attitudeReference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || capture!.priorMissionObservedAtMs !== due.capturedAtMs - 20 || !missionContains(plan, pose.positionM)) { due.admission = 'rejected'; due.reason = 'capture-pose-unqualified'; latch('capture-pose-unqualified', now); remove(due.capturedAtMs); return 'abort' }
      if (observations.length >= 1001) throw new Error('resource-limit')
      const positionM = vector(pose.positionM)
      const observation: Observation = {
        id: `observation-${String(due.sequence).padStart(4, '0')}`, sequence: due.sequence, capturedAtMs: due.capturedAtMs, receivedAtMs: now, sourceId: 'environment-detector-1', calibrationId: 'environment-adc-synthetic-v1', rawSha256: sha256(compact(due.packet)), reference: capture!.reference!, positionM,
        geodetic: nedToGeodetic(positionM, pose.origin), positionSnapshotAtMs: pose.snapshotAtMs, positionMeasurementAtMs: pose.positionMeasurementAtMs, positionPredictedToMs: pose.positionPredictedToMs, attitudeMeasurementAtMs: pose.attitudeAtMs,
        priorMissionObservedAtMs: capture!.priorMissionObservedAtMs!, priorMissionTaskId: capture!.priorMissionTaskId, valueU: qualified.valueU, valueAbsBoundU: model.uncertainty.valueAbsBoundU, positionVarianceNedM2: capture!.positionVarianceNedM2!, positionClockTravelBoundM: 0.003, clockUncertaintyMs: 1,
        band: Math.abs(positionM[2] + 1) <= 0.2 ? 'low' : Math.abs(positionM[2] + 2) <= 0.2 ? 'high' : 'transit', reviewStatus: 'required',
      }
      observations.push(observation); custody.push(createEnvironmentCustody(observation, custody.at(-1)?.sha256))
      due.admission = 'admitted'; due.reason = null; remove(due.capturedAtMs)
      return undefined
    }
    catch (error) {
      const reason = error instanceof Error && environmentFailureReasons.includes(error.message as EnvironmentFailure) ? error.message as EnvironmentFailure : 'observe-failure'
      latch(reason, now); return 'abort'
    }
  }
  let native: ReturnType<typeof simulateMission>
  let pendingCapturesRetired = 0, captureContextsCleared = 0
  try {
    native = simulateMission({ plan, scenario: 'nominal', seconds: 100, instrument: {
      render(state, nowMs) {
        try { detector.render(state, nowMs) }
        catch (error) { const reason = error instanceof Error && ['instrument-clock', 'model-envelope', 'resource-limit'].includes(error.message) ? error.message as EnvironmentFailure : 'model-render-failure'; latch(reason, nowMs); throw new Error(reason) }
      }, observe,
    } })
  }
  catch { return unavailable() }
  finally {
    pendingCapturesRetired = detector.close(); captureContextsCleared = contexts.size
    for (const key of contexts.keys()) remove(key)
  }
  const trace = native.trace, canonicalTrace = compact(trace)
  if (compact(parseMissionTrace(canonicalTrace)) !== canonicalTrace || compact(trace.plan) !== compact(plan) || trace.rows.length === 0 || trace.rows.some((row, i) => row.observation.nowMs !== 600 + i * 20 || ![null, 'start', 'abort'].includes(row.action) || row.result.payload !== null)) return unavailable()
  const atMs = trace.rows.at(-1)!.observation.nowMs, ds = detector.snapshot()
  if (native.mission.payload !== null || atMs > 100000 || atMs !== ds.lastRenderAttemptAtMs) return unavailable()
  const mission = { evidence: native.evidence, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, scenario: 'nominal' as const, recovered: native.recovered, budget: native.budget, result: native.mission, authorityState: native.authority.state, boardCommandMotorsN: [...native.board.motorsN] as Diagnostic['plantMotorsN'] }
  const counts = {
    renderAttempts: ds.renderAttempts, renderedRows: detector.diagnostics.length, observeAttempts, scheduledCaptures: detector.packets.length, deliveredPackets: detector.packets.filter(row => row.disposition === 'delivered').length,
    suppressedPackets: detector.packets.filter(row => row.disposition === 'suppressed').length, unreceivedPackets: detector.packets.filter(row => row.disposition === 'unreceived-on-retirement').length, admittedObservations: observations.length,
    deliveredNotAdmitted: detector.packets.filter(row => row.disposition === 'delivered' && row.admission !== 'admitted').length, discardedPackets: detector.packets.length - observations.length,
    lowObservations: observations.filter(row => row.band === 'low').length, highObservations: observations.filter(row => row.band === 'high').length, transitObservations: observations.filter(row => row.band === 'transit').length, contextsCreated, contextsRemoved, retirements: 1,
  }
  const selected = observedFault as { atMs: number, mission: MissionSnapshot, priorAtMs: number } | null
  const faultRow = selected ? trace.rows.find(row => row.observation.nowMs === selected.atMs) : null
  const fault: EnvironmentFault = { kind: profile === 'nominal' ? 'none' : profile, scheduledCaptureAtMs: profile === 'sensor-loss' ? 5000 : null, scheduledDecisionAtMs: profile === 'sensor-loss' ? 5060 : profile === 'site-closure' ? 8000 : null, observedAtMs: selected?.atMs ?? null, priorMissionState: selected?.mission.state ?? null, priorMissionObservedAtMs: selected?.priorAtMs ?? null, priorMissionTaskId: selected?.mission.taskId ?? null, nativeDecisionAtMs: faultRow?.observation.nowMs ?? null, nativeState: faultRow?.result.state ?? null, earlierAirborneObservations: selected ? observations.filter(row => row.receivedAtMs < selected.atMs).length : 0, demonstrated: false }
  const boardCommandNeutral = mission.boardCommandMotorsN.every(n => n === 0)
  fault.demonstrated = profile !== 'nominal' && failure === selectedFailure && selected !== null && selected.atMs === fault.scheduledDecisionAtMs && selected.mission.state === 'running' && selected.priorAtMs === selected.atMs - 20 && faultRow?.action === 'abort' && faultRow.result.state === 'aborted' && faultRow.result.reason === 'operator-abort' && fault.earlierAirborneObservations >= 1 && observations.every(row => row.receivedAtMs < selected.atMs) && atMs === selected.atMs && boardCommandNeutral && (profile === 'sensor-loss' ? detector.packets.some(row => row.capturedAtMs === 5000 && row.disposition === 'suppressed' && row.packet === null) : policy.appliedRevisions.some(zone => zone.revision === 2))
  const retirement: EnvironmentRetirement = { atMs, reason: failure ?? (native.mission.state === 'completed' ? 'native-completed' : native.mission.state === 'aborted' ? 'native-aborted' : native.mission.state === 'blocked' ? 'native-blocked' : 'horizon-ended'), failedAtMs, lastRenderAttemptAtMs: ds.lastRenderAttemptAtMs, lastRenderedAtMs: ds.lastRenderedAtMs, lastObserveAttemptAtMs, closeCount: 1 as const, pendingCapturesRetired, captureContextsCleared, acquisitionRetired: true as const, plantPropagationAfterRetirement: false as const, lastPlantMotorsN: detector.diagnostics.at(-1)?.plantMotorsN ?? null, boardCommandMotorsN: [...mission.boardCommandMotorsN] }
  const expectedOutcome = profile === 'nominal' ? native.mission.state === 'completed' && native.mission.reason === 'landed' : fault.demonstrated
  const reason = failure ?? (!expectedOutcome ? 'native-outcome' : profile === 'nominal' && (counts.lowObservations < 5 || counts.highObservations < 5) ? 'collection-bands' : !boardCommandNeutral ? 'board-command-not-neutral' : null)
  const qualified = profile === 'nominal' ? reason === null : fault.demonstrated
  const summary = { version: 1 as const, profile, evidence: 'owned-environment-physics-simulation' as const, physicalFlightEnabled: false as const, status: (['completed', 'aborted', 'blocked'].includes(native.mission.state) ? native.mission.state : 'incomplete') as 'completed' | 'aborted' | 'blocked' | 'incomplete', reason, qualified, nativeMissionState: native.mission.state, nativeMissionReason: native.mission.reason, observations: observations.length, lowObservations: counts.lowObservations, highObservations: counts.highObservations, deliveredPackets: counts.deliveredPackets, discardedPackets: counts.discardedPackets, lastObservationAtMs: observations.at(-1)?.capturedAtMs ?? null, faultDemonstrated: fault.demonstrated, boardCommandNeutral, acquisitionRetired: true as const, plantPropagationAfterRetirement: false as const, reviewStatus: 'required' as const, dataset: null as DatasetReceipt | null }
  const run: EnvironmentRun = { version: 1 as const, profile, evidence: 'owned-environment-physics-simulation' as const, physicalFlightEnabled: false as const, model, calibration, policy, mission, trace, diagnostics: detector.diagnostics, packets: detector.packets, observations, custody, counts, fault, retirement, summary }
  if (new TextEncoder().encode(compact(run) + '\n').length > 16 * 1024 * 1024 || contextsCreated !== contextsRemoved || counts.renderAttempts - counts.renderedRows < 0 || counts.renderAttempts - counts.renderedRows > 1 || counts.renderAttempts - counts.observeAttempts < 0 || counts.renderAttempts - counts.observeAttempts > 1) return unavailable()
  validateEnvironmentRun(run)
  return structuredClone(run)
}
export function environmentSummary(run: EnvironmentRun, dataset: DatasetReceipt | null = null): EnvironmentSummary {
  const summary = { ...run.summary, dataset }
  if (new TextEncoder().encode(compact(summary) + '\n').length > 16384) return unavailable()
  return summary
}

function wireKeys(value: unknown, names: string): void {
  const fields = names.split(',')
  const record = dataRecord(value, fields)
  if (Object.keys(record).join(',') !== names) return unavailable()
}
function rowBytes(value: unknown, max: number): void { if (new TextEncoder().encode(compact(value) + '\n').length > max) return unavailable() }
/** Validate the one closed owned DTO before cloning or publishing it. No permissive alternate wire shape. */
export function validateEnvironmentRun(value: unknown): asserts value is EnvironmentRun {
  wireKeys(value, 'version,profile,evidence,physicalFlightEnabled,model,calibration,policy,mission,trace,diagnostics,packets,observations,custody,counts,fault,retirement,summary')
  const run = value as EnvironmentRun
  // Bounds and own-data checks precede JSON traversal, cloning and native replay.
  const seen = new Set<object>()
  let nodes = 0, encodedTextBytes = 0
  // Encoded JSON string-token subtotal only, not complete JSON, peak RSS, CPU or preallocation accounting.
  function chargeString(text: string, maxLength: number): void {
    if (text.length > maxLength) return unavailable()
    const bytes = new TextEncoder().encode(compact(text)).length
    if (bytes > environmentLimits.totalBytes - encodedTextBytes) return unavailable()
    encodedTextBytes += bytes
  }
  // Conservative node worksheet: native row64, detector row32, all three capture-linked records128, fixed metadata4096.
  const nodeLimit = environmentLimits.traceRows * 64 + environmentLimits.renders * 32 + environmentLimits.captures * 128 + 4096
  function plain(item: unknown, depth = 0): void {
    if (++nodes > nodeLimit || depth > 12) return unavailable()
    if (typeof item === 'number') { finite(item); return }
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string') { chargeString(item, 4096); return }
    if (!item || typeof item !== 'object' || seen.has(item)) return unavailable()
    seen.add(item)
    if (Array.isArray(item)) { for (const entry of denseArray(item, 6001)) plain(entry, depth + 1) }
    else {
      if (Object.getPrototypeOf(item) !== Object.prototype) return unavailable()
      const d = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(d)
      if (keys.length > 64) return unavailable()
      for (const key of keys) {
        if (typeof key !== 'string' || !d[key]!.enumerable || !('value' in d[key]!)) return unavailable()
        chargeString(key, 64)
        plain(d[key]!.value, depth + 1)
      }
    }
    seen.delete(item)
  }
  plain(value)
  normalizeEnvironmentInput({ profile: run.profile })
  if (run.version !== 1 || run.evidence !== 'owned-environment-physics-simulation' || run.physicalFlightEnabled !== false || compact(run.model) !== compact(environmentModel()) || compact(run.calibration) !== compact(fitEnvironmentCalibration())) return unavailable()
  wireKeys(run.policy, 'version,kind,declaredRevisions,appliedRevisions,guard,nativeFenceChanged,declaredWildlifeDetected,antiPoachingAuthorityEstablished')
  const basePolicy = environmentPolicy(run.profile)
  if (compact({ ...run.policy, appliedRevisions: [] }) !== compact(basePolicy)) return unavailable()
  denseArray(run.policy.appliedRevisions, 2)
  if (compact(run.policy.appliedRevisions) !== compact(basePolicy.declaredRevisions.slice(0, run.policy.appliedRevisions.length))) return unavailable()
  wireKeys(run.mission, 'evidence,physicalFlightEnabled,boardOutputsInhibited,scenario,recovered,budget,result,authorityState,boardCommandMotorsN')
  wireKeys(run.mission.budget, 'worstCaseMs,requiredWh')
  if (run.mission.evidence !== 'owned-mission-physics-simulation' || run.mission.physicalFlightEnabled !== false || run.mission.boardOutputsInhibited !== true || run.mission.scenario !== 'nominal' || run.mission.recovered !== false || compact(run.mission.budget) !== compact({ worstCaseMs: 92000, requiredWh: 200 * 92000 / 3600000 }) || !['disarmed', 'armed-idle', 'autonomous', 'manual', 'failsafe', 'killed'].includes(run.mission.authorityState)) return unavailable()
  const motors = (input: unknown) => denseArray(input, 4, 4).map(n => finite(n, 0, 10))
  motors(run.mission.boardCommandMotorsN)
  const rawTrace = compact(run.trace)
  rowBytes(run.trace, environmentLimits.traceBytes)
  if (compact(parseMissionTrace(rawTrace)) !== rawTrace || compact(run.trace.plan) !== compact(environmentMission()) || run.trace.rows.length === 0) return unavailable()
  for (const [i, row] of run.trace.rows.entries()) {
    if (row.observation.nowMs !== 600 + i * 20 || ![null, 'start', 'abort'].includes(row.action) || row.result.payload !== null || !/^55:[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+$/.test(row.observation.reference)) return unavailable()
    if (row.observation.reference.slice(3).split(',').some(part => !Number.isSafeInteger(Number(part)) || Number(part) > 1e6)) return unavailable()
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(row.result.taskId) || !/^[a-z-]{1,96}$/.test(row.result.reason)) return unavailable()
  }
  if (compact(run.mission.result) !== compact(run.trace.rows.at(-1)!.result)) return unavailable()
  denseArray(run.diagnostics, environmentLimits.renders)
  for (const [i, row] of run.diagnostics.entries()) {
    wireKeys(row, 'atMs,positionM,velocityMps,fieldU,cellU,plantMotorsN')
    if (row.atMs !== 600 + i * 20) return unavailable()
    vector(row.positionM); vector(row.velocityMps); finite(row.fieldU, 0, 100); finite(row.cellU, 0, 100); motors(row.plantMotorsN)
    rowBytes(row, environmentLimits.diagnosticRow)
  }
  denseArray(run.packets, environmentLimits.captures)
  for (const [i, row] of run.packets.entries()) {
    wireKeys(row, 'sequence,capturedAtMs,dueAtMs,packet,disposition,admission,reason')
    if (row.sequence !== i + 1 || row.capturedAtMs !== 600 + i * 100 || row.dueAtMs !== row.capturedAtMs + 60) return unavailable()
    integer(row.capturedAtMs); integer(row.dueAtMs, 660, 100060)
    if (row.disposition === 'delivered') {
      if (!row.packet || !['admitted', 'not-airborne', 'rejected'].includes(row.admission!)) return unavailable()
      const checked = qualifyEnvironmentPacket(row.packet, row, row.dueAtMs, run.calibration)
      if (row.admission === 'rejected' ? row.reason !== (checked.reason ?? 'capture-pose-unqualified') || checked.reason === null && row.capturedAtMs === 600 : checked.reason !== null) return unavailable()
      if (row.admission === 'admitted' ? row.reason !== null : row.admission === 'not-airborne' && row.reason !== (row.capturedAtMs === 600 ? 'initial-ready' : 'not-airborne')) return unavailable()
    }
    else if (row.disposition === 'suppressed' || row.disposition === 'unreceived-on-retirement') {
      if (row.packet !== null || row.admission !== null || row.reason !== (row.disposition === 'suppressed' ? 'profile-suppression' : 'retired-without-receipt') || row.disposition === 'suppressed' && (run.profile !== 'sensor-loss' || row.capturedAtMs < 5000)) return unavailable()
    }
    else return unavailable()
    rowBytes(row, environmentLimits.packetRow)
  }
  denseArray(run.observations, environmentLimits.captures); denseArray(run.custody, environmentLimits.captures)
  if (run.observations.length !== run.custody.length) return unavailable()
  let previous = '0'.repeat(64), sequence = 0
  const admitted = run.packets.filter(row => row.admission === 'admitted')
  if (admitted.length !== run.observations.length) return unavailable()
  for (const [i, row] of run.observations.entries()) {
    wireKeys(row, 'id,sequence,capturedAtMs,receivedAtMs,sourceId,calibrationId,rawSha256,reference,positionM,geodetic,positionSnapshotAtMs,positionMeasurementAtMs,positionPredictedToMs,attitudeMeasurementAtMs,priorMissionObservedAtMs,priorMissionTaskId,valueU,valueAbsBoundU,positionVarianceNedM2,positionClockTravelBoundM,clockUncertaintyMs,band,reviewStatus')
    const packet = admitted[i]!.packet!, nativeRow = run.trace.rows.find(r => r.observation.nowMs === row.capturedAtMs)
    const prior = run.trace.rows.find(r => r.observation.nowMs === row.priorMissionObservedAtMs)
    if (row.sequence <= sequence || row.sequence !== packet.sequence || row.id !== `observation-${String(row.sequence).padStart(4, '0')}` || row.capturedAtMs !== packet.capturedAtMs || row.receivedAtMs !== packet.receivedAtMs || row.sourceId !== 'environment-detector-1' || row.calibrationId !== 'environment-adc-synthetic-v1' || row.rawSha256 !== sha256(compact(packet)) || !nativeRow || row.reference !== nativeRow.observation.reference || compact(row.positionM) !== compact(nativeRow.observation.positionM) || compact(row.geodetic) !== compact(nedToGeodetic(row.positionM, run.model.origin)) || row.positionSnapshotAtMs !== row.capturedAtMs || row.positionPredictedToMs !== row.capturedAtMs || row.priorMissionObservedAtMs !== row.capturedAtMs - 20 || !prior || prior.result.state !== 'running' || row.priorMissionTaskId !== prior.result.taskId) return unavailable()
    finite(row.positionMeasurementAtMs, 0, row.capturedAtMs); finite(row.attitudeMeasurementAtMs, 0, row.capturedAtMs)
    if (row.capturedAtMs - row.positionMeasurementAtMs > 200 || row.capturedAtMs - row.attitudeMeasurementAtMs > 60 || row.positionM[2] > -0.7 || row.valueU !== reduceEnvironmentCount(packet.counts, run.calibration) || row.valueAbsBoundU !== 0.01 + 0.5 / 103 + 0.25 || row.positionVarianceNedM2.some(n => n <= 0) || row.positionClockTravelBoundM !== 0.003 || row.clockUncertaintyMs !== 1 || row.reviewStatus !== 'required' || row.band !== (Math.abs(row.positionM[2] + 1) <= 0.2 ? 'low' : Math.abs(row.positionM[2] + 2) <= 0.2 ? 'high' : 'transit')) return unavailable()
    vector(row.positionVarianceNedM2, 0, 1e6); wireKeys(row.geodetic, 'latitudeDeg,longitudeDeg,ellipsoidHeightM')
    if (compact(run.custody[i]) !== compact(createEnvironmentCustody(row, previous))) return unavailable()
    rowBytes({ observation: row, link: run.custody[i] }, environmentLimits.observationRow)
    previous = run.custody[i]!.sha256; sequence = row.sequence
  }
  wireKeys(run.counts, 'renderAttempts,renderedRows,observeAttempts,scheduledCaptures,deliveredPackets,suppressedPackets,unreceivedPackets,admittedObservations,deliveredNotAdmitted,discardedPackets,lowObservations,highObservations,transitObservations,contextsCreated,contextsRemoved,retirements')
  const c = run.counts
  for (const [name, n] of Object.entries(c)) integer(n, 0, ['renderAttempts', 'renderedRows', 'observeAttempts'].includes(name) ? 5001 : 1001)
  if (c.renderedRows !== run.diagnostics.length || c.scheduledCaptures !== run.packets.length || c.deliveredPackets !== run.packets.filter(row => row.disposition === 'delivered').length || c.suppressedPackets !== run.packets.filter(row => row.disposition === 'suppressed').length || c.unreceivedPackets !== run.packets.filter(row => row.disposition === 'unreceived-on-retirement').length || c.scheduledCaptures !== c.deliveredPackets + c.suppressedPackets + c.unreceivedPackets || c.admittedObservations !== run.observations.length || c.deliveredNotAdmitted !== c.deliveredPackets - c.admittedObservations || c.discardedPackets !== c.scheduledCaptures - c.admittedObservations || c.lowObservations !== run.observations.filter(row => row.band === 'low').length || c.highObservations !== run.observations.filter(row => row.band === 'high').length || c.transitObservations !== run.observations.filter(row => row.band === 'transit').length || c.contextsCreated !== c.contextsRemoved || c.contextsCreated > c.scheduledCaptures || c.retirements !== 1 || ![0, 1].includes(c.renderAttempts - c.renderedRows) || ![0, 1].includes(c.renderAttempts - c.observeAttempts)) return unavailable()
  wireKeys(run.retirement, 'atMs,reason,failedAtMs,lastRenderAttemptAtMs,lastRenderedAtMs,lastObserveAttemptAtMs,closeCount,pendingCapturesRetired,captureContextsCleared,acquisitionRetired,plantPropagationAfterRetirement,lastPlantMotorsN,boardCommandMotorsN')
  const r = run.retirement, finalAt = run.trace.rows.at(-1)!.observation.nowMs
  if (r.atMs !== finalAt || r.lastRenderAttemptAtMs !== finalAt || r.lastRenderedAtMs !== (run.diagnostics.at(-1)?.atMs ?? null) || r.lastObserveAttemptAtMs !== (c.observeAttempts === 0 ? null : 600 + (c.observeAttempts - 1) * 20) || r.closeCount !== 1 || ![0, 1].includes(r.pendingCapturesRetired) || r.pendingCapturesRetired !== c.unreceivedPackets || ![0, 1, 2].includes(r.captureContextsCleared) || r.acquisitionRetired !== true || r.plantPropagationAfterRetirement !== false || compact(r.lastPlantMotorsN) !== compact(run.diagnostics.at(-1)?.plantMotorsN ?? null) || compact(r.boardCommandMotorsN) !== compact(run.mission.boardCommandMotorsN)) return unavailable()
  const nativeStop = run.mission.result.state === 'completed' ? 'native-completed' : run.mission.result.state === 'aborted' ? 'native-aborted' : run.mission.result.state === 'blocked' ? 'native-blocked' : 'horizon-ended'
  if (r.failedAtMs === null ? r.reason !== nativeStop : !environmentFailureReasons.includes(r.reason as EnvironmentFailure) || r.failedAtMs !== finalAt) return unavailable()
  if (run.packets.some(row => row.capturedAtMs > finalAt || row.disposition === 'delivered' && row.dueAtMs > finalAt)) return unavailable()
  for (const row of run.packets.filter(packet => packet.admission === 'rejected')) {
    const final = run.trace.rows.at(-1)!
    // The owned due callback is authoritative even when the rejected raw timestamp is false.
    if (r.reason !== row.reason || r.failedAtMs !== row.dueAtMs || r.atMs !== row.dueAtMs || r.lastObserveAttemptAtMs !== row.dueAtMs || final.observation.nowMs !== row.dueAtMs || final.action !== 'abort' || final.result.state !== 'aborted' || final.result.reason !== 'operator-abort' || run.observations.some(observation => observation.receivedAtMs >= row.dueAtMs)) return unavailable()
  }
  const observedPolicy = r.lastObserveAttemptAtMs === null ? [] : basePolicy.declaredRevisions.filter(zone => zone.effectiveAtMs <= r.lastObserveAttemptAtMs!)
  if (compact(run.policy.appliedRevisions) !== compact(observedPolicy)) return unavailable()
  wireKeys(run.fault, 'kind,scheduledCaptureAtMs,scheduledDecisionAtMs,observedAtMs,priorMissionState,priorMissionObservedAtMs,priorMissionTaskId,nativeDecisionAtMs,nativeState,earlierAirborneObservations,demonstrated')
  const f = run.fault, expectedAt = run.profile === 'sensor-loss' ? 5060 : run.profile === 'site-closure' ? 8000 : null
  if (f.kind !== (run.profile === 'nominal' ? 'none' : run.profile) || f.scheduledCaptureAtMs !== (run.profile === 'sensor-loss' ? 5000 : null) || f.scheduledDecisionAtMs !== expectedAt) return unavailable()
  if (f.observedAtMs === null && [f.priorMissionState, f.priorMissionObservedAtMs, f.priorMissionTaskId, f.nativeDecisionAtMs, f.nativeState].some(v => v !== null)) return unavailable()
  const faultRow = run.trace.rows.find(row => row.observation.nowMs === f.observedAtMs), priorFault = run.trace.rows.find(row => row.observation.nowMs === f.priorMissionObservedAtMs)
  if (f.observedAtMs !== null && (!faultRow || !priorFault || f.priorMissionState !== priorFault.result.state || f.priorMissionTaskId !== priorFault.result.taskId || f.priorMissionObservedAtMs !== f.observedAtMs - 20 || f.nativeDecisionAtMs !== faultRow.observation.nowMs || f.nativeState !== faultRow.result.state)) return unavailable()
  const earlier = f.observedAtMs === null ? 0 : run.observations.filter(row => row.receivedAtMs < f.observedAtMs!).length
  const neutral = run.mission.boardCommandMotorsN.every(n => n === 0)
  const demonstrated = expectedAt !== null && r.reason === (run.profile === 'sensor-loss' ? 'detector-packet-deadline' : 'declared-site-closed') && f.observedAtMs === expectedAt && f.priorMissionState === 'running' && f.priorMissionObservedAtMs === expectedAt - 20 && faultRow?.action === 'abort' && faultRow.result.state === 'aborted' && faultRow.result.reason === 'operator-abort' && earlier >= 1 && run.observations.every(row => row.receivedAtMs < expectedAt) && r.atMs === expectedAt && neutral && (run.profile === 'sensor-loss' ? run.packets.some(row => row.capturedAtMs === 5000 && row.disposition === 'suppressed' && row.packet === null) : run.policy.appliedRevisions.some(zone => zone.revision === 2))
  if (f.earlierAirborneObservations !== earlier || f.demonstrated !== demonstrated) return unavailable()
  const s = run.summary, native = run.mission.result
  wireKeys(s, 'version,profile,evidence,physicalFlightEnabled,status,reason,qualified,nativeMissionState,nativeMissionReason,observations,lowObservations,highObservations,deliveredPackets,discardedPackets,lastObservationAtMs,faultDemonstrated,boardCommandNeutral,acquisitionRetired,plantPropagationAfterRetirement,reviewStatus,dataset')
  const expectedOutcome = run.profile === 'nominal' ? native.state === 'completed' && native.reason === 'landed' : demonstrated
  const expectedReason = r.failedAtMs !== null ? r.reason : !expectedOutcome ? 'native-outcome' : run.profile === 'nominal' && (c.lowObservations < 5 || c.highObservations < 5) ? 'collection-bands' : !neutral ? 'board-command-not-neutral' : null
  if (s.version !== 1 || s.profile !== run.profile || s.evidence !== run.evidence || s.physicalFlightEnabled !== false || s.status !== (['completed', 'aborted', 'blocked'].includes(native.state) ? native.state : 'incomplete') || s.reason !== expectedReason || s.qualified !== (run.profile === 'nominal' ? expectedReason === null : demonstrated) || s.nativeMissionState !== native.state || s.nativeMissionReason !== native.reason || s.observations !== c.admittedObservations || s.lowObservations !== c.lowObservations || s.highObservations !== c.highObservations || s.deliveredPackets !== c.deliveredPackets || s.discardedPackets !== c.discardedPackets || s.lastObservationAtMs !== (run.observations.at(-1)?.capturedAtMs ?? null) || s.faultDemonstrated !== demonstrated || s.boardCommandNeutral !== neutral || s.acquisitionRetired !== true || s.plantPropagationAfterRetirement !== false || s.reviewStatus !== 'required' || s.dataset !== null) return unavailable()
  rowBytes(s, environmentLimits.metadataBytes)
  const skeleton = { ...run, trace: { ...run.trace, rows: [] }, diagnostics: [], packets: [], observations: [], custody: [] }
  rowBytes(skeleton, environmentLimits.metadataBytes); rowBytes(run, environmentLimits.totalBytes)
}
