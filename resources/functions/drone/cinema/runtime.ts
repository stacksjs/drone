import { types as nodeTypes } from 'node:util'
import type { RigidBodyState } from '../controls/physics'
import type { SensorVector } from '../sensors/types'
import type { TaskMotionMissionTrace, TaskMotionMissionDeclaration } from '../missions/engine'
import type { MissionSimulationContext, TaskMotionMissionSimulationContext, TaskMotionMissionSimulationRun } from '../missions/simulation'
import type { VehicleMeasurementPose } from '../vehicles/types'
import type { CinemaActualCapture, CinemaCapture, CinemaEncoder, CinemaFaultCode, CinemaImage, CinemaReason, CinemaRetirement, CinemaRun, CinemaScenario, CinemaSelection, CinemaTarget } from './types'
import { cinemaScenarios } from './types'
import type { CinemaShot } from './types'
import type { GimbalCommandToken, GimbalInhibitCode } from '../payloads/gimbal-authority'
import { createGimbalAuthority } from '../payloads/gimbal-authority'
import type { CinemaManagedRun, CinemaManagedScenario, CinemaManagerEvidence } from './managed-types'
import type { CinemaCountedTranslationAudit, CinemaCountedTranslationJoin, CinemaCountedTranslationRow, CinemaCountedTranslationRun, CinemaCountedTranslationScenario, CinemaCountedReadinessSample, CinemaCountedMoveFault } from './counted-translation-types'
import { simulateMission, simulateTaskMotionMission } from '../missions/simulation'
import { validateMission, validateTaskMotionMission } from '../missions/plan'
import { predictVehicleMeasurementPose, vehicleReference } from '../vehicles/measurements'
import { createModeledCamera } from '../payloads/modeled-camera'
import { cinemaGoal, cinemaOffset, createCinemaGimbal, createCountedCinemaGimbal, evaluateCinemaMotion, withinCinemaTravel } from './gimbal'
import type { CinemaCountedEncoder } from './counted-encoder'
import { cinemaCountedEncoderMethod } from './counted-encoder'
import { cinemaImageQuality, cinemaModel, createCinemaRenderer } from './camera'
export { cinemaScenarios } from './types'
export type { CinemaRun, CinemaScenario } from './types'

const reference = '55:0,0,0,0,0' as const
function captureScenario(input: unknown): CinemaScenario {
  try {
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(input)
    if (keys.some(k => k !== 'scenario') || keys.length > 1) throw new TypeError()
    const descriptor = descriptors.scenario
    if (!descriptor) return 'nominal'
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string' || !cinemaScenarios.includes(descriptor.value as CinemaScenario)) throw new TypeError()
    return descriptor.value as CinemaScenario
  }
  catch { throw new TypeError('cinema-input') }
}
function unavailable(): never { throw new RangeError('cinema-unqualified-result') }
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
function retain<T>(rows: T[], row: T, count: number, cap: number) { if (rows.length >= count || bytes(row) > cap) unavailable(); rows.push(structuredClone(row)) }
function checkDomain(value: unknown, native = false): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) > 1e6 || (!native && JSON.stringify(value).length > 32)) unavailable(); return }
  if (typeof value === 'string') { if (value.length > 256 || /[^ -~]/.test(value)) unavailable(); return }
  if (Array.isArray(value)) { if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1 || value.length > 50000) unavailable(); for (const item of value) checkDomain(item, native); return }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) unavailable()
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) { if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) unavailable(); checkDomain(descriptor.value, native) }
}
type PoseContext = Pick<MissionSimulationContext, 'nowMs' | 'estimate' | 'sensors'>
function originQualified(context: PoseContext): boolean {
  const origin = context.estimate.localPosition?.origin
  return !!origin && origin.latitudeDeg === 0 && origin.longitudeDeg === 0 && origin.ellipsoidHeightM === 100
}
function poseAt(context: PoseContext): VehicleMeasurementPose | null {
  const n = context.nowMs, imu = context.sensors.sensors.find(s => s.kind === 'imu')?.observation
  const pose = predictVehicleMeasurementPose(context.estimate, imu, n)
  return pose && originQualified(context) && pose.positionCapturedAtMs <= n && n - pose.positionCapturedAtMs <= 200 && n - pose.attitudeCapturedAtMs <= 60 && n - pose.gyroCapturedAtMs <= 80 ? pose : null
}
/** One private mission instrument owns all angular tracking and shutter state. */
export function simulateCinema(input: unknown = {}): CinemaRun {
  const scenario = captureScenario(input)
  try { return buildHover(runCore<never, never>(scenario, null, { kind: 'hover' }), scenario) }
  catch { unavailable() }
}
type CoreFault<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault> = { atMs: number, code: CinemaFaultCode | M | T }
type CaptureOptics<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault> = Omit<CinemaCapture, 'reason' | 'encoder'> & { reason: CinemaCapture['reason'] | M | T }
type Measurement = { kind: 'legacy', packet: CinemaEncoder } | { kind: 'counted', packet: CinemaCountedEncoder }
type CoreCapture<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault> = CaptureOptics<M, T> & { measurement: Measurement }
type LegacyCapture<M extends GimbalInhibitCode> = Omit<CinemaCapture, 'reason'> & { reason: CinemaCapture['reason'] | M }
type CoreShot<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault> = Omit<CinemaShot, 'firstFault'> & { firstFault: CoreFault<M, T> | null }
type CoreFacts<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault> = Omit<CinemaRun, 'version' | 'evidence' | 'profile' | 'scenario' | 'mission' | 'reason' | 'shot' | 'captures' | 'encoderObservations'> & { reason: CinemaReason | M | T, shot: CoreShot<M, T>, captures: CoreCapture<M, T>[] }
type CoreHoverRun<M extends GimbalInhibitCode> = Omit<CinemaRun, 'reason' | 'shot' | 'captures'> & { reason: CinemaReason | M, shot: CoreShot<M, never>, captures: LegacyCapture<M>[] }
type NativeEnvelope = { kind: 'hover', mission: CinemaRun['mission'] } | { kind: 'dolly', mission: CinemaCountedTranslationRun['mission'] }
type NativeWorld = { kind: 'hover', result: ReturnType<typeof simulateMission> } | { kind: 'dolly', result: TaskMotionMissionSimulationRun }
type EncoderLedger = { kind: 'legacy', rows: CinemaEncoder[] } | { kind: 'counted', rows: CinemaCountedEncoder[] }
interface CoreOutcome<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault> { encoders: EncoderLedger, facts: CoreFacts<M, T>, native: NativeEnvelope, manager: CinemaManagerEvidence | null, translation: CinemaCountedTranslationAudit | null }
function buildHover<M extends GimbalInhibitCode>(outcome: CoreOutcome<M, never>, scenario: CinemaScenario): CoreHoverRun<M> {
  if (outcome.native.kind !== 'hover' || outcome.encoders.kind !== 'legacy') unavailable()
  const f = outcome.facts
  const run: CoreHoverRun<M> = {
    version: 1, evidence: 'owned-cinema-hover-reframe-simulation', profile: 'hover-poi-reframe-v1', scenario, status: f.status, reason: f.reason,
    physicalFlightEnabled: false, physicalGimbalActuationEnabled: false, identityAuthenticated: false, selection: f.selection, model: f.model, mission: outcome.native.mission,
    shot: f.shot, gimbal: f.gimbal, targetObservations: f.targetObservations, encoderObservations: outcome.encoders.rows, captures: f.captures.map(legacyCapture), reconciliation: f.reconciliation, evaluation: f.evaluation,
  }
  validateRun(run)
  return run
}
function captureFields<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault>(c: CoreCapture<M, T>) {
  return { sequence: c.sequence, state: c.state, reason: c.reason, sessionId: c.sessionId, reference: c.reference, targetId: c.targetId, targetRevision: c.targetRevision, shotOffsetMs: c.shotOffsetMs, issuedAtMs: c.issuedAtMs, capturedAtMs: c.capturedAtMs, deadlineMs: c.deadlineMs, calibrationId: c.calibrationId, exposureLabelUs: c.exposureLabelUs, pose: c.pose }
}
function legacyCapture<M extends GimbalInhibitCode>(c: CoreCapture<M, never>): LegacyCapture<M> {
  if (c.measurement.kind !== 'legacy') unavailable()
  return { ...captureFields(c), encoder: c.measurement.packet, actual: c.actual, image: c.image, ack: c.ack, postStepAdmission: c.postStepAdmission, quality: c.quality }
}
function countedCapture(c: CoreCapture<GimbalInhibitCode, CinemaCountedMoveFault>): CinemaCountedTranslationRun['captures'][number] {
  if (c.measurement.kind !== 'counted') unavailable()
  return { ...captureFields(c), encoder: c.measurement.packet, actual: c.actual, image: c.image, ack: c.ack, postStepAdmission: c.postStepAdmission, quality: c.quality }
}
type MeasurementState = { kind: 'legacy', gimbal: ReturnType<typeof createCinemaGimbal>, packet: CinemaEncoder | null, rows: CinemaEncoder[] } | { kind: 'counted', gimbal: ReturnType<typeof createCountedCinemaGimbal>, packet: CinemaCountedEncoder | null, rows: CinemaCountedEncoder[] }
interface HoverProfile { kind: 'hover' }
interface DollyProfile<T extends CinemaCountedMoveFault> { kind: 'dolly', moveNotReady: Extract<T, 'move-not-ready'>, activeMoveLost: Extract<T, 'active-move-lost'> }
type CoreProfile<T extends CinemaCountedMoveFault> = HoverProfile | DollyProfile<T>
interface ManagedGate<E extends GimbalInhibitCode> {
  step(nowMs: number, startedAtMs: number | null, goal: SensorVector): { goal: SensorVector, fault: E | null, accepted: GimbalCommandToken | null }
  capture(sequence: 1 | 2 | 3, atMs: number): void
  retire(atMs: number): void
  evidence(): CinemaManagerEvidence
}

function captureManagedScenario(input: unknown): CinemaManagedScenario {
  try {
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError()
    const d = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(d)
    if (keys.some(k => k !== 'scenario') || keys.length > 1) throw new TypeError()
    const v = d.scenario
    if (!v) return 'nominal'
    if (!v.enumerable || !Object.hasOwn(v, 'value')) throw new TypeError()
    if (v.value === 'nominal' || v.value === 'source-expiry-with-foreign') return v.value
    throw new TypeError()
  }
  catch { throw new TypeError('cinema-managed-input') }
}
export { cinemaManagedScenarios } from './managed-types'
export type { CinemaManagedRun, CinemaManagedScenario } from './managed-types'
/** Disjoint concrete v2 API; the same single world and controller own both runs. */
export function simulateManagedCinema(input: unknown = {}): CinemaManagedRun {
  const scenario = captureManagedScenario(input)
  try {
    const result = runCore<GimbalInhibitCode, never>('nominal', createManagedGate(scenario), { kind: 'hover' })
    if (!result.manager) unavailable()
    const { evaluation, ...base } = buildHover(result, 'nominal')
    const run: CinemaManagedRun = { ...base, version: 2, evidence: 'owned-managed-cinema-hover-reframe-simulation', profile: 'managed-hover-poi-reframe-v1', scenario, manager: result.manager, evaluation }
    validateRun(run)
    return run
  }
  catch { unavailable() }
}
function createManagedGate(scenario: CinemaManagedScenario, allowEmptyHistory = false): ManagedGate<GimbalInhibitCode> {
  const travel: SensorVector = [20 * Math.PI / 180, 45 * Math.PI / 180, 45 * Math.PI / 180]
  const authority = createGimbalAuthority({ version: 1, sessionId: 'cinema-gimbal-source-v1', epoch: 1, sourceKind: 'autonomy', sourceId: 'cinema-autonomy-v1', reference, maxJointAngleRad: travel })
  const captureCommands: CinemaManagerEvidence['captureCommands'] = [], foreignRejections: CinemaManagerEvidence['foreignRejections'] = []
  let retiredAt: number | null = null
  function step(nowMs: number, startedAtMs: number | null, goal: SensorVector) {
    const previous = authority.snapshot().lastAccepted, offset = startedAtMs === null ? null : nowMs - startedAtMs
    const foreign = scenario === 'source-expiry-with-foreign' && offset === 1000
    const selected = scenario === 'nominal' || offset === null || offset <= 940 || offset === 1020
    const command = foreign ? { version: 1, sessionId: 'cinema-gimbal-source-v1', epoch: 1, sourceKind: 'operator', sourceId: 'foreign-operator-v1', reference, sequence: 1, issuedAtMs: nowMs, leaseMs: 80, mode: 'joint-angle', jointAngleRad: [0, 0, 0] } : selected ? { version: 1, sessionId: 'cinema-gimbal-source-v1', epoch: 1, sourceKind: 'autonomy', sourceId: 'cinema-autonomy-v1', reference, sequence: (previous?.sequence ?? 0) + 1, issuedAtMs: nowMs, leaseMs: 80, mode: 'joint-angle', jointAngleRad: goal } : undefined
    const decision = authority.step({ nowMs, reference, authorityGranted: true, neutralRequested: false, manualOverride: false }, command)
    if (decision.rejection === 'foreign') {
      if (!previous) unavailable()
      retain(foreignRejections, { atMs: nowMs, sourceKind: 'operator', sourceId: 'foreign-operator-v1', selectedIssuedAtMs: previous.issuedAtMs, selectedExpiresAtMs: previous.expiresAtMs, rejection: 'foreign' }, 1, 512)
    }
    const fault = decision.snapshot.firstInhibit?.code ?? null
    if (!fault && !decision.goalRad) unavailable()
    const held: SensorVector = decision.goalRad ?? [0, 0, 0]
    return { goal: held, fault, accepted: decision.commandAccepted ? decision.snapshot.lastAccepted : null }
  }
  function capture(captureSequence: 1 | 2 | 3, atMs: number) {
    const command = authority.snapshot().lastAccepted
    if (!command) unavailable()
    retain(captureCommands, { captureSequence, atMs, command }, 3, 512)
  }
  function retire(atMs: number) { authority.retire(atMs); retiredAt = atMs }
  function evidence(): CinemaManagerEvidence {
    const snapshot = authority.snapshot(), first = snapshot.firstInhibit
    if (retiredAt === null || snapshot.phase !== 'retired' || first && first.atMs === null) unavailable()
    const transitions = snapshot.transitions.map(t => { if (t.atMs === null) unavailable(); return { atMs: t.atMs, from: t.from, to: t.to, reason: t.reason } })
    const out: CinemaManagerEvidence = {
      version: 1, evidence: 'owned-selected-gimbal-source-simulation', physicalActuationEnabled: false, identityAuthenticated: false,
      policy: { profile: 'relative-joint-angle-v1', frame: 'BODY_FRD_RELATIVE_JOINTS', commandAgeMs: 100, minLeaseMs: 20, maxLeaseMs: 100, maxPolicyGapMs: 40, travelRad: [[-travel[0], travel[0]], [-travel[1], travel[1]], [-travel[2], travel[2]]] },
      selection: { kind: 'autonomy', sourceId: 'cinema-autonomy-v1', sessionId: 'cinema-gimbal-source-v1', reference },
      lastAccepted: snapshot.lastAccepted, firstInhibit: first && first.atMs !== null ? { atMs: first.atMs, code: first.code } : null, retirement: { atMs: retiredAt, directive: 'zero-requested-torque' },
      counters: { acceptedCommands: snapshot.counters.acceptedCommands, rejectedForeignCommands: snapshot.counters.rejectedForeignCommands, rejectedSelectedCommands: snapshot.counters.rejectedSelectedCommands, commandsAfterRetirement: 0 }, transitions, captureCommands, foreignRejections,
    }
    const tokenValid = (t: GimbalCommandToken) => t.epoch === 1 && Number.isInteger(t.sequence) && t.sequence >= 1 && t.sequence <= 2251 && t.issuedAtMs >= 0 && t.issuedAtMs <= 45000 && t.expiresAtMs === t.issuedAtMs + 80 && t.goalRad.length === 3 && t.goalRad.every((v, i) => Number.isFinite(v) && Math.abs(v) <= travel[i]!)
    if (snapshot.counters.observations > 2251 || snapshot.counters.rejectedUnattributedCommands !== 0 || out.counters.acceptedCommands > 2251 || out.counters.rejectedForeignCommands > 1 || out.counters.rejectedSelectedCommands > 2251 || (out.lastAccepted ? !tokenValid(out.lastAccepted) : !allowEmptyHistory || out.counters.acceptedCommands !== 0 || out.captureCommands.length !== 0) || out.captureCommands.some(j => !tokenValid(j.command)) || transitions.some(t => t.atMs < 0 || t.atMs > 45000) || first && (first.atMs === null || first.atMs < 0 || first.atMs > 45000) || retiredAt < 0 || retiredAt > 45000) unavailable()
    if (bytes(out.policy) > 1024 || bytes(out.selection) > 512 || bytes(out.lastAccepted) > 512 || bytes(out.firstInhibit) > 256 || bytes(out.retirement) > 128 || bytes(out.counters) > 256 || transitions.length > 16 || transitions.some(t => bytes(t) > 256) || bytes(out) + 1 > 12288) unavailable()
    return structuredClone(out)
  }
  return { step, capture, retire, evidence }
}
function runCore<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault>(scenario: CinemaScenario, gate: ManagedGate<M> | null, profile: CoreProfile<T>): CoreOutcome<M, T> {
  const model = cinemaModel(), position: SensorVector = scenario === 'mechanical-limit' ? [0.1, 4, -1.2] : [4, 0, -1.2]
  const selection: CinemaSelection = { id: 'selected-prop', revision: 1, source: 'synthetic-local-poi', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, reference, positionM: [...position] }
  const validated = profile.kind === 'hover' ? validateMission({ version: 1, id: 'cinema-hover-v1', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.6, tasks: [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 12000, next: 'shot' }, { id: 'shot', kind: 'loiter', positionM: [0, 0, -1.2], durationMs: 10000, timeoutMs: 14000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 12000 }] }) : validateTaskMotionMission({ version: 4, id: 'cinema-dolly-counted-v1', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.6, tasks: [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 10000, next: 'stage' }, { id: 'stage', kind: 'readiness-loiter', positionM: [0, 0, -1.2], durationMs: 1500, timeoutMs: 3000, sourceId: 'cinema-stage-counted-v1', next: 'dolly' }, { id: 'dolly', kind: 'waypoint', speedMps: 0.2, positionM: [2, 0, -1.2], timeoutMs: 12000, next: 'return' }, { id: 'return', kind: 'return', timeoutMs: 12000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 7000 }] })
  const { plan, worstCaseMs } = validated
  if (worstCaseMs !== (profile.kind === 'hover' ? 38000 : 44000)) unavailable()
  const measured: MeasurementState = profile.kind === 'hover' ? { kind: 'legacy', gimbal: createCinemaGimbal(), packet: null, rows: [] } : { kind: 'counted', gimbal: createCountedCinemaGimbal(), packet: null, rows: [] }
  const gimbal = measured.gimbal, renderImage = createCinemaRenderer(model, position)
  let actual: RigidBodyState | null = null, lastNow: number | null = null, encoder: CinemaEncoder | null = null, target: CinemaTarget | null = null
  let capturedImage: CinemaImage | null = null, capturedActual: CinemaActualCapture | null = null
  function exposureAtRequest(): { image: CinemaImage | null, actual: CinemaActualCapture | null } { return { image: capturedImage, actual: capturedActual } }
  const camera = createModeledCamera((body, nowMs) => {
    if (nowMs !== lastNow) unavailable()
    const joint = gimbal.current()
    capturedImage = renderImage(body, joint.positionRad)
    capturedActual = { bodyPositionM: [...body.positionM], bodyQuaternionWxyz: [...body.quaternionWxyz], jointPositionRad: [...joint.positionRad], appliedTorqueNm: [...joint.appliedTorqueNm] }
    return { rgba: Uint8Array.from(capturedImage.rgba), thermalCentiKelvin: null }
  }, { fault: scenario === 'camera-loss' ? 'loss' : scenario === 'wrong-ack' ? 'wrong-ack' : 'none', faultAfterMs: 0 })
  const targets: CinemaTarget[] = [], captures: CoreCapture<M, T>[] = []
  const counters = { trackingCommands: 0, shutterAttempts: 0, ackReceipts: 0, confirmedCaptures: 0, uncertainCaptures: 0, trackingCommandsAfterRetirement: 0, shutterAttemptsAfterRetirement: 0 }
  let loiter: number | null = null, latestStart: number | null = null, readySince: number | null = null, readyCount = 0, started: number | null = null, completed: number | null = null
  let firstFault: CoreFault<M, T> | null = null, retirement: CinemaRetirement | null = null, pending: CoreCapture<M, T> | null = null, invariantFailed = false
  const translationRows: CinemaCountedTranslationRow[] = [], readinessSamples: CinemaCountedReadinessSample[] = []
  type ReleaseCandidate = { declaration: TaskMotionMissionDeclaration, command: GimbalCommandToken }
  let releaseCandidate: ReleaseCandidate | null = null
  function resetReadiness() { readySince = null; readyCount = 0; readyThrough = null; readinessSamples.length = 0 }
  let moveObserved: number | null = null, readyThrough: number | null = null, readyAtEntry: number | null = null
  let previousEncoder: CinemaEncoder | null = null, previousTarget: CinemaTarget | null = null, readyPreviousAt: number | null = null
  function retire(cause: CinemaRetirement['cause'], nowMs: number) {
    if (retirement) return
    if (!actual || lastNow !== nowMs) unavailable()
    retirement = { atMs: nowMs, cause, requestedTorqueNm: [0, 0, 0], bodyPositionM: [...actual.positionM], bodyQuaternionWxyz: [...actual.quaternionWxyz] }
    gimbal.retire(nowMs); camera.close(); gate?.retire(nowMs)
    if (pending) { pending.state = 'uncertain'; pending.reason = firstFault?.code ?? 'capture-pending-at-retirement'; counters.uncertainCaptures++; pending = null }
  }
  function fault(code: CinemaFaultCode | M | T, nowMs: number): 'abort' {
    if (!firstFault) firstFault = { atMs: nowMs, code }
    retire('fault', nowMs)
    return 'abort'
  }
  function observe(context: MissionSimulationContext | TaskMotionMissionSimulationContext): 'abort' | TaskMotionMissionDeclaration | undefined {
    const n = context.nowMs
    if (retirement) return undefined
    if (lastNow !== n || !encoder || !actual) unavailable()
    const priorRunning = context.mission.state === 'running', inLoiter = priorRunning && context.mission.taskId === (profile.kind === 'hover' ? 'shot' : 'stage'), inMove = priorRunning && context.mission.taskId === 'dolly', active = started !== null
    if (profile.kind === 'dolly') {
      // Entry observations are inert facts, retained before any qualification return.
      if (inLoiter && loiter === null) { loiter = n; latestStart = n + 1600 }
      if (inMove && moveObserved === null) { moveObserved = n; readyAtEntry = readyCount }
    }
    if (priorRunning && context.authority !== 'autonomous') return fault('authority-lost', n)
    if (profile.kind === 'hover' && inLoiter && loiter === null) { loiter = n; latestStart = Math.floor((n + 1600) / 40) * 40 }
    if (profile.kind === 'hover' && !active && latestStart !== null && n > latestStart) { retire('window-missed', n); return undefined }
    if (!priorRunning && context.mission.state !== 'ready') { retire('mission-terminal', n); return undefined }
    const pose = poseAt(context)
    if (vehicleReference(context.estimate) !== reference) { if (active || inLoiter || profile.kind === 'dolly' && inMove) return fault('reference-changed', n); return undefined }
    if (!pose) { if (profile.kind === 'hover' || moveObserved === null) { resetReadiness() } if (active || profile.kind === 'dolly' && inMove) return fault('pose-unqualified', n); return undefined }
    if (!target || target.targetId !== selection.id || target.revision !== selection.revision || target.reference !== selection.reference || target.positionSigmaM !== 0.01 || target.clockUncertaintyMs !== 0 || target.capturedAtMs > n || target.receivedAtMs > n || target.receivedAtMs < target.capturedAtMs || target.positionM.some((v, i) => !Number.isFinite(v) || v !== selection.positionM[i]) || (previousTarget && (target.sequence < previousTarget.sequence || target.capturedAtMs < previousTarget.capturedAtMs || target.sequence === previousTarget.sequence && JSON.stringify(target) !== JSON.stringify(previousTarget) || target.sequence > previousTarget.sequence && target.capturedAtMs <= previousTarget.capturedAtMs))) return fault('target-unqualified', n)
    if (n - target.capturedAtMs > 100) return fault('target-stale', n)
    const targetNew = !previousTarget || target.sequence > previousTarget.sequence
    const encoderNew = !previousEncoder || encoder.sequence === previousEncoder.sequence + 1 && encoder.capturedAtMs === previousEncoder.capturedAtMs + 20 && encoder.receivedAtMs === previousEncoder.receivedAtMs + 20
    const encoderValid = encoderNew && encoder.receivedAtMs === n && encoder.capturedAtMs === n - 20 && encoder.positionRad.every(Number.isFinite) && encoder.velocityRadS !== null && encoder.velocityRadS.every(Number.isFinite)
    previousTarget = structuredClone(target); previousEncoder = structuredClone(encoder)
    if (encoder.limitSwitch || !withinCinemaTravel(encoder.positionRad)) { if (active || inLoiter || profile.kind === 'dolly' && inMove) return fault('joint-limit', n); return undefined }
    if (!encoderValid) { if (profile.kind === 'hover' || moveObserved === null) { resetReadiness() } if (active || profile.kind === 'dolly' && inMove) return fault('encoder-unqualified', n); return undefined }
    const velocity = context.estimate.localPosition!.velocityMps
    const settledVehicle = Math.hypot(...velocity) <= 0.15 && Math.hypot(pose.positionM[0], pose.positionM[1], pose.positionM[2] + 1.2) <= 0.15
    if (profile.kind === 'hover' && active && (!inLoiter || !settledVehicle)) return fault('active-loiter-lost', n)
    if (!inLoiter && !(profile.kind === 'dolly' && inMove || profile.kind === 'dolly' && active)) { readySince = null; readyCount = 0; if (profile.kind === 'dolly' && moveObserved === null) { readyThrough = null; readinessSamples.length = 0 } return undefined }
    const offset = started === null ? 0 : cinemaOffset(n - started)
    const goal = cinemaGoal(pose.positionM, pose.quaternionWxyz, target.positionM, offset)
    if (!goal) return fault('pose-unqualified', n)
    if (!withinCinemaTravel(goal)) return fault('joint-goal-limit', n)
    if (profile.kind === 'dolly') {
      if (active) {
        if (!inMove || corridorDistance(pose.positionM) > 0.2) return fault(profile.activeMoveLost, n)
      }
      else {
        if (latestStart === null || n > latestStart) return fault(profile.moveNotReady, n)
        if (inLoiter) {
          const ready = settledVehicle && targetNew && encoder.positionRad.every((v, i) => Math.abs(v - goal[i]!) <= 0.5 * Math.PI / 180) && encoder.velocityRadS!.every(v => Math.abs(v) <= 0.05)
          if (!ready) { resetReadiness() }
          else {
            if (readySince === null || readyPreviousAt !== n - 20) { readySince = n; readyCount = 1; readinessSamples.length = 0 } else readyCount = Math.min(26, readyCount + 1)
            readyThrough = n
            const sample: CinemaCountedReadinessSample = { atMs: n, quaternionWxyz: [...pose.quaternionWxyz], positionCapturedAtMs: pose.positionCapturedAtMs, attitudeCapturedAtMs: pose.attitudeCapturedAtMs, gyroCapturedAtMs: pose.gyroCapturedAtMs }
            checkDomain(sample)
            if (bytes(sample) > 512 || sample.quaternionWxyz.length !== 4 || Math.abs(Math.hypot(...sample.quaternionWxyz) - 1) > 1e-6) unavailable()
            // This is the specified rolling trailing suffix, not eviction from a retained native trace.
            if (readinessSamples.length === 26) readinessSamples.shift()
            readinessSamples.push(sample)
          }
          readyPreviousAt = n
        }
        else if (inMove) {
          if (readyAtEntry !== 26 || readySince === null || readySince > n - 520 || readyThrough !== n - 20 || readinessSamples.length !== 26 || readinessSamples.some((sample, i) => sample.atMs !== n - 520 + i * 20) || n % 20 !== 0) return fault(profile.moveNotReady, n)
          started = n
          if (corridorDistance(pose.positionM) > 0.2) return fault(profile.activeMoveLost, n)
        }
      }
    }
    else if (started === null) {
      const ready = settledVehicle && targetNew && encoder.positionRad.every((v, i) => Math.abs(v - goal[i]!) <= 0.5 * Math.PI / 180) && encoder.velocityRadS!.every(v => Math.abs(v) <= 0.05)
      if (!ready) { readySince = null; readyCount = 0 }
      else { if (readySince === null || readyPreviousAt !== n - 20) { readySince = n; readyCount = 1 } else readyCount = Math.min(26, readyCount + 1) }
      readyPreviousAt = n
      if (readyCount === 26 && n % 40 === 0 && n <= latestStart! && !pending) started = n
    }
    const admitted = gate?.step(n, started, goal)
    if (admitted?.fault) return fault(admitted.fault, n)
    const commandedGoal = admitted?.goal ?? goal
    // Higher-priority context, target and encoder failures above win over an ACK at the same epoch.
    if (pending) {
      const ack = camera.poll(n)
      if (ack) {
        counters.ackReceipts++
        if (ack.reference !== reference && ack.reference !== 'wrong-reference') unavailable()
        pending.ack = { sessionId: ack.sessionId, sequence: ack.sequence, reference: ack.reference, issuedAtMs: ack.issuedAtMs, capturedAtMs: ack.capturedAtMs, acknowledgedAtMs: ack.acknowledgedAtMs, receivedAtMs: n }
        const valid = ack.sessionId === pending.sessionId && ack.sequence === pending.sequence && ack.reference === pending.reference && ack.issuedAtMs === pending.issuedAtMs && ack.capturedAtMs === pending.issuedAtMs && ack.issuedAtMs <= ack.acknowledgedAtMs && ack.acknowledgedAtMs <= n && n <= pending.deadlineMs && ack.acknowledgedAtMs <= pending.deadlineMs && pending.image !== null && pending.image.width === 64 && pending.image.height === 48 && ack.rgba.length === 12288 && ack.thermalCentiKelvin === null && ack.rgba.every((v, i) => v === pending!.image!.rgba[i])
        if (!valid) return fault('ack-scope', n)
        pending.state = 'confirmed'; pending.reason = 'acknowledged'; counters.confirmedCaptures++; pending = null
      }
      else if (n >= pending.deadlineMs) return fault('ack-deadline', n)
    }
    if (started !== null && n === started + 8000) {
      if (captures.length !== 3 || counters.confirmedCaptures !== 3 || pending) return fault('capture-missing', n)
      completed = n; retire('shot-completed', n); return undefined
    }
    if (retirement) { counters.trackingCommandsAfterRetirement++; unavailable() }
    if (measured.kind === 'legacy') { if (!measured.packet) unavailable(); measured.gimbal.command(commandedGoal, measured.packet, n) }
    else measured.gimbal.command(commandedGoal, n)
    counters.trackingCommands++
    if (profile.kind === 'dolly' && inLoiter && readyCount === 26 && latestStart !== null && n <= latestStart - 20) {
      const m = context.mission, command = admitted?.accepted
      if (m.version !== 4 || m.runStartedAtMs === null || m.taskEnteredAtMs === null || !command || command.issuedAtMs !== n || command.expiresAtMs !== n + 80) unavailable()
      const declaration: TaskMotionMissionDeclaration = { version: 1, planId: plan.id, runStartedAtMs: m.runStartedAtMs, taskId: m.taskId, taskEnteredAtMs: m.taskEnteredAtMs, sourceId: 'cinema-stage-counted-v1', reference: vehicleReference(context.estimate), observedAtMs: n, ready: true }
      releaseCandidate = { declaration, command: structuredClone(command) }
      return declaration
    }
    if (started !== null) {
      const relative = n - started
      if (relative === 1000 || relative === 3000 || relative === 7000) {
        if (pending || captures.length >= 3) unavailable()
        if (retirement) { counters.shutterAttemptsAfterRetirement++; unavailable() }
        const capture: CoreCapture<M, T> = { sequence: captures.length === 0 ? 1 : captures.length === 1 ? 2 : 3, state: 'uncertain', reason: 'capture-pending-at-retirement', sessionId: 'cinema-hover-v1', reference, targetId: 'selected-prop', targetRevision: 1, shotOffsetMs: relative, issuedAtMs: n, capturedAtMs: null, deadlineMs: n + 80, calibrationId: 'synthetic-cinema-forward-v1', exposureLabelUs: 1000, pose: structuredClone(pose), measurement: measured.kind === 'legacy' ? { kind: 'legacy', packet: structuredClone(measured.packet ?? unavailable()) } : { kind: 'counted', packet: structuredClone(measured.packet ?? unavailable()) }, actual: null, image: null, ack: null, postStepAdmission: 'valid', quality: cinemaImageQuality(null, offset) }
        captures.push(capture); gate?.capture(capture.sequence, n); pending = capture; counters.shutterAttempts++; capturedImage = null; capturedActual = null
        try {
          camera.request({ sessionId: capture.sessionId, sequence: capture.sequence, issuedAtMs: n, reference })
          const exposed = exposureAtRequest()
          if (!exposed.image || !exposed.actual) unavailable()
          capture.capturedAtMs = n; capture.actual = structuredClone(exposed.actual); capture.image = structuredClone(exposed.image); capture.quality = cinemaImageQuality(capture.image, offset)
        }
        catch {
          if (profile.kind === 'dolly') unavailable()
          return fault('shutter-failed', n)
        }
      }
    }
    return undefined
  }
  const instrument = {
    render(state: RigidBodyState, nowMs: number) {
      if (retirement) return
      try {
        if (measured.kind === 'legacy') { measured.packet = measured.gimbal.render(nowMs); retain(measured.rows, measured.packet, 2251, 512) }
        else { measured.packet = measured.gimbal.render(nowMs); retain(measured.rows, measured.packet, 2251, 512) }
        encoder = measured.packet; actual = structuredClone(state); lastNow = nowMs
        if (!(scenario === 'target-loss' && started !== null && nowMs > started + 900)) {
          target = { sequence: targets.length + 1, capturedAtMs: nowMs, receivedAtMs: nowMs, targetId: 'selected-prop', revision: 1, reference, positionM: [...position], positionSigmaM: 0.01, clockUncertaintyMs: 0 }; retain(targets, target, 2251, 640)
        }
        if (profile.kind === 'dolly' && started !== null) {
          const row: CinemaCountedTranslationRow = { atMs: nowMs, positionM: [...state.positionM], velocityMps: [...state.velocityMps], accelerationMps2: [...state.accelerationMps2], quaternionWxyz: [...state.quaternionWxyz] }
          checkDomain(row)
          if (row.quaternionWxyz.length !== 4 || Math.abs(Math.hypot(...row.quaternionWxyz) - 1) > 1e-6) unavailable()
          retain(translationRows, row, 400, 768)
        }
        camera.render(state, nowMs)
      }
      catch { invariantFailed = true; unavailable() }
    },
  }
  let execution: NativeWorld
  try {
    if (profile.kind === 'hover') execution = { kind: 'hover', result: simulateMission({ plan, scenario: scenario === 'rc-override' ? 'rc-override' : 'nominal', seconds: 45, instrument: {
    disturbance(nowMs) {
      if (scenario !== 'body-disturbance' || started === null || retirement) return {}
      const r = nowMs - started - 400
      if (r < 0 || r >= 6000) return {}
      const e = Math.sin(Math.PI * r / 6000) ** 2
      return { torqueNm: [0.0005 * e * Math.sin(2 * Math.PI * r / 1000), 0.0004 * e * Math.sin(2 * Math.PI * r / 1400), 0] }
    },
      render: instrument.render,
      observe(context) { try { const value = observe(context); if (value !== undefined && value !== 'abort') unavailable(); return value } catch { invariantFailed = true; unavailable() } },
    } }) }
    else execution = { kind: 'dolly', result: simulateTaskMotionMission({ plan, seconds: 45, instrument: { render: instrument.render, observe(context) { try { return observe(context) } catch { invariantFailed = true; unavailable() } } } }) }
  const result = execution.result, taskTrace = execution.kind === 'dolly' ? execution.result.trace : null
  if (invariantFailed || lastNow === null || !actual) { if (!retirement) camera.close(); unavailable() }
  if (!retirement) {
    if (lastNow === 45000 && ['running', 'paused'].includes(result.mission.state)) {
      if (started !== null) fault('horizon-exhausted', lastNow)
      else retire('horizon-exhausted', lastNow)
    }
    else retire('mission-terminal', lastNow)
  }
  const tail = gimbal.tail()
  const reconciliation = { invalidCaptureSequences: [] as number[], earliestInvalidAtMs: null as number | null }
  const rows = new Map(result.trace.rows.map(row => [row.observation.nowMs, row]))
  const admitted = (atMs: number) => {
    const row = rows.get(atMs), o = row?.observation
    return !!row && !!o && o.healthy && o.authority === 'autonomous' && o.reference === reference && o.origin.latitudeDeg === 0 && o.origin.longitudeDeg === 0 && o.origin.ellipsoidHeightM === 100 && row.result.state === 'running' && row.result.taskId === (profile.kind === 'hover' ? 'shot' : 'dolly')
  }
  let startAdmission = true
  const translation: CinemaCountedTranslationAudit | null = taskTrace ? makeTranslationAudit(translationRows, taskTrace, moveObserved, readyThrough, readyAtEntry, readinessSamples) : null
  const candidate = (() : ReleaseCandidate | null => releaseCandidate)()
  if (translation && taskTrace && candidate) {
    const d = taskTrace.rows.find(row => row.observation.nowMs === translation.timeline.moveEnteredAtMs), previous = taskTrace.rows.find(row => row.observation.nowMs === candidate.declaration.observedAtMs - 20)
    if (d && d.observation.nowMs === candidate.declaration.observedAtMs && d.result.state === 'running' && d.result.taskId === 'dolly' && d.result.taskEnteredAtMs === d.observation.nowMs && d.action === null && previous?.result.state === 'running' && previous.result.taskId === 'stage' && JSON.stringify(d.readiness) === JSON.stringify(candidate.declaration) && !translationJoin(taskTrace, d.observation.nowMs, 'start')) translation.releaseCommand = structuredClone(candidate.command)
  }
  if (started !== null && profile.kind === 'hover') {
    const entry = result.trace.rows.find(row => row.result.state === 'running' && row.result.taskId === (profile.kind === 'hover' ? 'shot' : 'dolly'))
    startAdmission = loiter !== null && entry?.observation.nowMs === loiter - 20 && latestStart === Math.floor((loiter + 1600) / 40) * 40 && started <= latestStart && admitted(started)
  }
  if (translation && taskTrace && started !== null) {
    translation.timeline.startAdmission = 'valid'
    const s = started, d = rows.get(s - 20), previous = rows.get(s - 40)
    const entryValid = loiter !== null && translation.timeline.stageEnteredAtMs === loiter - 20 && translation.timeline.moveEnteredAtMs === s - 20 && moveObserved === s && latestStart === loiter + 1600 && s <= latestStart && d?.action === null && d?.result.state === 'running' && d.result.taskId === 'dolly' && previous?.result.state === 'running' && previous.result.taskId === 'stage' && readyAtEntry === 26 && readyThrough === s - 20 && readySince !== null && readySince <= s - 520 && translation.releaseCommand?.issuedAtMs === s - 20 && readinessSamples.length === 26 && readinessSamples.every((sample, i) => sample.atMs === s - 520 + i * 20)
    let prefixValid = true
    for (let n = s - 520; n <= s - 20; n += 20) {
      const row = rows.get(n), o = row?.observation
      if (!row || !o?.healthy || o.authority !== 'autonomous' || o.reference !== reference || o.origin.latitudeDeg !== 0 || o.origin.longitudeDeg !== 0 || o.origin.ellipsoidHeightM !== 100 || row.action !== null || row.result.state !== 'running' || row.result.taskId !== (n === s - 20 ? 'dolly' : 'stage')) prefixValid = false
    }
    const invalid = translationJoin(taskTrace, s, 'start')
    if (!entryValid || !prefixValid || invalid) {
      startAdmission = false; translation.timeline.startAdmission = 'invalid'
      recordInvalidJoin(translation, invalid ?? { atMs: s, kind: 'start', reason: 'entry-transition' })
    }
  }
  for (const capture of captures) {
    const invalid = [capture.issuedAtMs, ...(capture.ack ? [capture.ack.receivedAtMs] : [])].filter(n => !admitted(n))
    if (translation && taskTrace) {
      for (const [epoch, kind] of [[capture.issuedAtMs, 'exposure'], ...(capture.ack ? [[capture.ack.receivedAtMs, 'ack']] as const : [])] as const) {
        const invalidJoin = translationJoin(taskTrace, epoch, kind)
        if (invalidJoin) recordInvalidJoin(translation, invalidJoin)
      }
    }
    if (invalid.length || !startAdmission) {
      capture.postStepAdmission = 'invalid'; reconciliation.invalidCaptureSequences.push(capture.sequence)
      const first = Math.min(...(invalid.length ? invalid : [started!]))
      reconciliation.earliestInvalidAtMs = reconciliation.earliestInvalidAtMs === null ? first : Math.min(first, reconciliation.earliestInvalidAtMs)
      if (capture.state === 'confirmed') { capture.state = 'uncertain'; capture.reason = 'mission-step-rejected'; counters.confirmedCaptures--; counters.uncertainCaptures++ }
    }
  }
  if (translation && taskTrace && completed !== null) {
    const invalid = translationJoin(taskTrace, completed, 'normal-close')
    translation.timeline.normalCloseAdmission = invalid ? 'invalid' : 'valid'
    if (invalid) recordInvalidJoin(translation, invalid)
  }
  const gimbalRows = gimbal.rows
  const motion = evaluateCinemaMotion(gimbalRows, tail)
  const opticalErrors = captures.flatMap(c => c.quality.errorPx === null ? [] : [c.quality.errorPx])
  const frames = { exposed: captures.filter(c => c.image !== null).length, confirmed: captures.filter(c => c.state === 'confirmed').length, qualified: captures.filter(c => c.state === 'confirmed' && c.postStepAdmission === 'valid' && c.quality.qualified).length, maxErrorPx: opticalErrors.length ? Math.max(...opticalErrors) : null }
  const neutral = result.board.motorsN.every(n => n === 0)
  let status: CinemaRun['status'] = 'completed', reason: CinemaReason | M | T = 'qualified'
  const retainedFault = (() : CoreFault<M, T> | null => firstFault)()
  const retainedRetirement = (() : CinemaRetirement | null => retirement)()
  if (!retainedRetirement) unavailable()
  if (retainedFault) { status = 'halted'; reason = retainedFault.code }
  else if (!startAdmission || reconciliation.invalidCaptureSequences.length || translation?.timeline.normalCloseAdmission === 'invalid') { status = 'failed'; reason = 'admission-reconciliation' }
  else if (started === null) { status = 'incomplete'; reason = retainedRetirement.cause === 'window-missed' ? 'readiness-window-missed' : 'shot-incomplete' }
  else if (completed === null) { status = 'incomplete'; reason = 'shot-incomplete' }
  else if (result.mission.state !== 'completed' || result.mission.reason !== 'landed') { status = 'failed'; reason = 'mission-not-completed' }
  else if (!neutral) { status = 'failed'; reason = 'mission-nonneutral' }
  else if (!motion.withinDynamicBounds || !motion.withinMechanicalBounds) { status = 'failed'; reason = 'motion-bounds' }
  else if (captures.length !== 3 || frames.confirmed !== 3 || frames.qualified !== 3) { status = 'failed'; reason = 'frame-quality' }
  const facts: CoreFacts<M, T> = {
    status, reason, physicalFlightEnabled: false, physicalGimbalActuationEnabled: false, identityAuthenticated: false, selection, model,

    shot: { phase: firstFault ? 'fault' : completed !== null ? 'completed' : started !== null || retainedRetirement.cause === 'window-missed' ? 'incomplete' : 'not-started', loiterObservedAtMs: loiter, latestStartMs: latestStart, readySinceMs: readySince, readySampleCount: readyCount, startedAtMs: started, completedAtMs: completed, reference: started === null ? null : reference, firstFault: retainedFault, retirement: retainedRetirement, counters },
    gimbal: { rows: gimbalRows, tail }, targetObservations: targets, captures, reconciliation, evaluation: { motion, frames, qualified: status === 'completed' },
  }
  const native: NativeEnvelope = execution.kind === 'hover' ? { kind: 'hover', mission: { trace: execution.result.trace, terminalState: execution.result.mission.state, terminalReason: execution.result.mission.reason, boardMotorsN: [...execution.result.board.motorsN], boardFault: execution.result.board.fault, boardNeutral: neutral, finalTruthPositionM: [...execution.result.finalTruthPositionM] } } : { kind: 'dolly', mission: { trace: execution.result.trace, terminalState: execution.result.mission.state, terminalReason: execution.result.mission.reason, boardMotorsN: [...execution.result.board.motorsN], boardFault: execution.result.board.fault, boardNeutral: neutral, finalTruthPositionM: [...execution.result.finalTruthPositionM] } }
  if (translation) fillTranslationMetrics(translation, facts)
  return { facts, native, encoders: measured.kind === 'legacy' ? { kind: 'legacy', rows: measured.rows } : { kind: 'counted', rows: measured.rows }, manager: gate?.evidence() ?? null, translation }
  }
  finally {
    camera.close()
    if (!retirement && lastNow !== null) { gimbal.retire(lastNow); gate?.retire(lastNow) }
  }
}
function validateRun(run: CoreHoverRun<GimbalInhibitCode> | CinemaManagedRun | CinemaCountedTranslationRun): void {
  const { model, captures, reconciliation, selection } = run, gimbal = run.gimbal, tail = run.gimbal.tail, targets = run.targetObservations, encoders = run.encoderObservations, counters = run.shot.counters
  checkDomain(run)
  if (run.mission.trace.rows.length > 6001 || bytes(run.mission.trace) + 1 > 8388608 || bytes(model) > 16384 || bytes(run) + 1 > 20971520) unavailable()
  for (const row of [...run.gimbal.rows, ...run.gimbal.tail]) if (bytes(row) > 768) unavailable()
  for (const capture of captures) if (bytes(capture) > 65536 || capture.image && (capture.image.rgba.length !== 12288 || !capture.image.rgba.every(n => Number.isInteger(n) && n >= 0 && n <= 255) || bytes(capture.image.rgba) > 49154)) unavailable()
  const { mission, ...cinema } = run
  const metadata = { ...mission, trace: null }
  const separators = Math.max(0, gimbal.rows.length - 1) + tail.length - 1 + Math.max(0, targets.length - 1) + Math.max(0, encoders.length - 1) + Math.max(0, captures.length - 1) + 1
  const quaternionValid = (q: number[]) => q.length === 4 && q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) <= 1e-6
  if (!quaternionValid(run.shot.retirement.bodyQuaternionWxyz) || captures.some(c => !quaternionValid(c.pose.quaternionWxyz) || c.actual && !quaternionValid(c.actual.bodyQuaternionWxyz))) unavailable()
  const nativeCode = (code: string) => /^[a-z][a-z0-9-]{0,95}$/.test(code)
  if (!nativeCode(mission.terminalReason) || mission.boardFault !== null && !nativeCode(mission.boardFault) || mission.trace.rows.some(r => !nativeCode(r.result.reason) || r.observation.nowMs > 45000)) unavailable()
  if (separators > 32768 || bytes({ ...cinema, mission: metadata }) + 1 > 12582912 || bytes({ selection, shot: run.shot, evaluation: run.evaluation, reconciliation, mission: { ...mission, trace: null } }) > 32768) unavailable()
  if (counters.trackingCommandsAfterRetirement !== 0 || counters.shutterAttemptsAfterRetirement !== 0) unavailable()
}

export { cinemaCountedTranslationScenarios } from './counted-translation-types'
export type { CinemaCountedTranslationRun, CinemaCountedTranslationScenario } from './counted-translation-types'
function captureCountedTranslationScenario(input: unknown): CinemaCountedTranslationScenario {
  try {
    if (!input || typeof input !== 'object' || nodeTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError()
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors)
    if (keys.length > 1 || keys.some(k => k !== 'scenario')) throw new TypeError()
    const d = descriptors.scenario
    if (!d) return 'nominal'
    if (!d.enumerable || !Object.hasOwn(d, 'value')) throw new TypeError()
    if (d.value === 'nominal' || d.value === 'source-expiry-with-foreign') return d.value
    throw new TypeError()
  }
  catch { throw new TypeError('cinema-counted-translation-input') }
}
/** One finite translating profile over the same native world, source manager and instrument. */
export function simulateCountedTranslatingCinema(input: unknown = {}): CinemaCountedTranslationRun {
  const scenario = captureCountedTranslationScenario(input)
  try {
    const result = runCore<GimbalInhibitCode, CinemaCountedMoveFault>('nominal', createManagedGate(scenario, true), { kind: 'dolly', moveNotReady: 'move-not-ready', activeMoveLost: 'active-move-lost' })
    if (!result.manager || !result.translation || result.native.kind !== 'dolly' || result.encoders.kind !== 'counted') unavailable()
    const { evaluation, ...base } = result.facts, translation = result.translation
    let status = base.status, reason: CinemaCountedTranslationRun['reason'] = base.reason
    if (scenario === 'nominal' && status === 'completed') {
      const m = translation.metrics
      const observed = m.captureForwardDisplacementM !== null && m.captureForwardDisplacementM >= 0.5 && m.captureForwardSpeedMps !== null && m.captureForwardSpeedMps.every(v => v > 0)
      m.nominalWitness = observed ? 'satisfied' : 'failed'
      if (!observed) { status = 'failed'; reason = 'translation-not-observed' }
    }
    if (scenario === 'source-expiry-with-foreign') {
      const m = translation.metrics
      if (m.firstExposureForwardDisplacementM !== null && m.firstExposureForwardSpeedMps !== null) m.sourceMotionWitness = m.firstExposureForwardDisplacementM > 0 && m.firstExposureForwardSpeedMps > 0 ? 'satisfied' : 'failed'
    }
    const run: CinemaCountedTranslationRun = {
      version: 4, evidence: 'owned-cinema-counted-dolly-simulation', profile: 'straight-poi-dolly-counted-v1', scenario, status, reason,
      physicalFlightEnabled: false, physicalGimbalActuationEnabled: false, identityAuthenticated: false, selection: base.selection, model: { ...base.model, encoderMeasurement: { ...cinemaCountedEncoderMethod } }, mission: result.native.mission,
      shot: base.shot, gimbal: base.gimbal, targetObservations: base.targetObservations, encoderObservations: result.encoders.rows, captures: base.captures.map(countedCapture), reconciliation: base.reconciliation, manager: result.manager, translation, evaluation: { ...evaluation, qualified: status === 'completed' },
    }
    validateCountedMeasurements(run)
    validateTranslation(run)
    validateRun(run)
    return run
  }
  catch { unavailable() }
}
function corridorDistance(p: SensorVector): number { return Math.hypot(p[0] - Math.max(0, Math.min(2, p[0])), p[1], p[2] + 1.2) }
function makeTranslationAudit(rows: CinemaCountedTranslationRow[], trace: TaskMotionMissionTrace, observed: number | null, readyThrough: number | null, countAtEntry: number | null, samples: CinemaCountedReadinessSample[]): CinemaCountedTranslationAudit {
  const entry = (task: string) => trace.rows.find(r => r.result.state === 'running' && r.result.taskId === task)?.observation.nowMs ?? null
  return {
    version: 3, evidence: 'owned-cinema-translation-audit', frame: 'LOCAL_NED', fromM: [0, 0, -1.2], toM: [2, 0, -1.2], planDefaultSpeedMps: trace.plan.speedMps,
    taskRates: trace.plan.tasks.map(task => { if (!('speedMps' in task)) unavailable(); return { taskId: task.id, kind: task.kind, speedMps: task.speedMps } }),
    policy: { kind: 'native-waypoint-speed-ramp', stageTaskId: 'stage', moveTaskId: 'dolly', startGridMs: 20, maxMoveEntryAfterStageMs: 1600, movingEstimatedCorridorM: 0.2, shotDurationMs: 8000, truthCadenceMs: 20, truthFirstOffsetMs: 20, jerkQualification: 'unqualified-at-4ms', handshake: { nativeVersion: 4, readinessSourceId: 'cinema-stage-counted-v1', minimumDwellMs: 1500, taskTimeoutMs: 3000, posePrediction: 'qualified-gyro-hold', predictedEpoch: 'current-policy-epoch', encoderMethod: 'count-difference-v1' } },
    timeline: { stageEnteredAtMs: entry('stage'), moveEnteredAtMs: entry('dolly'), moveObservedAtMs: observed, readyThroughAtMs: readyThrough, readySamplesAtEntry: countAtEntry, startAdmission: 'not-started', normalCloseAdmission: 'not-attempted', firstInvalidJoin: null },
    readinessSamples: structuredClone(samples), releaseCommand: null,
    metrics: { sampleCount: rows.length, durationMs: null, forwardDisplacementM: null, maxCrossTrackM: null, maxSpeedMps: null, maxAccelerationMps2: null, maxSampledJerkMps3: null, captureForwardDisplacementM: null, captureForwardSpeedMps: null, firstExposureForwardDisplacementM: null, firstExposureForwardSpeedMps: null, nominalWitness: 'not-evaluated', sourceMotionWitness: 'not-evaluated' },
    smoothnessQualified: false, rows,
  }
}
function translationJoin(trace: TaskMotionMissionTrace, atMs: number, kind: CinemaCountedTranslationJoin['kind']): CinemaCountedTranslationJoin | null {
  const row = trace.rows.find(r => r.observation.nowMs === atMs), o = row?.observation
  const reason = !row || !o ? 'missing-row' : !o.healthy ? 'unhealthy' : o.authority !== 'autonomous' ? 'authority' : o.reference !== reference ? 'reference' : o.origin.latitudeDeg !== 0 || o.origin.longitudeDeg !== 0 || o.origin.ellipsoidHeightM !== 100 ? 'origin' : row.result.state !== 'running' ? 'state' : row.result.taskId !== 'dolly' ? 'task' : null
  return reason ? { atMs, kind, reason } : null
}
function recordInvalidJoin(audit: CinemaCountedTranslationAudit, join: CinemaCountedTranslationJoin) {
  const previous = audit.timeline.firstInvalidJoin, order = ['start', 'exposure', 'ack', 'normal-close']
  if (!previous || join.atMs < previous.atMs || join.atMs === previous.atMs && order.indexOf(join.kind) < order.indexOf(previous.kind)) audit.timeline.firstInvalidJoin = join
}
function fillTranslationMetrics<M extends GimbalInhibitCode, T extends CinemaCountedMoveFault>(audit: CinemaCountedTranslationAudit, run: CoreFacts<M, T>) {
  const rows = audit.rows, m = audit.metrics, first = rows[0], last = rows.at(-1)
  if (first && last) {
    m.durationMs = last.atMs - first.atMs
    m.maxCrossTrackM = Math.max(...rows.map(r => corridorDistance(r.positionM)))
    m.maxSpeedMps = Math.max(...rows.map(r => Math.hypot(...r.velocityMps)))
    m.maxAccelerationMps2 = Math.max(...rows.map(r => Math.hypot(...r.accelerationMps2)))
    if (rows.length >= 2) {
      m.forwardDisplacementM = last.positionM[0] - first.positionM[0]
      m.maxSampledJerkMps3 = Math.max(...rows.slice(1).map((r, i) => Math.hypot(...r.accelerationMps2.map((n, axis) => (n - rows[i]!.accelerationMps2[axis]!) / 0.020))))
    }
  }
  const captureRows = run.captures.map(c => {
    if (!c.actual || c.capturedAtMs === null) return null
    const row = rows.find(r => r.atMs === c.capturedAtMs)
    return row && row.positionM.every((n, i) => n === c.actual!.bodyPositionM[i]) && row.quaternionWxyz.every((n, i) => n === c.actual!.bodyQuaternionWxyz[i]) ? row : null
  })
  const one = captureRows[0], two = captureRows[1], three = captureRows[2]
  if (one && first && first.atMs < one.atMs) { m.firstExposureForwardDisplacementM = one.positionM[0] - first.positionM[0]; m.firstExposureForwardSpeedMps = one.velocityMps[0] }
  if (captureRows.length === 3 && one && two && three) { m.captureForwardDisplacementM = three.positionM[0] - one.positionM[0]; m.captureForwardSpeedMps = [one.velocityMps[0], two.velocityMps[0], three.velocityMps[0]] }
}
function validateTranslation(run: CinemaCountedTranslationRun) {
  const audit = run.translation, timeline = audit.timeline, metrics = audit.metrics, rows = audit.rows, s = run.shot.startedAtMs
  const keys = (value: object, expected: string[]) => { if (JSON.stringify(Object.keys(value)) !== JSON.stringify(expected)) unavailable() }
  keys(run, ['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'physicalGimbalActuationEnabled', 'identityAuthenticated', 'selection', 'model', 'mission', 'shot', 'gimbal', 'targetObservations', 'encoderObservations', 'captures', 'reconciliation', 'manager', 'translation', 'evaluation'])
  keys(audit, ['version', 'evidence', 'frame', 'fromM', 'toM', 'planDefaultSpeedMps', 'taskRates', 'policy', 'timeline', 'readinessSamples', 'releaseCommand', 'metrics', 'smoothnessQualified', 'rows'])
  keys(audit.policy, ['kind', 'stageTaskId', 'moveTaskId', 'startGridMs', 'maxMoveEntryAfterStageMs', 'movingEstimatedCorridorM', 'shotDurationMs', 'truthCadenceMs', 'truthFirstOffsetMs', 'jerkQualification', 'handshake'])
  keys(audit.policy.handshake, ['nativeVersion', 'readinessSourceId', 'minimumDwellMs', 'taskTimeoutMs', 'posePrediction', 'predictedEpoch', 'encoderMethod'])
  keys(timeline, ['stageEnteredAtMs', 'moveEnteredAtMs', 'moveObservedAtMs', 'readyThroughAtMs', 'readySamplesAtEntry', 'startAdmission', 'normalCloseAdmission', 'firstInvalidJoin'])
  keys(metrics, ['sampleCount', 'durationMs', 'forwardDisplacementM', 'maxCrossTrackM', 'maxSpeedMps', 'maxAccelerationMps2', 'maxSampledJerkMps3', 'captureForwardDisplacementM', 'captureForwardSpeedMps', 'firstExposureForwardDisplacementM', 'firstExposureForwardSpeedMps', 'nominalWitness', 'sourceMotionWitness'])
  const epoch = (n: number | null) => n === null || Number.isSafeInteger(n) && n >= 0 && n <= 45000
  if (![timeline.stageEnteredAtMs, timeline.moveEnteredAtMs, timeline.moveObservedAtMs, timeline.readyThroughAtMs].every(epoch) || timeline.readySamplesAtEntry !== null && (!Number.isInteger(timeline.readySamplesAtEntry) || timeline.readySamplesAtEntry < 0 || timeline.readySamplesAtEntry > 26)) unavailable()
  if (timeline.firstInvalidJoin) { keys(timeline.firstInvalidJoin, ['atMs', 'kind', 'reason']); if (!epoch(timeline.firstInvalidJoin.atMs)) unavailable() }
  if (rows.length > 400 || rows.length !== metrics.sampleCount || s === null && rows.length !== 0) unavailable()
  for (const [i, row] of rows.entries()) {
    keys(row, ['atMs', 'positionM', 'velocityMps', 'accelerationMps2', 'quaternionWxyz'])
    if (!epoch(row.atMs) || s === null || row.atMs !== s + (i + 1) * 20 || row.atMs > run.shot.retirement.atMs || bytes(row) > 768 || row.positionM.length !== 3 || row.velocityMps.length !== 3 || row.accelerationMps2.length !== 3 || row.quaternionWxyz.length !== 4 || Math.abs(Math.hypot(...row.quaternionWxyz) - 1) > 1e-6) unavailable()
  }
  if (bytes({ ...audit, rows: [], readinessSamples: [], releaseCommand: null }) > 4096 || bytes(audit) + 1 > 393216) unavailable()
  // Representation-only reserve: rows + closed metadata + separators/LF + wrapper growth.
  if (400 * 768 + 4096 + 399 + 1 + 4096 + 15360 + 1024 > 393216 || 11913600 + 393216 > 12582912 || 11913600 + 393216 + 8388608 > 20971520) unavailable()
  if (audit.version !== 3 || audit.planDefaultSpeedMps !== 0.6 || audit.planDefaultSpeedMps !== run.mission.trace.plan.speedMps || bytes(audit.taskRates) > 512 || audit.taskRates.length !== 5) unavailable()
  const expectedTasks = ['takeoff', 'stage', 'dolly', 'return', 'land'], expectedKinds = ['takeoff', 'readiness-loiter', 'waypoint', 'return', 'land'], expectedRates = [0.6, 0.6, 0.2, 0.6, 0.6]
  for (const [i, task] of audit.taskRates.entries()) {
    keys(task, ['taskId', 'kind', 'speedMps'])
    const native = run.mission.trace.plan.tasks[i]
    if (!native || !('speedMps' in native) || task.taskId !== native.id || task.kind !== native.kind || task.speedMps !== native.speedMps || task.taskId !== expectedTasks[i] || task.kind !== expectedKinds[i] || task.speedMps !== expectedRates[i]) unavailable()
  }
  if (audit.readinessSamples.length > 26) unavailable()
  for (const [i, sample] of audit.readinessSamples.entries()) {
    keys(sample, ['atMs', 'quaternionWxyz', 'positionCapturedAtMs', 'attitudeCapturedAtMs', 'gyroCapturedAtMs'])
    if (!epoch(sample.atMs) || sample.atMs % 20 !== 0 || i > 0 && sample.atMs !== audit.readinessSamples[i - 1]!.atMs + 20 || sample.quaternionWxyz.length !== 4 || Math.abs(Math.hypot(...sample.quaternionWxyz) - 1) > 1e-6 || bytes(sample) > 512) unavailable()
    for (const [capture, age] of [[sample.positionCapturedAtMs, 200], [sample.attitudeCapturedAtMs, 60], [sample.gyroCapturedAtMs, 80]]) if (capture === undefined || age === undefined || !Number.isFinite(capture) || capture < 0 || capture > sample.atMs || sample.atMs - capture > age) unavailable()
  }
  if (audit.releaseCommand) {
    const token = audit.releaseCommand
    keys(token, ['epoch', 'sequence', 'issuedAtMs', 'expiresAtMs', 'goalRad'])
    if (token.epoch !== 1 || !Number.isInteger(token.sequence) || token.sequence < 1 || token.sequence > 2251 || token.issuedAtMs !== timeline.moveEnteredAtMs || token.expiresAtMs !== token.issuedAtMs + 80 || !withinCinemaTravel(token.goalRad) || bytes(token) > 512 || bytes(token) + 1 > 1024) unavailable()
  }
  // Only literal wrapper growth is measured here; no fake legacy envelope containing a native4 trace.
  if (bytes({ version: run.version, evidence: run.evidence, profile: run.profile, translation: null }) > 4096) unavailable()
}

function validateCountedMeasurements(run: CinemaCountedTranslationRun): void {
  const method = run.model.encoderMeasurement
  if (JSON.stringify(method) !== JSON.stringify(cinemaCountedEncoderMethod) || method.quantumRad !== run.model.gimbal.encoderQuantumRad || method.intervalMs !== run.model.clock.policyStepMs || method.delayMs !== run.model.clock.encoderDelayMs || bytes(method) > 512) unavailable()
  const packets = run.encoderObservations
  if (packets.length > 2251) unavailable()
  for (const [i, packet] of packets.entries()) {
    if (JSON.stringify(Object.keys(packet)) !== JSON.stringify(['version', 'sequence', 'capturedAtMs', 'receivedAtMs', 'positionCounts', 'deltaCounts', 'positionRad', 'velocityRadS', 'limitSwitch']) || packet.version !== 1 || packet.sequence !== i + 1 || packet.receivedAtMs !== 600 + i * 20 || packet.capturedAtMs !== packet.receivedAtMs - 20 || packet.receivedAtMs > run.shot.retirement.atMs || bytes(packet) > 512 || packet.positionCounts.length !== 3 || packet.positionCounts.some(n => !Number.isSafeInteger(n) || Object.is(n, -0) || Math.abs(n) > 8000) || packet.positionRad.length !== 3 || packet.positionRad.some((n, axis) => n !== packet.positionCounts[axis]! * 0.001)) unavailable()
    if (i === 0) { if (packet.deltaCounts !== null || packet.velocityRadS !== null) unavailable() }
    else {
      const previous = packets[i - 1]!
      if (!packet.deltaCounts || !packet.velocityRadS || packet.deltaCounts.length !== 3 || packet.velocityRadS.length !== 3 || packet.deltaCounts.some((n, axis) => !Number.isSafeInteger(n) || Math.abs(n) > 16000 || n !== packet.positionCounts[axis]! - previous.positionCounts[axis]!) || packet.velocityRadS.some((n, axis) => n !== packet.deltaCounts![axis]! * 0.05)) unavailable()
    }
  }
  for (const capture of run.captures) {
    const packet = packets.find(p => p.receivedAtMs === capture.issuedAtMs)
    if (!packet || JSON.stringify(capture.encoder) !== JSON.stringify(packet)) unavailable()
  }
}
