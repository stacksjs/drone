import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { cinemaModel } from '../../resources/functions/drone/cinema/camera'
import * as cinema from '../../resources/functions/drone/cinema/runtime'
import { parseTaskMotionMissionTrace, replayTaskMotionMission } from '../../resources/functions/drone/missions/engine'
import { validateTaskMotionMission } from '../../resources/functions/drone/missions/plan'
import type { CinemaCountedTranslationRun } from '../../resources/functions/drone/cinema/counted-translation-types'

// The saved first result stays unknown. Finite readers construct local facts without a result cast.
const METHOD = { version: 1, method: 'count-difference-v1', quantumRad: 0.001, intervalMs: 20, delayMs: 20, rateUnitRadS: 0.05, countLimit: 8000, deltaLimit: 16000, rounding: 'nearest-ties-positive' }
const faults = ['authority-lost', 'pose-unqualified', 'reference-changed', 'target-unqualified', 'target-stale', 'joint-goal-limit', 'encoder-unqualified', 'joint-limit', 'ack-scope', 'ack-deadline', 'shutter-failed', 'active-loiter-lost', 'capture-missing', 'horizon-exhausted'] as const
const inhibits = ['gimbal-source-expired', 'gimbal-command-invalid', 'gimbal-command-replay', 'gimbal-observation-invalid', 'gimbal-reference-changed', 'gimbal-clock-discontinuity', 'gimbal-policy-gap', 'gimbal-manual-override', 'gimbal-operator-neutral', 'gimbal-authority-unavailable', 'gimbal-counter-exhausted'] as const
const moveFaults = ['move-not-ready', 'active-move-lost'] as const
const nativeReasons = ['awaiting-operator-start', 'operator-start', 'task-entered', 'battery-branch', 'simulated-payload-trigger', 'mission-abort-task', 'landed', 'mission-schedule-gap', 'estimator-reference-changed', 'estimator-loss', 'mission-fence-breach', 'authority-revoked', 'mission-battery-reserve', 'mission-endurance-exhausted', 'invalid-observation-or-clock', 'mission-start-interlocks', 'task-timeout', 'invalid-readiness-release', 'mission-trace-capacity', 'operator-abort'] as const
const boardFaults = ['board-clock-discontinuity', 'output-lease-expired', 'invalid-output-frame', 'board-watchdog'] as const
const allFaults = [...faults, ...inhibits, ...moveFaults] as const
const reasons = [...allFaults, 'qualified', 'readiness-window-missed', 'shot-incomplete', 'mission-not-completed', 'mission-nonneutral', 'admission-reconciliation', 'frame-quality', 'motion-bounds', 'translation-not-observed'] as const
function invalid(): never { throw new Error('invalid-saved-counted-cinema') }
function isRecord(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype }
function object(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(v) || JSON.stringify(Reflect.ownKeys(v)) !== JSON.stringify(keys)) return invalid()
  for (const key of keys) { const d = Object.getOwnPropertyDescriptor(v, key); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid() }
  return v
}
function field(v: unknown, key: string): unknown {
  if (!isRecord(v)) return invalid()
  const d = Object.getOwnPropertyDescriptor(v, key)
  if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid()
  return d.value
}
function dense(v: unknown, max: number, exact?: number): unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return invalid()
  const length = Object.getOwnPropertyDescriptor(v, 'length')
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > max || exact !== undefined && length.value !== exact) return invalid()
  const expected = Array.from({ length: length.value }, (_, i) => String(i)); expected.push('length')
  if (JSON.stringify(Reflect.ownKeys(v)) !== JSON.stringify(expected)) return invalid()
  const out: unknown[] = []
  for (let i = 0; i < length.value; i++) { const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid(); out.push(d.value) }
  return out
}
function walk(v: unknown, path = '$', active = new Set<object>()): void {
  if (v === null || typeof v === 'boolean') return
  if (typeof v === 'number') { if (!Number.isFinite(v) || Math.abs(v) > 1e6 || !path.startsWith('$.mission.trace') && JSON.stringify(v).length > 32) invalid(); return }
  if (typeof v === 'string') { if (v.length > 256 || /[^ -~]/.test(v)) invalid(); return }
  if (!v || typeof v !== 'object' || active.has(v)) return invalid()
  active.add(v)
  try {
    if (Array.isArray(v)) { for (const [i, x] of dense(v, 50000).entries()) walk(x, `${path}[${i}]`, active); return }
    if (!isRecord(v)) return invalid()
    for (const k of Reflect.ownKeys(v)) { if (typeof k !== 'string') return invalid(); const d = Object.getOwnPropertyDescriptor(v, k); if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid(); walk(d.value, `${path}.${k}`, active) }
  }
  finally { active.delete(v) }
}
function number(v: unknown, min = -1e6, max = 1e6): number { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return invalid(); return v }
function integer(v: unknown, min: number, max: number): number { const n = number(v, min, max); if (!Number.isSafeInteger(n)) return invalid(); return n }
function epoch(v: unknown, max = 45000): number { return integer(v, 0, max) }
function text(v: unknown, max = 256): string { if (typeof v !== 'string' || v.length > max || /[^ -~]/.test(v)) return invalid(); return v }
function bool(v: unknown): boolean { if (typeof v !== 'boolean') return invalid(); return v }
function literal<T extends string | number | boolean | null>(v: unknown, expected: T): T { if (!Object.is(v, expected)) return invalid(); return expected }
function enumeration<const T extends readonly (string | number)[]>(v: unknown, values: T): T[number] { const found = values.find(x => x === v); if (found === undefined) return invalid(); return found }
function nullable<T>(v: unknown, reader: (v: unknown) => T): T | null { return v === null ? null : reader(v) }
function list<T>(v: unknown, max: number, reader: (v: unknown) => T, exact?: number): T[] { return dense(v, max, exact).map(value => reader(value)) }
function vector(v: unknown): V3 { const a = dense(v, 3, 3); return [number(a[0]), number(a[1]), number(a[2])] }
function quaternion(v: unknown): [number, number, number, number] { const a = dense(v, 4, 4); const q: [number, number, number, number] = [number(a[0]), number(a[1]), number(a[2]), number(a[3])]; if (Math.abs(Math.hypot(...q) - 1) > 1e-6) return invalid(); return q }
function equalLiteral(v: unknown, expected: unknown): void { if (JSON.stringify(v) !== JSON.stringify(expected)) invalid() }
function readToken(v: unknown) {
  const o = object(v, ['epoch', 'sequence', 'issuedAtMs', 'expiresAtMs', 'goalRad'])
  const out = { epoch: literal(o.epoch, 1), sequence: integer(o.sequence, 1, 2251), issuedAtMs: epoch(o.issuedAtMs), expiresAtMs: epoch(o.expiresAtMs, 45080), goalRad: vector(o.goalRad) }
  if (out.expiresAtMs !== out.issuedAtMs + 80 || out.goalRad.some((n, i) => Math.abs(n) > [20, 45, 45][i]! * Math.PI / 180) || byteLength(v) > 512) return invalid()
  return out
}
function countVector(v: unknown, max: number, rejectNegativeZero: boolean): V3 { const a = dense(v, 3, 3); const at = (i: number) => { const n = integer(a[i], -max, max); if (rejectNegativeZero && Object.is(n, -0)) return invalid(); return n }; return [at(0), at(1), at(2)] }
function readEncoder(v: unknown) {
  const o = object(v, ['version', 'sequence', 'capturedAtMs', 'receivedAtMs', 'positionCounts', 'deltaCounts', 'positionRad', 'velocityRadS', 'limitSwitch'])
  const out = { version: literal(o.version, 1), sequence: integer(o.sequence, 1, 2251), capturedAtMs: integer(o.capturedAtMs, 580, 44980), receivedAtMs: integer(o.receivedAtMs, 600, 45000), positionCounts: countVector(o.positionCounts, 8000, true), deltaCounts: nullable(o.deltaCounts, v => countVector(v, 16000, false)), positionRad: vector(o.positionRad), velocityRadS: nullable(o.velocityRadS, vector), limitSwitch: bool(o.limitSwitch) }
  if (out.receivedAtMs !== 600 + (out.sequence - 1) * 20 || out.capturedAtMs !== out.receivedAtMs - 20 || byteLength(v) > 512) return invalid()
  return out
}
function readPlant(v: unknown) { const o = object(v, ['atMs', 'requestedAtMs', 'requestedTorqueNm', 'appliedTorqueNm', 'positionRad', 'velocityRadS', 'accelerationRadS2']); return { atMs: epoch(o.atMs, 47000), requestedAtMs: epoch(o.requestedAtMs), requestedTorqueNm: vector(o.requestedTorqueNm), appliedTorqueNm: vector(o.appliedTorqueNm), positionRad: vector(o.positionRad), velocityRadS: vector(o.velocityRadS), accelerationRadS2: vector(o.accelerationRadS2) } }
function readTarget(v: unknown) { const o = object(v, ['sequence', 'capturedAtMs', 'receivedAtMs', 'targetId', 'revision', 'reference', 'positionM', 'positionSigmaM', 'clockUncertaintyMs']); return { sequence: integer(o.sequence, 1, 2251), capturedAtMs: epoch(o.capturedAtMs), receivedAtMs: epoch(o.receivedAtMs), targetId: literal(o.targetId, 'selected-prop'), revision: literal(o.revision, 1), reference: literal(o.reference, '55:0,0,0,0,0'), positionM: vector(o.positionM), positionSigmaM: literal(o.positionSigmaM, 0.01), clockUncertaintyMs: literal(o.clockUncertaintyMs, 0) } }
function readPose(v: unknown) { const o = object(v, ['reference', 'capturedAtMs', 'positionM', 'quaternionWxyz', 'positionCapturedAtMs', 'positionPredictedToMs', 'attitudeCapturedAtMs', 'attitudePredictedToMs', 'gyroCapturedAtMs', 'attitudePrediction']); return { reference: literal(o.reference, '55:0,0,0,0,0'), capturedAtMs: number(o.capturedAtMs, 0, 45000), positionM: vector(o.positionM), quaternionWxyz: quaternion(o.quaternionWxyz), positionCapturedAtMs: number(o.positionCapturedAtMs, 0, 45000), positionPredictedToMs: number(o.positionPredictedToMs, 0, 45000), attitudeCapturedAtMs: number(o.attitudeCapturedAtMs, 0, 45000), attitudePredictedToMs: number(o.attitudePredictedToMs, 0, 45000), gyroCapturedAtMs: number(o.gyroCapturedAtMs, 0, 45000), attitudePrediction: literal(o.attitudePrediction, 'qualified-gyro-hold') } }
function readAck(v: unknown) { const o = object(v, ['sessionId', 'sequence', 'reference', 'issuedAtMs', 'capturedAtMs', 'acknowledgedAtMs', 'receivedAtMs']); return { sessionId: text(o.sessionId, 128), sequence: integer(o.sequence, 1, 3), reference: enumeration(o.reference, ['55:0,0,0,0,0', 'wrong-reference']), issuedAtMs: epoch(o.issuedAtMs), capturedAtMs: epoch(o.capturedAtMs), acknowledgedAtMs: epoch(o.acknowledgedAtMs), receivedAtMs: epoch(o.receivedAtMs) } }
function readActual(v: unknown) { const o = object(v, ['bodyPositionM', 'bodyQuaternionWxyz', 'jointPositionRad', 'appliedTorqueNm']); return { bodyPositionM: vector(o.bodyPositionM), bodyQuaternionWxyz: quaternion(o.bodyQuaternionWxyz), jointPositionRad: vector(o.jointPositionRad), appliedTorqueNm: vector(o.appliedTorqueNm) } }
function readImage(v: unknown) { const o = object(v, ['width', 'height', 'rgba']); return { width: literal(o.width, 64), height: literal(o.height, 48), rgba: list(o.rgba, 12288, v => integer(v, 0, 255), 12288) } }
function readQuality(v: unknown) { const o = object(v, ['expectedPixel', 'observedPixel', 'errorPx', 'markerPixels', 'qualified']); const pixel = (v: unknown): [number, number] => { const a = dense(v, 2, 2); return [number(a[0]), number(a[1])] }; return { expectedPixel: pixel(o.expectedPixel), observedPixel: nullable(o.observedPixel, pixel), errorPx: nullable(o.errorPx, v => number(v, 0)), markerPixels: integer(o.markerPixels, 0, 3072), qualified: bool(o.qualified) } }
function readCapture(v: unknown) { const o = object(v, ['sequence', 'state', 'reason', 'sessionId', 'reference', 'targetId', 'targetRevision', 'shotOffsetMs', 'issuedAtMs', 'capturedAtMs', 'deadlineMs', 'calibrationId', 'exposureLabelUs', 'pose', 'encoder', 'actual', 'image', 'ack', 'postStepAdmission', 'quality']); const out = { sequence: enumeration(o.sequence, [1, 2, 3]), state: enumeration(o.state, ['confirmed', 'uncertain']), reason: enumeration(o.reason, ['acknowledged', ...allFaults, 'mission-step-rejected', 'capture-pending-at-retirement']), sessionId: literal(o.sessionId, 'cinema-hover-v1'), reference: literal(o.reference, '55:0,0,0,0,0'), targetId: literal(o.targetId, 'selected-prop'), targetRevision: literal(o.targetRevision, 1), shotOffsetMs: enumeration(o.shotOffsetMs, [1000, 3000, 7000]), issuedAtMs: epoch(o.issuedAtMs), capturedAtMs: nullable(o.capturedAtMs, epoch), deadlineMs: epoch(o.deadlineMs, 45080), calibrationId: literal(o.calibrationId, 'synthetic-cinema-forward-v1'), exposureLabelUs: literal(o.exposureLabelUs, 1000), pose: readPose(o.pose), encoder: readEncoder(o.encoder), actual: nullable(o.actual, readActual), image: nullable(o.image, readImage), ack: nullable(o.ack, readAck), postStepAdmission: enumeration(o.postStepAdmission, ['valid', 'invalid']), quality: readQuality(o.quality) }; if (out.deadlineMs !== out.issuedAtMs + 80) return invalid(); return out }
function readRetirement(v: unknown) { const o = object(v, ['atMs', 'cause', 'requestedTorqueNm', 'bodyPositionM', 'bodyQuaternionWxyz']); equalLiteral(o.requestedTorqueNm, [0, 0, 0]); return { atMs: epoch(o.atMs), cause: enumeration(o.cause, ['shot-completed', 'fault', 'window-missed', 'mission-terminal', 'horizon-exhausted']), requestedTorqueNm: vector(o.requestedTorqueNm), bodyPositionM: vector(o.bodyPositionM), bodyQuaternionWxyz: quaternion(o.bodyQuaternionWxyz) } }
function readShot(v: unknown) {
  const o = object(v, ['phase', 'loiterObservedAtMs', 'latestStartMs', 'readySinceMs', 'readySampleCount', 'startedAtMs', 'completedAtMs', 'reference', 'firstFault', 'retirement', 'counters']), c = object(o.counters, ['trackingCommands', 'shutterAttempts', 'ackReceipts', 'confirmedCaptures', 'uncertainCaptures', 'trackingCommandsAfterRetirement', 'shutterAttemptsAfterRetirement'])
  return { phase: enumeration(o.phase, ['not-started', 'completed', 'fault', 'incomplete']), loiterObservedAtMs: nullable(o.loiterObservedAtMs, epoch), latestStartMs: nullable(o.latestStartMs, v => epoch(v, 46600)), readySinceMs: nullable(o.readySinceMs, epoch), readySampleCount: integer(o.readySampleCount, 0, 26), startedAtMs: nullable(o.startedAtMs, epoch), completedAtMs: nullable(o.completedAtMs, epoch), reference: nullable(o.reference, v => literal(v, '55:0,0,0,0,0')), firstFault: nullable(o.firstFault, v => { const f = object(v, ['atMs', 'code']); return { atMs: epoch(f.atMs), code: enumeration(f.code, allFaults) } }), retirement: readRetirement(o.retirement), counters: { trackingCommands: integer(c.trackingCommands, 0, 2251), shutterAttempts: integer(c.shutterAttempts, 0, 3), ackReceipts: integer(c.ackReceipts, 0, 3), confirmedCaptures: integer(c.confirmedCaptures, 0, 3), uncertainCaptures: integer(c.uncertainCaptures, 0, 3), trackingCommandsAfterRetirement: literal(c.trackingCommandsAfterRetirement, 0), shutterAttemptsAfterRetirement: literal(c.shutterAttemptsAfterRetirement, 0) } }
}
function readManager(v: unknown) {
  const o = object(v, ['version', 'evidence', 'physicalActuationEnabled', 'identityAuthenticated', 'policy', 'selection', 'lastAccepted', 'firstInhibit', 'retirement', 'counters', 'transitions', 'captureCommands', 'foreignRejections'])
  const travel = [20, 45, 45].map(n => [-n * Math.PI / 180, n * Math.PI / 180])
  equalLiteral(o.policy, { profile: 'relative-joint-angle-v1', frame: 'BODY_FRD_RELATIVE_JOINTS', commandAgeMs: 100, minLeaseMs: 20, maxLeaseMs: 100, maxPolicyGapMs: 40, travelRad: travel })
  equalLiteral(o.selection, { kind: 'autonomy', sourceId: 'cinema-autonomy-v1', sessionId: 'cinema-gimbal-source-v1', reference: '55:0,0,0,0,0' })
  const c = object(o.counters, ['acceptedCommands', 'rejectedForeignCommands', 'rejectedSelectedCommands', 'commandsAfterRetirement']), ret = object(o.retirement, ['atMs', 'directive'])
  for (const [value, cap] of [[o.policy, 1024], [o.selection, 512], [o.lastAccepted, 512], [o.firstInhibit, 256], [o.retirement, 128], [o.counters, 256]] as const) if (byteLength(value) > cap) invalid()
  if (byteLength(v) + 1 > 12288) invalid()
  return { version: literal(o.version, 1), evidence: literal(o.evidence, 'owned-selected-gimbal-source-simulation'), physicalActuationEnabled: literal(o.physicalActuationEnabled, false), identityAuthenticated: literal(o.identityAuthenticated, false), policy: o.policy, selection: o.selection, lastAccepted: nullable(o.lastAccepted, readToken), firstInhibit: nullable(o.firstInhibit, v => { const f = object(v, ['atMs', 'code']); return { atMs: epoch(f.atMs), code: enumeration(f.code, inhibits) } }), retirement: { atMs: epoch(ret.atMs), directive: literal(ret.directive, 'zero-requested-torque') }, counters: { acceptedCommands: integer(c.acceptedCommands, 0, 2251), rejectedForeignCommands: integer(c.rejectedForeignCommands, 0, 1), rejectedSelectedCommands: integer(c.rejectedSelectedCommands, 0, 2251), commandsAfterRetirement: literal(c.commandsAfterRetirement, 0) }, transitions: list(o.transitions, 16, v => { const t = object(v, ['atMs', 'from', 'to', 'reason']); if (byteLength(v) > 256) invalid(); return { atMs: epoch(t.atMs), from: enumeration(t.from, ['waiting', 'active', 'inhibited', 'retired']), to: enumeration(t.to, ['waiting', 'active', 'inhibited', 'retired']), reason: enumeration(t.reason, ['selected-command', ...inhibits, 'session-retired']) } }), captureCommands: list(o.captureCommands, 3, v => { const t = object(v, ['captureSequence', 'atMs', 'command']); if (byteLength(v) > 512) invalid(); return { captureSequence: enumeration(t.captureSequence, [1, 2, 3]), atMs: epoch(t.atMs), command: readToken(t.command) } }), foreignRejections: list(o.foreignRejections, 1, v => { const t = object(v, ['atMs', 'sourceKind', 'sourceId', 'selectedIssuedAtMs', 'selectedExpiresAtMs', 'rejection']); if (byteLength(v) > 512) invalid(); return { atMs: epoch(t.atMs), sourceKind: literal(t.sourceKind, 'operator'), sourceId: literal(t.sourceId, 'foreign-operator-v1'), selectedIssuedAtMs: epoch(t.selectedIssuedAtMs), selectedExpiresAtMs: epoch(t.selectedExpiresAtMs, 45080), rejection: literal(t.rejection, 'foreign') } }) }
}
function readAudit(v: unknown) {
  const o = object(v, ['version', 'evidence', 'frame', 'fromM', 'toM', 'planDefaultSpeedMps', 'taskRates', 'policy', 'timeline', 'readinessSamples', 'releaseCommand', 'metrics', 'smoothnessQualified', 'rows'])
  equalLiteral(o.fromM, [0, 0, -1.2]); equalLiteral(o.toM, [2, 0, -1.2])
  const p = object(o.policy, ['kind', 'stageTaskId', 'moveTaskId', 'startGridMs', 'maxMoveEntryAfterStageMs', 'movingEstimatedCorridorM', 'shotDurationMs', 'truthCadenceMs', 'truthFirstOffsetMs', 'jerkQualification', 'handshake'])
  const h = object(p.handshake, ['nativeVersion', 'readinessSourceId', 'minimumDwellMs', 'taskTimeoutMs', 'posePrediction', 'predictedEpoch', 'encoderMethod'])
  const t = object(o.timeline, ['stageEnteredAtMs', 'moveEnteredAtMs', 'moveObservedAtMs', 'readyThroughAtMs', 'readySamplesAtEntry', 'startAdmission', 'normalCloseAdmission', 'firstInvalidJoin'])
  const m = object(o.metrics, ['sampleCount', 'durationMs', 'forwardDisplacementM', 'maxCrossTrackM', 'maxSpeedMps', 'maxAccelerationMps2', 'maxSampledJerkMps3', 'captureForwardDisplacementM', 'captureForwardSpeedMps', 'firstExposureForwardDisplacementM', 'firstExposureForwardSpeedMps', 'nominalWitness', 'sourceMotionWitness'])
  return { version: literal(o.version, 3), evidence: literal(o.evidence, 'owned-cinema-translation-audit'), frame: literal(o.frame, 'LOCAL_NED'), fromM: vector(o.fromM), toM: vector(o.toM), planDefaultSpeedMps: literal(o.planDefaultSpeedMps, 0.6), taskRates: list(o.taskRates, 5, v => { const t = object(v, ['taskId', 'kind', 'speedMps']); return { taskId: enumeration(t.taskId, ['takeoff', 'stage', 'dolly', 'return', 'land']), kind: enumeration(t.kind, ['takeoff', 'readiness-loiter', 'waypoint', 'return', 'land']), speedMps: enumeration(t.speedMps, [0.6, 0.2]) } }, 5), policy: { kind: literal(p.kind, 'native-waypoint-speed-ramp'), stageTaskId: literal(p.stageTaskId, 'stage'), moveTaskId: literal(p.moveTaskId, 'dolly'), startGridMs: literal(p.startGridMs, 20), maxMoveEntryAfterStageMs: literal(p.maxMoveEntryAfterStageMs, 1600), movingEstimatedCorridorM: literal(p.movingEstimatedCorridorM, 0.2), shotDurationMs: literal(p.shotDurationMs, 8000), truthCadenceMs: literal(p.truthCadenceMs, 20), truthFirstOffsetMs: literal(p.truthFirstOffsetMs, 20), jerkQualification: literal(p.jerkQualification, 'unqualified-at-4ms'), handshake: { nativeVersion: literal(h.nativeVersion, 4), readinessSourceId: literal(h.readinessSourceId, 'cinema-stage-counted-v1'), minimumDwellMs: literal(h.minimumDwellMs, 1500), taskTimeoutMs: literal(h.taskTimeoutMs, 3000), posePrediction: literal(h.posePrediction, 'qualified-gyro-hold'), predictedEpoch: literal(h.predictedEpoch, 'current-policy-epoch'), encoderMethod: literal(h.encoderMethod, 'count-difference-v1') } }, timeline: { stageEnteredAtMs: nullable(t.stageEnteredAtMs, epoch), moveEnteredAtMs: nullable(t.moveEnteredAtMs, epoch), moveObservedAtMs: nullable(t.moveObservedAtMs, epoch), readyThroughAtMs: nullable(t.readyThroughAtMs, epoch), readySamplesAtEntry: nullable(t.readySamplesAtEntry, v => integer(v, 0, 26)), startAdmission: enumeration(t.startAdmission, ['not-started', 'valid', 'invalid']), normalCloseAdmission: enumeration(t.normalCloseAdmission, ['not-attempted', 'valid', 'invalid']), firstInvalidJoin: nullable(t.firstInvalidJoin, v => { const j = object(v, ['atMs', 'kind', 'reason']); return { atMs: epoch(j.atMs), kind: enumeration(j.kind, ['start', 'exposure', 'ack', 'normal-close']), reason: enumeration(j.reason, ['missing-row', 'unhealthy', 'authority', 'reference', 'origin', 'state', 'task', 'entry-transition']) } }) }, readinessSamples: list(o.readinessSamples, 26, v => { const s = object(v, ['atMs', 'quaternionWxyz', 'positionCapturedAtMs', 'attitudeCapturedAtMs', 'gyroCapturedAtMs']); return { atMs: epoch(s.atMs), quaternionWxyz: quaternion(s.quaternionWxyz), positionCapturedAtMs: number(s.positionCapturedAtMs, 0, 45000), attitudeCapturedAtMs: number(s.attitudeCapturedAtMs, 0, 45000), gyroCapturedAtMs: number(s.gyroCapturedAtMs, 0, 45000) } }), releaseCommand: nullable(o.releaseCommand, readToken), metrics: { sampleCount: integer(m.sampleCount, 0, 400), durationMs: nullable(m.durationMs, v => number(v, 0, 8000)), forwardDisplacementM: nullable(m.forwardDisplacementM, number), maxCrossTrackM: nullable(m.maxCrossTrackM, number), maxSpeedMps: nullable(m.maxSpeedMps, number), maxAccelerationMps2: nullable(m.maxAccelerationMps2, number), maxSampledJerkMps3: nullable(m.maxSampledJerkMps3, number), captureForwardDisplacementM: nullable(m.captureForwardDisplacementM, number), captureForwardSpeedMps: nullable(m.captureForwardSpeedMps, vector), firstExposureForwardDisplacementM: nullable(m.firstExposureForwardDisplacementM, number), firstExposureForwardSpeedMps: nullable(m.firstExposureForwardSpeedMps, number), nominalWitness: enumeration(m.nominalWitness, ['not-evaluated', 'satisfied', 'failed']), sourceMotionWitness: enumeration(m.sourceMotionWitness, ['not-evaluated', 'satisfied', 'failed']) }, smoothnessQualified: literal(o.smoothnessQualified, false), rows: list(o.rows, 400, v => { const t = object(v, ['atMs', 'positionM', 'velocityMps', 'accelerationMps2', 'quaternionWxyz']); return { atMs: epoch(t.atMs), positionM: vector(t.positionM), velocityMps: vector(t.velocityMps), accelerationMps2: vector(t.accelerationMps2), quaternionWxyz: quaternion(t.quaternionWxyz) } }) }
}
function decodeRun(v: unknown, commonModel: Record<string, unknown>) {
  walk(v)
  const o = object(v, ['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'physicalGimbalActuationEnabled', 'identityAuthenticated', 'selection', 'model', 'mission', 'shot', 'gimbal', 'targetObservations', 'encoderObservations', 'captures', 'reconciliation', 'manager', 'translation', 'evaluation'])
  equalLiteral(o.model, { ...commonModel, encoderMeasurement: METHOD })
  const sel = object(o.selection, ['id', 'revision', 'source', 'origin', 'reference', 'positionM']); equalLiteral(sel.origin, { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 })
  const m = object(o.mission, ['trace', 'terminalState', 'terminalReason', 'boardMotorsN', 'boardFault', 'boardNeutral', 'finalTruthPositionM']), g = object(o.gimbal, ['rows', 'tail']), re = object(o.reconciliation, ['invalidCaptureSequences', 'earliestInvalidAtMs']), ev = object(o.evaluation, ['motion', 'frames', 'qualified']), mo = object(ev.motion, ['rows', 'tailRows', 'maxRateRadS', 'maxAccelerationRadS2', 'maxJerkRadS3', 'maxAppliedTorqueNm', 'maxTorqueSlewNmS', 'withinDynamicBounds', 'withinMechanicalBounds']), fr = object(ev.frames, ['exposed', 'confirmed', 'qualified', 'maxErrorPx'])
  const traceText = JSON.stringify(m.trace) + '\n', trace = parseTaskMotionMissionTrace(traceText)
  if (JSON.stringify(trace) + '\n' !== traceText) return invalid()
  const motors = dense(m.boardMotorsN, 4, 4)
  return { version: literal(o.version, 4), evidence: literal(o.evidence, 'owned-cinema-counted-dolly-simulation'), profile: literal(o.profile, 'straight-poi-dolly-counted-v1'), scenario: enumeration(o.scenario, ['nominal', 'source-expiry-with-foreign']), status: enumeration(o.status, ['completed', 'halted', 'incomplete', 'failed']), reason: enumeration(o.reason, reasons), physicalFlightEnabled: literal(o.physicalFlightEnabled, false), physicalGimbalActuationEnabled: literal(o.physicalGimbalActuationEnabled, false), identityAuthenticated: literal(o.identityAuthenticated, false), selection: { id: literal(sel.id, 'selected-prop'), revision: literal(sel.revision, 1), source: literal(sel.source, 'synthetic-local-poi'), origin: sel.origin, reference: literal(sel.reference, '55:0,0,0,0,0'), positionM: vector(sel.positionM) }, model: o.model, mission: { trace, terminalState: enumeration(m.terminalState, ['ready', 'running', 'completed', 'aborted', 'blocked']), terminalReason: enumeration(m.terminalReason, nativeReasons), boardMotorsN: [number(motors[0]), number(motors[1]), number(motors[2]), number(motors[3])], boardFault: nullable(m.boardFault, v => enumeration(v, boardFaults)), boardNeutral: bool(m.boardNeutral), finalTruthPositionM: vector(m.finalTruthPositionM) }, shot: readShot(o.shot), gimbal: { rows: list(g.rows, 11251, readPlant), tail: list(g.tail, 501, readPlant, 501) }, targetObservations: list(o.targetObservations, 2251, readTarget), encoderObservations: list(o.encoderObservations, 2251, readEncoder), captures: list(o.captures, 3, readCapture), reconciliation: { invalidCaptureSequences: list(re.invalidCaptureSequences, 3, v => enumeration(v, [1, 2, 3])), earliestInvalidAtMs: nullable(re.earliestInvalidAtMs, epoch) }, manager: readManager(o.manager), translation: readAudit(o.translation), evaluation: { motion: { rows: integer(mo.rows, 1, 11251), tailRows: literal(mo.tailRows, 501), maxRateRadS: number(mo.maxRateRadS, 0), maxAccelerationRadS2: number(mo.maxAccelerationRadS2, 0), maxJerkRadS3: number(mo.maxJerkRadS3, 0), maxAppliedTorqueNm: number(mo.maxAppliedTorqueNm, 0), maxTorqueSlewNmS: number(mo.maxTorqueSlewNmS, 0), withinDynamicBounds: bool(mo.withinDynamicBounds), withinMechanicalBounds: bool(mo.withinMechanicalBounds) }, frames: { exposed: integer(fr.exposed, 0, 3), confirmed: integer(fr.confirmed, 0, 3), qualified: integer(fr.qualified, 0, 3), maxErrorPx: nullable(fr.maxErrorPx, v => number(v, 0)) }, qualified: bool(ev.qualified) } }
}

function restoreGraph(v: unknown): unknown {
  const g = object(v, ['version', 'root', 'objects']); literal(g.version, 1)
  // Each distinct ordinary DTO object consumes at least one byte inside the frozen20MiB output bound.
  const nodes = dense(g.objects, 20971520).map(v => object(v, ['id', 'kind', 'prototype', 'properties']))
  const out: object[] = nodes.map((n, i) => { literal(n.id, i); literal(n.prototype, 'ordinary'); return enumeration(n.kind, ['array', 'object']) === 'array' ? [] : {} })
  function value(v: unknown): unknown {
    const tag = field(v, 'tag')
    if (tag === 'null') { object(v, ['tag']); return null }
    if (tag === 'undefined') { object(v, ['tag']); return undefined }
    if (tag === 'string') return text(object(v, ['tag', 'value']).value)
    if (tag === 'boolean') return bool(object(v, ['tag', 'value']).value)
    if (tag === 'bigint') { const decimal = text(object(v, ['tag', 'decimal']).decimal); if (!/^-?(0|[1-9][0-9]*)$/.test(decimal)) return invalid(); return BigInt(decimal) }
    if (tag === 'number') {
      const token = text(object(v, ['tag', 'token']).token), n = token === '-0' ? -0 : token === 'NaN' ? NaN : Number(token)
      if (token !== '-0' && token !== 'NaN' && String(n) !== token) return invalid()
      return n
    }
    const ref = object(v, ['tag', 'id']); literal(ref.tag, 'ref'); return out[integer(ref.id, 0, out.length - 1)]
  }
  for (const [i, n] of nodes.entries()) {
    const properties = dense(n.properties, 50001).map(v => object(v, ['key', 'enumerable', 'configurable', 'writable', 'value']))
    const keys = properties.map(p => text(p.key)); if (new Set(keys).size !== keys.length) invalid()
    for (const p of properties) Object.defineProperty(out[i]!, text(p.key), { enumerable: bool(p.enumerable), configurable: bool(p.configurable), writable: bool(p.writable), value: value(p.value) })
  }
  return value(g.root)
}
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
function readCanonical(path: string): unknown {
  const bytes = readFileSync(path), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value: unknown = JSON.parse(text)
  if (JSON.stringify(value) + '\n' !== text) invalid()
  return value
}
function readOracleCorrection(directory: string): { bytes: number, sha256: string } | null {
  const path = process.env.CINEMA_COUNTED_FIRST_ORACLE_CORRECTION
  if (!path) return null
  literal(resolve(path), resolve(directory, '../oracle-binding-correction-001/grant.json'))
  const c = object(readCanonical(path), ['version', 'permission', 'base', 'firstDirectory', 'acquisitionReceiptSha256', 'acquisitionGrantSha256', 'firstOracleReceiptSha256', 'firstOracleLogSha256', 'originalTest', 'correctedTest', 'correctionPatchSha256', 'approvedAtUtc'])
  literal(c.version, 1); literal(c.permission, 'saved-first-counted-camera-oracle-order-correction')
  literal(c.base, '56363b52a3be029c1ac762109c3370e5acd6ea9f'); literal(c.firstDirectory, directory)
  for (const [field, file] of [['acquisitionReceiptSha256', 'acquisition-receipt.json'], ['acquisitionGrantSha256', 'first-semantic-go.json'], ['firstOracleReceiptSha256', 'oracle-receipt.json'], ['firstOracleLogSha256', 'oracle.log']] as const) literal(c[field], sha256(readFileSync(join(directory, file))))
  const original = object(c.originalTest, ['path', 'bytes', 'sha256']), corrected = object(c.correctedTest, ['path', 'bytes', 'sha256'])
  literal(original.path, 'tests/unit/cinema-counted-translation.test.ts'); literal(original.bytes, 62344); literal(original.sha256, '5a3bdca88fd92ee3f4a49a39e7ecc229d795d31ed587c63532fb206494074872')
  const frozen = readFileSync(join(directory, 'source', text(original.path)))
  if (frozen.length !== original.bytes || sha256(frozen) !== original.sha256) invalid()
  literal(corrected.path, 'tests/unit/cinema-counted-translation.test.ts')
  literal(c.correctionPatchSha256, sha256(readFileSync(resolve(directory, '../oracle-binding-correction-001/correction.patch'))))
  text(c.approvedAtUtc, 64)
  return { bytes: integer(corrected.bytes, 1, Number.MAX_SAFE_INTEGER), sha256: text(corrected.sha256, 64) }
}
function captureAliases(v: unknown): boolean[] {
  const packets = dense(field(v, 'encoderObservations'), 2251)
  return dense(field(v, 'captures'), 3).map(c => field(c, 'encoder') === packets.find(p => field(p, 'receivedAtMs') === field(c, 'issuedAtMs')))
}
function checkPins(v: unknown, cwd: string, correctedTest: { bytes: number, sha256: string } | null = null): void {
  const pins = dense(v, 5, 5), expected = ['resources/functions/drone/cinema/runtime.ts', 'resources/functions/drone/cinema/counted-translation-types.ts', 'tests/unit/cinema-counted-translation.test.ts', 'tests/tsconfig.runtime.json', 'docs/cinema.md']
  for (const [i, value] of pins.entries()) {
    const p = object(value, ['path', 'bytes', 'sha256']), path = literal(p.path, expected[i]!), b = readFileSync(join(cwd, path))
    const expectedBytes = integer(p.bytes, 1, Number.MAX_SAFE_INTEGER), expectedHash = text(p.sha256, 64), correction = i === 2 ? correctedTest : null
    if (b.length !== (correction?.bytes ?? expectedBytes) || sha256(b) !== (correction?.sha256 ?? expectedHash)) invalid()
  }
}
function decodeSavedFirst(directory: string) {
  const receipt = object(readCanonical(join(directory, 'acquisition-receipt.json')), ['version', 'mode', 'scenario', 'cwd', 'base', 'command', 'runtime', 'sourcePins', 'planSha256', 'limitsSha256', 'grantSha256', 'startedUtc', 'finishedUtc', 'exitCode', 'signal', 'files'])
  literal(receipt.version, 1); literal(receipt.mode, 'first-counted-camera-acquisition'); literal(receipt.scenario, 'nominal')
  const cwd = text(receipt.cwd, 4096)
  literal(receipt.base, '56363b52a3be029c1ac762109c3370e5acd6ea9f')
  literal(receipt.exitCode, 0); literal(receipt.signal, null)
  const runtime = object(receipt.runtime, ['path', 'revision', 'sha256'])
  literal(runtime.path, '/Users/chris/.bun/bin/bun'); literal(runtime.revision, '1.4.2+744846f84'); literal(runtime.sha256, '35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5')
  if (sha256(readFileSync(text(runtime.path, 4096))) !== runtime.sha256) invalid()
  const grant = object(readCanonical(join(directory, 'first-semantic-go.json')), ['version', 'permission', 'base', 'sourcePins', 'runtimeSha256', 'planSha256', 'limitsSha256', 'acquireSha256', 'supervisorSha256', 'approvedAtUtc'])
  literal(grant.version, 1); literal(grant.permission, 'first-counted-camera-nominal'); literal(grant.base, '56363b52a3be029c1ac762109c3370e5acd6ea9f'); literal(grant.runtimeSha256, runtime.sha256)
  if (sha256(readFileSync(join(directory, 'first-semantic-go.json'))) !== receipt.grantSha256 || JSON.stringify(grant.sourcePins) !== JSON.stringify(receipt.sourcePins)) invalid()
  literal(cwd, resolve(import.meta.dir, '../..'))
  checkPins(receipt.sourcePins, cwd, readOracleCorrection(directory))
  checkPins(receipt.sourcePins, join(directory, 'source'))
  const command = dense(receipt.command, 2, 2).map(v => text(v, 4096))
  literal(command[0], '/Users/chris/.bun/bin/bun')
  const evidence = join(cwd, 'storage/framework/runtime/codex-cinema-counted-translation')
  literal(command[1], join(evidence, 'acquire-first.ts'))
  if (sha256(readFileSync(command[1]!)) !== grant.acquireSha256 || sha256(readFileSync(join(evidence, 'first-supervisor.py'))) !== grant.supervisorSha256) invalid()
  text(receipt.startedUtc, 64); text(receipt.finishedUtc, 64); text(grant.approvedAtUtc, 64)
  const expectedFiles = ['result.json', 'raw-result-graph.json', 'encoding.json', 'stdout.log', 'stderr.log', 'plan.json', 'limits.json', 'common-model.json']
  const files = dense(receipt.files, expectedFiles.length, expectedFiles.length)
  for (const [i, value] of files.entries()) { const f = object(value, ['path', 'bytes', 'sha256']), path = literal(f.path, expectedFiles[i]!), b = readFileSync(join(directory, path)); if (b.length !== integer(f.bytes, 0, Number.MAX_SAFE_INTEGER) || sha256(b) !== text(f.sha256, 64)) invalid() }
  if (sha256(readFileSync(join(directory, 'plan.json'))) !== receipt.planSha256 || receipt.planSha256 !== grant.planSha256 || sha256(readFileSync(join(directory, 'limits.json'))) !== receipt.limitsSha256 || receipt.limitsSha256 !== grant.limitsSha256) invalid()
  equalLiteral(readCanonical(join(directory, 'plan.json')), expectedPlan())
  const encoding = object(readCanonical(join(directory, 'encoding.json')), ['kind', 'complete', 'canonicalDtoAvailable', 'notes']); literal(encoding.kind, 'tagged-own-data-graph-v1'); literal(encoding.complete, true); literal(encoding.canonicalDtoAvailable, true); equalLiteral(encoding.notes, [])
  const bytes = readFileSync(join(directory, 'result.json')); if (bytes.length > 20971520) invalid()
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed = readCanonical(join(directory, 'result.json'))
  const raw: unknown = restoreGraph(readCanonical(join(directory, 'raw-result-graph.json')))
  if (JSON.stringify(raw) + '\n' !== json || JSON.stringify(parsed) + '\n' !== json) invalid()
  const common = readCanonical(join(directory, 'common-model.json')); if (!isRecord(common)) return invalid()
  const run = decodeRun(raw, common)
  if (JSON.stringify(run) + '\n' !== json) invalid()
  return { run, captureEncoderAliases: captureAliases(raw) }
}
function firstSavedOrPublicRun() {
  const directory = process.env.CINEMA_COUNTED_FIRST_DIRECTORY
  if (process.env.CINEMA_COUNTED_FIRST_ORACLE_CORRECTION && !directory) invalid()
  if (directory) return decodeSavedFirst(resolve(directory))
  // Ordinary later CI coverage; the first author semantic command MUST select saved mode.
  const actual = cinema.simulateCountedTranslatingCinema({ scenario: 'nominal' })
  const common: unknown = cinemaModel(); if (!isRecord(common)) return invalid()
  return { run: decodeRun(actual, common), captureEncoderAliases: captureAliases(actual) }
}

type OracleRun = ReturnType<typeof decodeRun>
type V3 = [number, number, number]
type Matrix = [V3, V3, V3]
type Actual = { bodyPositionM: V3, bodyQuaternionWxyz: [number, number, number, number], jointPositionRad: V3 }
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
function product(a: Matrix, b: Matrix): Matrix {
  const row = (r: V3): V3 => [r[0] * b[0][0] + r[1] * b[1][0] + r[2] * b[2][0], r[0] * b[0][1] + r[1] * b[1][1] + r[2] * b[2][1], r[0] * b[0][2] + r[1] * b[1][2] + r[2] * b[2][2]]
  return [row(a[0]), row(a[1]), row(a[2])]
}
function transpose(a: Matrix): Matrix { return [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]] }
function rotation(q: [number, number, number, number]): Matrix {
  const [w, x, y, z] = q
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]]
}
function yawPitchRoll(roll: number, pitch: number, yaw: number): Matrix {
  const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw)
  return product(product([[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]], [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]]), [[1, 0, 0], [0, cr, -sr], [0, sr, cr]])
}
function stageGoal(position: V3, q: [number, number, number, number]): V3 {
  const d: V3 = [4 - position[0], -position[1], -1.2 - position[2]]
  const relative = product(transpose(rotation(q)), yawPitchRoll(0, -Math.atan2(d[2], Math.hypot(d[0], d[1])), Math.atan2(d[1], d[0])))
  return [Math.atan2(relative[2][1], relative[2][2]), Math.asin(Math.max(-1, Math.min(1, -relative[2][0]))), Math.atan2(relative[1][0], relative[0][0])]
}
// Literal independent pinhole/board oracle, with no production quaternion, gimbal-goal or renderer helper.
function exposureGoal(position: V3, q: [number, number, number, number], offset: number): V3 {
  const d: V3 = [4 - position[0], -position[1], -1.2 - position[2]]
  const relative = product(transpose(rotation(q)), yawPitchRoll(0, -Math.atan2(d[2], Math.hypot(d[0], d[1])), Math.atan2(d[1], d[0]) + offset))
  return [Math.atan2(relative[2][1], relative[2][2]), Math.asin(Math.max(-1, Math.min(1, -relative[2][0]))), Math.atan2(relative[1][0], relative[0][0])]
}
function raster(actual: Actual): number[] {
  const joints = yawPitchRoll(...actual.jointPositionRad), optical = product(product(rotation(actual.bodyQuaternionWxyz), joints), [[0, 0, 1], [1, 0, 0], [0, 1, 0]])
  const out: number[] = []
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const vector: V3 = [(x + 0.5 - 32) / 40, (y + 0.5 - 24) / 40, 1]
    const ray: V3 = [0, 0, 0]
    for (let i = 0; i < 3; i++) ray[i] = optical[i]![0] * vector[0] + optical[i]![1] * vector[1] + optical[i]![2] * vector[2]
    const depth = ray[0] > 1e-9 ? (4 - actual.bodyPositionM[0]) / ray[0] : -1
    let color = [16, 20, 24, 255]
    if (depth >= 1 && depth <= 10) {
      const right = actual.bodyPositionM[1] + depth * ray[1], down = actual.bodyPositionM[2] + depth * ray[2] + 1.2
      if (right >= -0.4 && right < 0.4 && down >= -0.3 && down < 0.3) {
        color = [96, 104, 112, 255]
        if (right >= -0.12 && right < 0.12 && down >= -0.12 && down < 0.12) color = [240, 20, 180, 255]
        else if (right >= -0.32 && right < -0.20 && down >= -0.20 && down < -0.08) color = [230, 40, 30, 255]
        else if (right >= 0.18 && right < 0.30 && down >= 0.10 && down < 0.22) color = [20, 80, 230, 255]
      }
    }
    out.push(...color)
  }
  return out
}
function magenta(rgba: number[]) {
  let x = 0, y = 0, count = 0
  for (let pixel = 0; pixel < 3072; pixel++) if (rgba[pixel * 4] === 240 && rgba[pixel * 4 + 1] === 20 && rgba[pixel * 4 + 2] === 180) { x += pixel % 64 + 0.5; y += Math.floor(pixel / 64) + 0.5; count++ }
  return { count, x: count ? x / count : NaN, y: count ? y / count : NaN }
}
function expectedPlan() {
  return validateTaskMotionMission({ version: 4, id: 'cinema-dolly-counted-v1', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5 }, rallyM: [0, 0, -1.2], power: { availableWh: 20, hoverW: 200, reservePercent: 30 }, start: 'takeoff', speedMps: 0.6, tasks: [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 10000, next: 'stage' }, { id: 'stage', kind: 'readiness-loiter', positionM: [0, 0, -1.2], durationMs: 1500, timeoutMs: 3000, sourceId: 'cinema-stage-counted-v1', next: 'dolly' }, { id: 'dolly', kind: 'waypoint', speedMps: 0.2, positionM: [2, 0, -1.2], timeoutMs: 12000, next: 'return' }, { id: 'return', kind: 'return', timeoutMs: 12000, next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 7000 }] })
}
function expectNative(run: OracleRun, atMs: number) {
  const row = run.mission.trace.rows.find(row => row.observation.nowMs === atMs)!
  expect(row).toBeDefined()
  expect(row.observation.healthy).toBe(true)
  expect(row.observation.authority).toBe('autonomous')
  expect(row.observation.reference).toBe('55:0,0,0,0,0')
  expect(row.observation.origin).toEqual({ latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 })
  expect(row.result.state).toBe('running')
  expect(row.result.taskId).toBe('dolly')
}
function expectReadiness(run: OracleRun) {
  const a = run.translation, d = a.timeline.moveEnteredAtMs!, s = run.shot.startedAtMs!, l = run.shot.loiterObservedAtMs!, e = a.timeline.stageEnteredAtMs!
  expect(a.timeline.moveObservedAtMs).toBe(s)
  expect(e).toBe(l - 20)
  expect(d - e).toBeGreaterThanOrEqual(1500)
  expect(d).toBe(s - 20)
  expect(run.shot.latestStartMs).toBe(l + 1600)
  expect(s).toBeLessThanOrEqual(l + 1600)
  expect(d).toBeLessThanOrEqual(l + 1580)
  expect(a.timeline.readyThroughAtMs).toBe(d)
  expect(a.timeline.readySamplesAtEntry).toBe(26)
  expect(run.shot.readySampleCount).toBe(26)
  expect(run.shot.readySinceMs!).toBeLessThanOrEqual(d - 500)
  expect(a.readinessSamples).toHaveLength(26)
  for (const [i, sample] of a.readinessSamples.entries()) {
    const n = d - 500 + i * 20, row = run.mission.trace.rows.find(row => row.observation.nowMs === n)!
    const target = run.targetObservations.find(row => row.receivedAtMs === n)!, encoder = run.encoderObservations.find(row => row.receivedAtMs === n)!
    expect(sample.atMs).toBe(n)
    expect(row.result.state).toBe('running')
    expect(row.result.taskId).toBe(i === 25 ? 'dolly' : 'stage')
    expect(row.action).toBeNull()
    expect(row.observation.healthy).toBe(true)
    expect(row.observation.authority).toBe('autonomous')
    expect(row.observation.reference).toBe('55:0,0,0,0,0')
    expect(Math.hypot(...row.observation.velocityMps)).toBeLessThanOrEqual(0.15)
    expect(Math.hypot(row.observation.positionM[0], row.observation.positionM[1], row.observation.positionM[2] + 1.2)).toBeLessThanOrEqual(0.15)
    expect(target.capturedAtMs).toBe(n)
    expect(target.sequence).toBeGreaterThan(0)
    expect(target.positionM).toEqual([4, 0, -1.2])
    expect(encoder.capturedAtMs).toBe(n - 20)
    expect(encoder.limitSwitch).toBe(false)
    const goal = stageGoal(row.observation.positionM, sample.quaternionWxyz)
    expect(encoder.positionRad.every((v, axis) => Math.abs(v - goal[axis]!) <= 0.5 * Math.PI / 180)).toBe(true)
    expect(encoder.deltaCounts!.every(v => Math.abs(v) <= 1)).toBe(true)
    expect(encoder.velocityRadS!.every(v => Math.abs(v) <= 0.05)).toBe(true)
    for (const [capture, age] of [[sample.positionCapturedAtMs, 200], [sample.attitudeCapturedAtMs, 60], [sample.gyroCapturedAtMs, 80]]) expect(capture! >= 0 && capture! <= n && n - capture! <= age!).toBe(true)
    expect(byteLength(sample)).toBeLessThanOrEqual(512)
  }
  const release = run.mission.trace.rows.find(row => row.observation.nowMs === d)!, predecessor = run.mission.trace.rows.find(row => row.observation.nowMs === d - 20)!
  expect(predecessor.result.taskId).toBe('stage')
  expect(release.result.taskEnteredAtMs).toBe(d)
  expect(release.readiness).toEqual({ version: 1, planId: 'cinema-dolly-counted-v1', runStartedAtMs: 600, taskId: 'stage', taskEnteredAtMs: e, sourceId: 'cinema-stage-counted-v1', reference: '55:0,0,0,0,0', observedAtMs: d, ready: true })
  const token = a.releaseCommand!, enc = run.encoderObservations.find(row => row.receivedAtMs === d)!, physical = run.gimbal.rows.find(row => row.atMs === d + 4)!
  expect(token).not.toBeNull()
  expect(token.epoch).toBe(1)
  expect(token.issuedAtMs).toBe(d)
  expect(token.expiresAtMs).toBe(d + 80)
  expect(token.sequence).toBe((d - l) / 20 + 1)
  expect(run.manager.transitions[0]?.atMs).toBe(l)
  const goal = stageGoal(release.observation.positionM, a.readinessSamples[25]!.quaternionWxyz)
  for (let i = 0; i < 3; i++) {
    expect(token.goalRad[i]!).toBeCloseTo(goal[i]!, 12)
    expect(physical.requestedTorqueNm[i]!).toBe(Math.max(-0.02, Math.min(0.02, 0.12 * (token.goalRad[i]! - enc.positionRad[i]!) - 0.04 * enc.velocityRadS![i]!)))
  }
  expect(physical.requestedAtMs).toBe(d)
  expectNative(run, s)
}


function expectClosedIdentity(run:OracleRun) {
  expect(run.version).toBe(4);expect(run.evidence).toBe('owned-cinema-counted-dolly-simulation')
  expect(run.profile).toBe('straight-poi-dolly-counted-v1');expect(run.scenario).toBe('nominal')
  expect(run.physicalFlightEnabled).toBe(false);expect(run.physicalGimbalActuationEnabled).toBe(false);expect(run.identityAuthenticated).toBe(false)
  expect(run.translation.policy.handshake.encoderMethod).toBe('count-difference-v1')
  expect(run.selection.positionM).toEqual([4,0,-1.2])
  // All closed nested keys/order and literal policy/model fields already checked by runSchema.
}
function expectCountHistory(run:OracleRun) {
  const packets=run.encoderObservations, R=run.shot.retirement.atMs
  expect(packets).toHaveLength((R-600)/20+1)
  for(const [i,p] of packets.entries()) {
    expect(p.version).toBe(1);expect(p.sequence).toBe(i+1)
    expect(p.receivedAtMs).toBe(600+20*i);expect(p.capturedAtMs).toBe(p.receivedAtMs-20)
    const delayed=run.gimbal.rows.find(row=>row.atMs===p.capturedAtMs)!
    expect(delayed).toBeDefined()
    if(i===0){expect(p.deltaCounts).toBeNull();expect(p.velocityRadS).toBeNull()}
    else {expect(p.deltaCounts).not.toBeNull();expect(p.velocityRadS).not.toBeNull()}
    for(let j=0;j<3;j++) {
      const count=p.positionCounts[j]!, scaled=delayed.positionRad[j]!/0.001
      expect(Number.isSafeInteger(count)&&!Object.is(count,-0)&&Math.abs(count)<=8000).toBe(true)
      expect(scaled>=count-0.5&&scaled<count+0.5).toBe(true) // nearest/ties-positive
      expect(p.positionRad[j]).toBe(count*0.001)
      if(i) {
        const delta=count-packets[i-1]!.positionCounts[j]!
        expect(Number.isSafeInteger(delta)&&Math.abs(delta)<=16000).toBe(true)
        expect(p.deltaCounts![j]).toBe(delta);expect(p.velocityRadS![j]).toBe(delta*0.05)
        expect(Math.abs(p.velocityRadS![j]!)<=0.05).toBe(Math.abs(delta)<=1)
      }
    }
    expect(p.limitSwitch).toBe(delayed.positionRad.some((n,j)=>Math.abs(n)>[20,45,45][j]!*Math.PI/180))
  }
}
function expectAllTemporalJoins(run:OracleRun) {
  const a=run.translation,S=run.shot.startedAtMs!,D=a.timeline.moveEnteredAtMs!,C=S+8000
  const origin={latitudeDeg:0,longitudeDeg:0,ellipsoidHeightM:100}
  const native=(n:number)=>run.mission.trace.rows.find(r=>r.observation.nowMs===n)!
  for(const row of run.mission.trace.rows.filter(r=>r.observation.nowMs>=S&&r.observation.nowMs<=C)) {
    expectNative(run,row.observation.nowMs)
    const [x,y,z]=row.observation.positionM, nearest=Math.max(0,Math.min(2,x))
    expect(Math.hypot(x-nearest,y,z+1.2)).toBeLessThanOrEqual(0.2)
    // No stage .15 speed check during dolly.
  }
  const epochs=[D,S,...run.captures.flatMap(c=>[c.issuedAtMs,c.ack!.receivedAtMs]),C]
  for(const n of epochs) {
    const row=native(n),p=run.encoderObservations.find(p=>p.receivedAtMs===n)!,t=run.targetObservations.find(t=>t.receivedAtMs===n)!
    expect(row.observation.origin).toEqual(origin);expectNative(run,n)
    expect(p).toBeDefined();expect(p.limitSwitch).toBe(false)
    expect(t.targetId).toBe('selected-prop');expect(t.revision).toBe(1);expect(t.reference).toBe('55:0,0,0,0,0')
    expect(t.capturedAtMs).toBe(n);expect(t.receivedAtMs).toBe(n);expect(t.positionM).toEqual([4,0,-1.2])
  }
  for(const sample of a.readinessSamples) {
    const row=native(sample.atMs)
    expect(row.observation.origin).toEqual(origin)
    const t=run.targetObservations.find(t=>t.receivedAtMs===sample.atMs)!
    expect(t.targetId).toBe('selected-prop');expect(t.revision).toBe(1);expect(t.reference).toBe('55:0,0,0,0,0')
  }
  for(const [i,c]of run.captures.entries()) {
    const n=c.issuedAtMs,p=c.pose
    expect(p.capturedAtMs).toBe(n);expect(p.positionPredictedToMs).toBe(n);expect(p.attitudePredictedToMs).toBe(n)
    expect(p.reference).toBe('55:0,0,0,0,0');expect(p.attitudePrediction).toBe('qualified-gyro-hold')
    for(const [at,maxAge]of [[p.positionCapturedAtMs,200],[p.attitudeCapturedAtMs,60],[p.gyroCapturedAtMs,80]])expect(at!>=0&&at!<=n&&n-at!<=maxAge!).toBe(true)
    expect(c.sequence + 0).toBe(i+1);expect(c.reason).toBe('acknowledged');expect(c.shotOffsetMs + 0).toBe([1000,3000,7000][i]!)
    expect(c.ack!.sessionId).toBe(c.sessionId);expect(c.ack!.sequence).toBe(c.sequence);expect(c.ack!.reference).toBe(c.reference)
    expect(c.ack!.issuedAtMs).toBe(n);expect(c.ack!.capturedAtMs).toBe(n);expect(c.ack!.acknowledgedAtMs).toBeGreaterThanOrEqual(n);expect(c.ack!.acknowledgedAtMs).toBeLessThanOrEqual(c.ack!.receivedAtMs)
    const command=run.manager.captureCommands[i]!
    expect(command.captureSequence).toBe(c.sequence);expect(command.atMs).toBe(n)
    expect(command.command.epoch).toBe(1);expect(command.command.issuedAtMs).toBe(n);expect(command.command.expiresAtMs).toBe(n+80)
  }
  expect(run.manager.firstInhibit).toBeNull();expect(run.manager.foreignRejections).toEqual([])
  expect(run.manager.counters.rejectedForeignCommands).toBe(0);expect(run.manager.counters.rejectedSelectedCommands).toBe(0)
  expect(run.manager.retirement.atMs).toBe(C);expect(run.manager.retirement.directive).toBe('zero-requested-torque')
  expect(run.shot.retirement.cause).toBe('shot-completed')
  expect(run.shot.retirement.bodyPositionM).toEqual(a.rows.at(-1)!.positionM)
  expect(run.shot.retirement.bodyQuaternionWxyz).toEqual(a.rows.at(-1)!.quaternionWxyz)
  expect(run.shot.counters.shutterAttempts).toBe(3);expect(run.shot.counters.ackReceipts).toBe(3)
  expect(run.shot.counters.confirmedCaptures).toBe(3);expect(run.shot.counters.uncertainCaptures).toBe(0)
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0);expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.manager.counters.commandsAfterRetirement).toBe(0)
  const rows=a.rows,first=rows[0]!,last=rows.at(-1)!
  expect(a.metrics.sampleCount).toBe(rows.length);expect(a.metrics.durationMs).toBe(last.atMs-first.atMs)
  expect(a.metrics.forwardDisplacementM).toBe(last.positionM[0]-first.positionM[0])
  const corridor=(p:V3)=>Math.hypot(p[0]-Math.max(0,Math.min(2,p[0])),p[1],p[2]+1.2)
  expect(a.metrics.maxCrossTrackM).toBe(Math.max(...rows.map(r=>corridor(r.positionM))))
  expect(a.metrics.maxSpeedMps).toBe(Math.max(...rows.map(r=>Math.hypot(...r.velocityMps))))
  expect(a.metrics.maxAccelerationMps2).toBe(Math.max(...rows.map(r=>Math.hypot(...r.accelerationMps2))))
  let sampledJerk=0
  for(let i=1;i<rows.length;i++){const one=rows[i]!,prior=rows[i-1]!;sampledJerk=Math.max(sampledJerk,Math.hypot((one.accelerationMps2[0]-prior.accelerationMps2[0])/0.020,(one.accelerationMps2[1]-prior.accelerationMps2[1])/0.020,(one.accelerationMps2[2]-prior.accelerationMps2[2])/0.020))}
  expect(a.metrics.maxSampledJerkMps3).toBe(sampledJerk) // sampled20ms only, never4ms qualification
  const captureRows=run.captures.map(c=>rows.find(r=>r.atMs===c.issuedAtMs)!)
  expect(a.metrics.captureForwardSpeedMps).toEqual([captureRows[0]!.velocityMps[0], captureRows[1]!.velocityMps[0], captureRows[2]!.velocityMps[0]])
  expect(a.metrics.firstExposureForwardDisplacementM).toBe(captureRows[0]!.positionM[0]-first.positionM[0])
  expect(a.metrics.firstExposureForwardSpeedMps).toBe(captureRows[0]!.velocityMps[0])
  expect(replayTaskMotionMission(run.mission.trace).trace()).toEqual(run.mission.trace)
  expect(run.mission.terminalReason).toBe(native(run.mission.trace.rows.at(-1)!.observation.nowMs).result.reason)
}
function expectIndependentDynamics(run:OracleRun) {
  const rows=run.gimbal.rows,tail=run.gimbal.tail,R=run.shot.retirement.atMs
  expect(tail).toHaveLength(501)
  expect(tail[0]!.positionRad).toEqual(rows.at(-1)!.positionRad)
  expect(tail[0]!.velocityRadS).toEqual(rows.at(-1)!.velocityRadS)
  expect(tail[0]!.appliedTorqueNm).toEqual(rows.at(-1)!.appliedTorqueNm)
  for(const [i,r]of tail.entries()){expect(r.atMs).toBe(R+4*i);expect(r.requestedTorqueNm).toEqual([0,0,0]);expect(r.requestedAtMs).toBe(R)}
  const all=[...rows,...tail.slice(1)]
  let rate=0,acceleration=0,jerk=0,torque=0,slew=0
  for(let i=0;i<all.length;i++) {
    const r=all[i]!,prior=all[i-1]
    expect(r.atMs).toBe(i*4)
    for(let j=0;j<3;j++) {
      expect(Math.abs(r.positionRad[j]!)).toBeLessThanOrEqual([20,45,45][j]!*Math.PI/180)
      rate=Math.max(rate,Math.abs(r.velocityRadS[j]!));acceleration=Math.max(acceleration,Math.abs(r.accelerationRadS2[j]!));torque=Math.max(torque,Math.abs(r.appliedTorqueNm[j]!))
      if(prior){jerk=Math.max(jerk,Math.abs((r.accelerationRadS2[j]!-prior.accelerationRadS2[j]!)/0.004));slew=Math.max(slew,Math.abs((r.appliedTorqueNm[j]!-prior.appliedTorqueNm[j]!)/0.004))}
    }
  }
  expect(run.evaluation.motion).toEqual({rows:rows.length,tailRows:501,maxRateRadS:rate,maxAccelerationRadS2:acceleration,maxJerkRadS3:jerk,maxAppliedTorqueNm:torque,maxTorqueSlewNmS:slew,withinDynamicBounds:true,withinMechanicalBounds:true})
  // Existing model evaluation bounds/tolerance ONLY; not the strict readiness .05 gate.
  expect(rate<=2+1e-9&&acceleration<=4+1e-9&&jerk<=6+1e-9&&torque<=0.02+1e-9&&slew<=0.02+1e-9).toBe(true)
}
function expectActualCaps(run:OracleRun) {
  const bound=(list:readonly unknown[],count:number,cap:number)=>{expect(list.length).toBeLessThanOrEqual(count);for(const row of list)expect(byteLength(row)).toBeLessThanOrEqual(cap)}
  bound(run.encoderObservations,2251,512);bound(run.gimbal.rows,11251,768);bound(run.gimbal.tail,501,768)
  bound(run.targetObservations,2251,640);bound(run.captures,3,65536)
  bound(run.translation.rows,400,768);bound(run.translation.readinessSamples,26,512)
  bound(run.mission.trace.rows,6001,2048)
  expect(byteLength(run.mission.trace.plan)).toBeLessThanOrEqual(32768)
  expect(byteLength(run.model)).toBeLessThanOrEqual(16384)
  expect(byteLength(run.manager)+1).toBeLessThanOrEqual(12288)
  expect(byteLength(run.translation.releaseCommand)).toBeLessThanOrEqual(512)
  expect(byteLength({releaseCommand:run.translation.releaseCommand})+1).toBeLessThanOrEqual(1024)
  for(const c of run.captures) {expect(c.image!.rgba).toHaveLength(12288);expect(byteLength(c.image!.rgba)).toBeLessThanOrEqual(49154)}
  expect(run.translation.rows).toHaveLength(400)
  for(const [i,row]of run.translation.rows.entries())expect(row.atMs).toBe(run.shot.startedAtMs!+(i+1)*20)
  expect(byteLength({...run.translation,rows:[],readinessSamples:[],releaseCommand:null})).toBeLessThanOrEqual(4096)
  expect(byteLength(run.translation)+1).toBeLessThanOrEqual(393216)
  expect(byteLength(run.mission.trace)+1).toBeLessThanOrEqual(8388608)
  const {mission,...body}=run
  expect(byteLength({...body,mission:{...mission,trace:null}})+1).toBeLessThanOrEqual(12582912)
  expect(byteLength(run)+1).toBeLessThanOrEqual(20971520)
  // Preserve original manager component bounds; no expanded profile or extra journal.
  expect(byteLength(run.manager.lastAccepted)).toBeLessThanOrEqual(512)
  expect(byteLength(run.manager.firstInhibit)).toBeLessThanOrEqual(256)
  expect(byteLength(run.manager.counters)).toBeLessThanOrEqual(256)
  bound(run.manager.transitions,16,256)
}
test('FIRST saved nominal counted camera flight qualifies actual readiness, moving rasters and return landing', () => {
  const saved = firstSavedOrPublicRun(), run = saved.run
  expect(saved.captureEncoderAliases).toEqual([false, false, false])
  expect(run.status).toBe('completed')
  expect(run.reason).toBe('qualified')
  expect(run.version).toBe(4)
  expect(run.profile).toBe('straight-poi-dolly-counted-v1')
  expect(run.mission.trace.version).toBe(4)
  expect(run.mission.trace.plan).toEqual(expectedPlan().plan)
  expect(run.mission.terminalState).toBe('completed')
  expect(run.mission.terminalReason).toBe('landed')
  expect(run.mission.boardNeutral).toBe(true)
  expect(run.mission.boardMotorsN).toEqual([0, 0, 0, 0])
  expect(run.mission.boardFault).toBeNull()
  expect(run.mission.finalTruthPositionM[2]).toBe(-0.1)
  expect(run.shot.firstFault).toBeNull()
  expectReadiness(run)
  expectClosedIdentity(run)
  expectCountHistory(run)
  expectAllTemporalJoins(run)
  expectIndependentDynamics(run)
  expectActualCaps(run)
  const s = run.shot.startedAtMs!, a = run.translation
  expect(a.version).toBe(3)
  expect(a.planDefaultSpeedMps).toBe(0.6)
  expect(JSON.stringify(a.taskRates)).toBe(JSON.stringify(run.mission.trace.plan.tasks.map(t => { if (!('speedMps' in t)) throw new Error('Expected spatial native tasks'); return { taskId: t.id, kind: t.kind, speedMps: t.speedMps } })))
  expect(a.timeline.startAdmission).toBe('valid')
  expect(a.timeline.normalCloseAdmission).toBe('valid')
  expect(a.timeline.firstInvalidJoin).toBeNull()
  expect(run.captures).toHaveLength(3)
  const fractions = [379 / 2187, 1, 0]
  for (const [i, capture] of run.captures.entries()) {
    expect(capture.issuedAtMs).toBe(s + [1000, 3000, 7000][i]!)
    expect(capture.capturedAtMs).toBe(capture.issuedAtMs)
    expect(capture.encoder).toEqual(run.encoderObservations.find(p => p.receivedAtMs === capture.issuedAtMs)!)
    expect(capture.state).toBe('confirmed')
    expect(capture.postStepAdmission).toBe('valid')
    expect(capture.quality.qualified).toBe(true)
    expect(capture.image!.rgba).toEqual(raster(capture.actual!))
    const measured = magenta(capture.image!.rgba), expectedX = 32 - 40 * Math.tan(8 * Math.PI / 180 * fractions[i]!)
    expect(measured.count).toBeGreaterThan(0)
    expect(Math.hypot(measured.x - expectedX, measured.y - 24)).toBeLessThanOrEqual(2)
    expect(capture.quality.observedPixel).toEqual([measured.x, measured.y])
    const row = a.rows.find(row => row.atMs === capture.issuedAtMs)!, gimbal = run.gimbal.rows.find(row => row.atMs === capture.issuedAtMs)!
    expect(capture.actual!.bodyPositionM).toEqual(row.positionM)
    expect(capture.actual!.bodyQuaternionWxyz).toEqual(row.quaternionWxyz)
    expect(capture.actual!.jointPositionRad).toEqual(gimbal.positionRad)
    expect(capture.actual!.appliedTorqueNm).toEqual(gimbal.appliedTorqueNm)
    expect(row.velocityMps[0]).toBeGreaterThan(0)
    expect(capture.ack!.receivedAtMs).toBe(capture.issuedAtMs + 20)
    expect(run.manager.captureCommands[i]!.command.issuedAtMs).toBe(capture.issuedAtMs)
    const requestedGoal = exposureGoal(capture.pose.positionM, capture.pose.quaternionWxyz, 8 * Math.PI / 180 * fractions[i]!)
    for (let axis = 0; axis < 3; axis++) expect(run.manager.captureCommands[i]!.command.goalRad[axis]!).toBeCloseTo(requestedGoal[axis]!, 12)
    const footprint = (rgba: number[]) => { let count = 0; for (let at = 0; at < rgba.length; at += 4) if (rgba[at] !== 16 || rgba[at + 1] !== 20 || rgba[at + 2] !== 24 || rgba[at + 3] !== 255) count++; return count }
    expect(footprint(capture.image!.rgba)).toBe(footprint(raster(capture.actual!)))
    expect(footprint(capture.image!.rgba)).toBeGreaterThan(0)
    expectNative(run, capture.issuedAtMs)
    expectNative(run, capture.ack!.receivedAtMs)
  }
  const displacement = run.captures[2]!.actual!.bodyPositionM[0] - run.captures[0]!.actual!.bodyPositionM[0]
  expect(displacement).toBeGreaterThanOrEqual(0.5)
  expect(a.metrics.captureForwardDisplacementM).toBe(displacement)
  expect(a.metrics.nominalWitness).toBe('satisfied')
  expect(a.metrics.sourceMotionWitness).toBe('not-evaluated')
  expect(a.smoothnessQualified).toBe(false)
  expect(run.shot.completedAtMs).toBe(s + 8000)
  expect(run.shot.retirement.atMs).toBe(s + 8000)
  expectNative(run, s + 8000)
  expect(a.rows).toHaveLength(400)
  expect(a.rows.every((row, i) => row.atMs === s + (i + 1) * 20 && byteLength(row) <= 768)).toBe(true)
  expect(a.metrics.durationMs).toBe(7980)
  expect(run.gimbal.tail).toHaveLength(501)
  expect(run.evaluation.motion.withinDynamicBounds).toBe(true)
  expect(run.evaluation.motion.withinMechanicalBounds).toBe(true)
  expect(run.evaluation.qualified).toBe(true)
  expect(run.reconciliation).toEqual({ invalidCaptureSequences: [], earliestInvalidAtMs: null })
  expect(replayTaskMotionMission(run.mission.trace).snapshot()).toEqual(run.mission.trace.rows.at(-1)!.result)
  expect(byteLength(a) + 1).toBeLessThanOrEqual(393216)
  expect(byteLength({ ...a, rows: [], readinessSamples: [], releaseCommand: null })).toBeLessThanOrEqual(4096)
  expect(byteLength(run.mission.trace) + 1).toBeLessThanOrEqual(8388608)
  expect(byteLength(run) + 1).toBeLessThanOrEqual(20971520)
  const { mission, ...body } = run
  expect(byteLength({ ...body, mission: { ...mission, trace: null } }) + 1).toBeLessThanOrEqual(12582912)
}, 70000)

if (false) {
  const next = cinema.simulateCountedTranslatingCinema(), old = cinema.simulateCinema(), managed = cinema.simulateManagedCinema()
  const concrete: CinemaCountedTranslationRun = next
  const trace: import('../../resources/functions/drone/missions/engine').TaskMotionMissionTrace = next.mission.trace
  const packet: import('../../resources/functions/drone/cinema/counted-encoder').CinemaCountedEncoder = next.captures[0]!.encoder
  const method: 'count-difference-v1' = next.model.encoderMeasurement.method
  // @ts-expect-error A legacy measured packet lacks required counted fields.
  const legacyPacket: typeof packet = old.captures[0]!.encoder
  // @ts-expect-error Move faults are not legacy Cinema faults.
  const fault: import('../../resources/functions/drone/cinema/types').CinemaFaultCode = 'move-not-ready'
  // @ts-expect-error Counted translation has a disjoint concrete outer/native/packet contract.
  const one: typeof old = next
  // @ts-expect-error Managed hover remains its published format.
  const two: typeof managed = next
  // @ts-expect-error This concrete function does not accept a provider type parameter.
  cinema.simulateCountedTranslatingCinema<unknown>()
  void concrete; void trace; void packet; void method; void legacyPacket; void fault; void one; void two
}


// Source-loss is a separate first acquisition after accepted nominal, never a substitute for it.
function decodeSavedSourceLoss(directory: string) {
  const receipt = object(readCanonical(join(directory, 'acquisition-receipt.json')), ['version', 'mode', 'scenario', 'cwd', 'base', 'command', 'runtime', 'sourcePins', 'planSha256', 'limitsSha256', 'grantSha256', 'startedUtc', 'finishedUtc', 'exitCode', 'signal', 'files'])
  literal(receipt.version, 1); literal(receipt.mode, 'first-counted-camera-source-loss-acquisition'); literal(receipt.scenario, 'source-expiry-with-foreign')
  const cwd = text(receipt.cwd, 4096)
  literal(receipt.base, '56363b52a3be029c1ac762109c3370e5acd6ea9f')
  literal(receipt.exitCode, 0); literal(receipt.signal, null)
  const runtime = object(receipt.runtime, ['path', 'revision', 'sha256'])
  literal(runtime.path, '/Users/chris/.bun/bin/bun'); literal(runtime.revision, '1.4.2+744846f84'); literal(runtime.sha256, '35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5')
  if (sha256(readFileSync(text(runtime.path, 4096))) !== runtime.sha256) invalid()
  const grant = object(readCanonical(join(directory, 'first-source-loss-go.json')), ['version', 'permission', 'base', 'sourcePins', 'runtimeSha256', 'planSha256', 'limitsSha256', 'acquireSha256', 'supervisorSha256', 'nominalAcceptanceSha256', 'approvedAtUtc'])
  literal(grant.version, 1); literal(grant.permission, 'first-counted-camera-source-loss'); literal(grant.base, '56363b52a3be029c1ac762109c3370e5acd6ea9f'); literal(grant.runtimeSha256, runtime.sha256)
  if (sha256(readFileSync(join(directory, 'first-source-loss-go.json'))) !== receipt.grantSha256 || JSON.stringify(grant.sourcePins) !== JSON.stringify(receipt.sourcePins)) invalid()
  literal(cwd, resolve(import.meta.dir, '../..'))
  checkPins(receipt.sourcePins, cwd)
  checkPins(receipt.sourcePins, join(directory, 'source'))
  const command = dense(receipt.command, 2, 2).map(v => text(v, 4096))
  literal(command[0], '/Users/chris/.bun/bin/bun')
  const evidence = join(cwd, 'storage/framework/runtime/codex-cinema-counted-translation')
  literal(command[1], join(evidence, 'acquire-source-loss.ts'))
  if (sha256(readFileSync(command[1]!)) !== grant.acquireSha256 || sha256(readFileSync(join(evidence, 'source-loss-supervisor.py'))) !== grant.supervisorSha256) invalid()
  literal(grant.nominalAcceptanceSha256, sha256(readFileSync(join(evidence, 'root-nominal-acceptance.json'))))
  literal(grant.nominalAcceptanceSha256, '011933f3e07a6d2812bf39a6914245c42c7d442d7407dac2a6a5cc92453cbdd4')
  text(receipt.startedUtc, 64); text(receipt.finishedUtc, 64); text(grant.approvedAtUtc, 64)
  const expectedFiles = ['result.json', 'raw-result-graph.json', 'encoding.json', 'stdout.log', 'stderr.log', 'plan.json', 'limits.json', 'common-model.json', 'nominal-acceptance.json']
  const files = dense(receipt.files, expectedFiles.length, expectedFiles.length)
  for (const [i, value] of files.entries()) { const f = object(value, ['path', 'bytes', 'sha256']), path = literal(f.path, expectedFiles[i]!), b = readFileSync(join(directory, path)); if (b.length !== integer(f.bytes, 0, Number.MAX_SAFE_INTEGER) || sha256(b) !== text(f.sha256, 64)) invalid() }
  if (sha256(readFileSync(join(directory, 'plan.json'))) !== receipt.planSha256 || receipt.planSha256 !== grant.planSha256 || sha256(readFileSync(join(directory, 'limits.json'))) !== receipt.limitsSha256 || receipt.limitsSha256 !== grant.limitsSha256) invalid()
  literal(sha256(readFileSync(join(directory, 'nominal-acceptance.json'))), text(grant.nominalAcceptanceSha256, 64))
  equalLiteral(readCanonical(join(directory, 'plan.json')), expectedPlan())
  const encoding = object(readCanonical(join(directory, 'encoding.json')), ['kind', 'complete', 'canonicalDtoAvailable', 'notes']); literal(encoding.kind, 'tagged-own-data-graph-v1'); literal(encoding.complete, true); literal(encoding.canonicalDtoAvailable, true); equalLiteral(encoding.notes, [])
  const bytes = readFileSync(join(directory, 'result.json')); if (bytes.length > 20971520) invalid()
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes), parsed = readCanonical(join(directory, 'result.json'))
  const raw: unknown = restoreGraph(readCanonical(join(directory, 'raw-result-graph.json')))
  if (JSON.stringify(raw) + '\n' !== json || JSON.stringify(parsed) + '\n' !== json) invalid()
  const common = readCanonical(join(directory, 'common-model.json')); if (!isRecord(common)) return invalid()
  const run = decodeRun(raw, common)
  if (JSON.stringify(run) + '\n' !== json) invalid()
  return { run, captureEncoderAliases: captureAliases(raw) }
}
function firstSavedOrPublicSourceLoss() {
  const directory = process.env.CINEMA_COUNTED_SOURCE_LOSS_DIRECTORY
  if (directory) {
    literal(resolve(directory), resolve(import.meta.dir, '../../storage/framework/runtime/codex-cinema-counted-translation/first-source-loss'))
    return decodeSavedSourceLoss(resolve(directory))
  }
  // Ordinary later bounded/CI coverage only. The first source-loss command MUST use saved mode.
  const actual = cinema.simulateCountedTranslatingCinema({ scenario: 'source-expiry-with-foreign' })
  const common: unknown = cinemaModel(); if (!isRecord(common)) return invalid()
  return { run: decodeRun(actual, common), captureEncoderAliases: captureAliases(actual) }
}
function expectSourceLossCaps(run: OracleRun) {
  const bound = (rows: readonly unknown[], count: number, cap: number) => { expect(rows.length).toBeLessThanOrEqual(count); for (const row of rows) expect(byteLength(row)).toBeLessThanOrEqual(cap) }
  bound(run.encoderObservations, 2251, 512); bound(run.gimbal.rows, 11251, 768); bound(run.gimbal.tail, 501, 768)
  bound(run.targetObservations, 2251, 640); bound(run.captures, 3, 65536)
  bound(run.translation.rows, 400, 768); bound(run.translation.readinessSamples, 26, 512)
  bound(run.mission.trace.rows, 6001, 2048); bound(run.manager.transitions, 16, 256)
  bound(run.manager.captureCommands, 3, 512); bound(run.manager.foreignRejections, 1, 512)
  for (const [value, cap] of [[run.mission.trace.plan, 32768], [run.model, 16384], [run.manager.policy, 1024], [run.manager.selection, 512], [run.manager.lastAccepted, 512], [run.manager.firstInhibit, 256], [run.manager.retirement, 128], [run.manager.counters, 256], [run.translation.releaseCommand, 512]] as const) expect(byteLength(value)).toBeLessThanOrEqual(cap)
  for (const capture of run.captures) { expect(capture.image!.rgba).toHaveLength(12288); expect(byteLength(capture.image!.rgba)).toBeLessThanOrEqual(49154) }
  expect(byteLength(run.manager) + 1).toBeLessThanOrEqual(12288)
  expect(byteLength({ releaseCommand: run.translation.releaseCommand }) + 1).toBeLessThanOrEqual(1024)
  expect(byteLength({ ...run.translation, rows: [], readinessSamples: [], releaseCommand: null })).toBeLessThanOrEqual(4096)
  expect(byteLength(run.translation) + 1).toBeLessThanOrEqual(393216)
  expect(byteLength(run.mission.trace) + 1).toBeLessThanOrEqual(8388608)
  const { mission, ...body } = run
  expect(byteLength({ ...body, mission: { ...mission, trace: null } }) + 1).toBeLessThanOrEqual(12582912)
  expect(byteLength(run) + 1).toBeLessThanOrEqual(20971520)
}
function expectSourceLossTruth(run: OracleRun) {
  const a = run.translation, s = run.shot.startedAtMs!, r = s + 1020, rows = a.rows, first = rows[0]!, last = rows.at(-1)!
  expect(rows).toHaveLength(51)
  for (const [i, row] of rows.entries()) {
    expect(row.atMs).toBe(s + (i + 1) * 20)
    if (row.atMs < r) expectNative(run, row.atMs)
    const native = run.mission.trace.rows.find(n => n.observation.nowMs === row.atMs)!
    const [x, y, z] = native.observation.positionM
    expect(native.observation.healthy).toBe(true); expect(native.observation.authority).toBe('autonomous')
    expect(native.observation.reference).toBe('55:0,0,0,0,0')
    expect(native.observation.origin).toEqual({ latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 })
    expect(Math.hypot(x - Math.max(0, Math.min(2, x)), y, z + 1.2)).toBeLessThanOrEqual(0.2)
  }
  expect(last.atMs).toBe(r)
  expect(run.shot.retirement.bodyPositionM).toEqual(last.positionM)
  expect(run.shot.retirement.bodyQuaternionWxyz).toEqual(last.quaternionWxyz)
  expect(run.mission.finalTruthPositionM).toEqual(last.positionM)
  expect(a.metrics.sampleCount).toBe(rows.length); expect(a.metrics.durationMs).toBe(last.atMs - first.atMs)
  expect(a.metrics.forwardDisplacementM).toBe(last.positionM[0] - first.positionM[0])
  const corridor = (p: V3) => Math.hypot(p[0] - Math.max(0, Math.min(2, p[0])), p[1], p[2] + 1.2)
  expect(a.metrics.maxCrossTrackM).toBe(Math.max(...rows.map(row => corridor(row.positionM))))
  expect(a.metrics.maxSpeedMps).toBe(Math.max(...rows.map(row => Math.hypot(...row.velocityMps))))
  expect(a.metrics.maxAccelerationMps2).toBe(Math.max(...rows.map(row => Math.hypot(...row.accelerationMps2))))
  let jerk = 0
  for (let i = 1; i < rows.length; i++) { const x = rows[i]!, prior = rows[i - 1]!; jerk = Math.max(jerk, Math.hypot((x.accelerationMps2[0] - prior.accelerationMps2[0]) / 0.020, (x.accelerationMps2[1] - prior.accelerationMps2[1]) / 0.020, (x.accelerationMps2[2] - prior.accelerationMps2[2]) / 0.020)) }
  expect(a.metrics.maxSampledJerkMps3).toBe(jerk)
  expect(a.metrics.captureForwardDisplacementM).toBeNull(); expect(a.metrics.captureForwardSpeedMps).toBeNull()
  expect(a.metrics.nominalWitness).toBe('not-evaluated'); expect(a.smoothnessQualified).toBe(false)
  const terminal = run.mission.trace.rows.at(-1)!
  expect(terminal.observation.nowMs).toBe(r); expect(terminal.action).toBe('abort')
  expect(terminal.result.state).toBe('aborted'); expect(terminal.result.reason).toBe('operator-abort')
  expect(run.mission.trace.rows.every(row => row.observation.nowMs <= r)).toBe(true)
  expect(run.targetObservations.at(-1)!.receivedAtMs).toBe(r)
  expect(run.gimbal.rows.at(-1)!.atMs).toBe(r)
  // The body has no post-terminal simulation samples; the owned relative-joint tail uses this frozen retirement pose.
  expect(run.gimbal.tail.at(-1)!.atMs).toBe(r + 2000)
  expect(run.gimbal.tail[0]!.accelerationRadS2).toEqual(run.gimbal.rows.at(-1)!.accelerationRadS2)
  expect(run.gimbal.tail[0]!.velocityRadS.some(v => v !== 0)).toBe(true)
  expect(replayTaskMotionMission(run.mission.trace).trace()).toEqual(run.mission.trace)
  expect(replayTaskMotionMission(run.mission.trace).snapshot()).toEqual(terminal.result)
}
test('FIRST saved source loss counted camera flight preserves expiry before renewal and ACK with real moving image', () => {
  const saved = firstSavedOrPublicSourceLoss(), run = saved.run
  expect(saved.captureEncoderAliases).toEqual([false])
  expect(run.scenario).toBe('source-expiry-with-foreign'); expect(run.version).toBe(4)
  expect(run.evidence).toBe('owned-cinema-counted-dolly-simulation'); expect(run.profile).toBe('straight-poi-dolly-counted-v1')
  expect(run.status).toBe('halted'); expect(run.reason).toBe('gimbal-source-expired')
  expect(run.physicalFlightEnabled).toBe(false); expect(run.physicalGimbalActuationEnabled).toBe(false); expect(run.identityAuthenticated).toBe(false)
  expect(run.selection.positionM).toEqual([4, 0, -1.2])
  expect(run.mission.trace.version).toBe(4); expect(run.mission.trace.plan).toEqual(expectedPlan().plan)
  expect(JSON.stringify(run.translation.taskRates)).toBe(JSON.stringify(run.mission.trace.plan.tasks.map(task => { if (!('speedMps' in task)) throw new Error('Expected spatial native task'); return { taskId: task.id, kind: task.kind, speedMps: task.speedMps } })))
  expect(run.translation.version).toBe(3); expect(run.translation.policy.handshake.encoderMethod).toBe('count-difference-v1')
  expect(run.mission.terminalState).toBe('aborted'); expect(run.mission.terminalReason).toBe('operator-abort')
  expect(run.mission.boardNeutral).toBe(true); expect(run.mission.boardMotorsN).toEqual([0, 0, 0, 0]); expect(run.mission.boardFault).toBeNull()
  expect(run.shot.startedAtMs).not.toBeNull()
  expectReadiness(run); expectCountHistory(run); expectIndependentDynamics(run)
  const s = run.shot.startedAtMs!, r = s + 1020, n = s + 1000, a = run.translation
  expect(run.shot.phase).toBe('fault'); expect(run.shot.completedAtMs).toBeNull()
  expect(run.shot.firstFault).toEqual({ atMs: r, code: 'gimbal-source-expired' })
  expect(run.shot.retirement.atMs).toBe(r); expect(run.shot.retirement.cause).toBe('fault')
  expect(run.shot.retirement.requestedTorqueNm).toEqual([0, 0, 0])
  expect(a.timeline.startAdmission).toBe('valid'); expect(a.timeline.normalCloseAdmission).toBe('not-attempted'); expect(a.timeline.firstInvalidJoin).toBeNull()
  expect(run.reconciliation).toEqual({ invalidCaptureSequences: [], earliestInvalidAtMs: null })
  expect(run.shot.counters.shutterAttempts).toBe(1); expect(run.shot.counters.ackReceipts).toBe(0)
  expect(run.shot.counters.confirmedCaptures).toBe(0); expect(run.shot.counters.uncertainCaptures).toBe(1)
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0); expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.captures).toHaveLength(1)
  const capture = run.captures[0]!, held = run.manager.lastAccepted!
  expect(capture.sequence).toBe(1); expect(capture.shotOffsetMs).toBe(1000)
  expect(capture.issuedAtMs).toBe(n); expect(capture.capturedAtMs).toBe(n)
  expect(capture.state).toBe('uncertain'); expect(capture.reason).toBe('gimbal-source-expired')
  expect(capture.ack).toBeNull(); expect(capture.postStepAdmission).toBe('valid')
  expect(capture.actual).not.toBeNull(); expect(capture.image).not.toBeNull()
  expect(capture.encoder).toEqual(run.encoderObservations.find(p => p.receivedAtMs === n)!)
  expect(capture.encoder.capturedAtMs).toBe(s + 980)
  expect(capture.pose.capturedAtMs).toBe(n); expect(capture.pose.positionPredictedToMs).toBe(n); expect(capture.pose.attitudePredictedToMs).toBe(n)
  for (const [at, maxAge] of [[capture.pose.positionCapturedAtMs, 200], [capture.pose.attitudeCapturedAtMs, 60], [capture.pose.gyroCapturedAtMs, 80]]) expect(at! >= 0 && at! <= n && n - at! <= maxAge!).toBe(true)
  expect(capture.image!.rgba).toEqual(raster(capture.actual!))
  const measured = magenta(capture.image!.rgba), expectedX = 32 - 40 * Math.tan(8 * Math.PI / 180 * (379 / 2187))
  expect(measured.count).toBeGreaterThan(0)
  // This is the original single real image, with its actual held command and independent intended optical reference.
  expect(Math.hypot(measured.x - expectedX, measured.y - 24)).toBeLessThanOrEqual(2)
  expect(capture.quality.observedPixel).toEqual([measured.x, measured.y])
  expectNative(run, n)
  const truth = a.rows.find(row => row.atMs === n)!, physical = run.gimbal.rows.find(row => row.atMs === n)!
  expect(capture.actual!.bodyPositionM).toEqual(truth.positionM); expect(capture.actual!.bodyQuaternionWxyz).toEqual(truth.quaternionWxyz)
  expect(capture.actual!.jointPositionRad).toEqual(physical.positionRad); expect(capture.actual!.appliedTorqueNm).toEqual(physical.appliedTorqueNm)
  const displacement = truth.positionM[0] - a.rows[0]!.positionM[0]
  expect(displacement).toBeGreaterThan(0); expect(truth.velocityMps[0]).toBeGreaterThan(0)
  expect(a.metrics.firstExposureForwardDisplacementM).toBe(displacement); expect(a.metrics.firstExposureForwardSpeedMps).toBe(truth.velocityMps[0]); expect(a.metrics.sourceMotionWitness).toBe('satisfied')
  expect(held.issuedAtMs).toBe(s + 940); expect(held.expiresAtMs).toBe(r)
  expect(run.manager.firstInhibit).toEqual({ atMs: r, code: 'gimbal-source-expired' })
  expect(run.manager.captureCommands).toEqual([{ captureSequence: 1, atMs: n, command: held }])
  expect(run.manager.foreignRejections).toEqual([{ atMs: n, sourceKind: 'operator', sourceId: 'foreign-operator-v1', selectedIssuedAtMs: s + 940, selectedExpiresAtMs: r, rejection: 'foreign' }])
  expect(run.manager.counters.rejectedForeignCommands).toBe(1); expect(run.manager.counters.rejectedSelectedCommands).toBe(0); expect(run.manager.counters.commandsAfterRetirement).toBe(0)
  expect(run.manager.counters.acceptedCommands).toBe((s + 940 - run.shot.loiterObservedAtMs!) / 20 + 1)
  expect(run.shot.counters.trackingCommands).toBe(run.manager.counters.acceptedCommands + 3)
  expect(run.manager.transitions.map(t => [t.to, t.reason])).toEqual([['active', 'selected-command'], ['inhibited', 'gimbal-source-expired'], ['retired', 'session-retired']])
  expect(run.manager.retirement).toEqual({ atMs: r, directive: 'zero-requested-torque' })
  const beforeRequest = run.gimbal.rows.find(row => row.atMs === n + 4)!
  expect(beforeRequest.requestedAtMs).toBe(n)
  for (let axis = 0; axis < 3; axis++) expect(beforeRequest.requestedTorqueNm[axis]!).toBe(Math.max(-0.02, Math.min(0.02, 0.12 * (held.goalRad[axis]! - capture.encoder.positionRad[axis]!) - 0.04 * capture.encoder.velocityRadS![axis]!)))
  const renewalPacket = run.encoderObservations.find(p => p.receivedAtMs === r)!, renewalTarget = run.targetObservations.find(p => p.receivedAtMs === r)!
  expect(renewalPacket.limitSwitch).toBe(false); expect(renewalTarget.positionM).toEqual([4, 0, -1.2]); expect(renewalTarget.capturedAtMs).toBe(r)
  expect(run.gimbal.rows.at(-1)!.requestedAtMs).toBe(r - 20)
  expect(run.evaluation.frames.exposed).toBe(1); expect(run.evaluation.frames.confirmed).toBe(0); expect(run.evaluation.frames.qualified).toBe(0); expect(run.evaluation.qualified).toBe(false)
  expectSourceLossTruth(run); expectSourceLossCaps(run)
}, 70000)

// Public envelope seam catches caller-controlled reflection without starting a world for invalid data.
test('counted translation rejects closed-envelope violations without reading caller traps or private text', () => {
  let reads = 0
  const proxy = new Proxy({}, { getPrototypeOf() { reads++; throw new Error('private') }, ownKeys() { reads++; throw new Error('private') }, get() { reads++; throw new Error('private') } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const hidden = Object.defineProperty({}, 'scenario', { value: 'nominal', enumerable: false })
  const accessor = Object.defineProperty({}, 'scenario', { get() { reads++; throw new Error('private') }, enumerable: true })
  const bad = [null, [], 1, true, 'nominal', () => {}, proxy, revoked.proxy, Object.create(null), Object.create({ scenario: 'nominal' }), hidden, accessor, { scenario: undefined }, { scenario: null }, { scenario: ['nominal'] }, { scenario: 'body-disturbance' }, { scenario: 'private' }, { provider: true }, { [Symbol('private')]: 'nominal' }]
  for (const input of bad) expect(() => cinema.simulateCountedTranslatingCinema(input)).toThrow(new TypeError('cinema-counted-translation-input'))
  expect(reads).toBe(0)
  expect(cinema.cinemaCountedTranslationScenarios).toEqual(['nominal', 'source-expiry-with-foreign'])
})

// Public result seam checks snapshot ownership. It is authored now and executes only after separate bounded-test GO.
test('counted translation returns detached packet, plant, method and capture facts', () => {
  const input = Object.freeze({ scenario: 'source-expiry-with-foreign' })
  const run = cinema.simulateCountedTranslatingCinema(input)
  const capture = run.captures[0]!, packet = run.encoderObservations.find(p => p.receivedAtMs === capture.issuedAtMs)!, plant = run.gimbal.rows.at(-1)!, boundary = run.gimbal.tail[0]!
  const packetBefore = JSON.stringify(packet), plantBefore = JSON.stringify(plant), methodBefore = JSON.stringify(run.model.encoderMeasurement)
  expect(capture.encoder).not.toBe(packet); expect(capture.encoder.positionCounts).not.toBe(packet.positionCounts)
  expect(capture.encoder.deltaCounts).not.toBe(packet.deltaCounts); expect(capture.encoder.positionRad).not.toBe(packet.positionRad); expect(capture.encoder.velocityRadS).not.toBe(packet.velocityRadS)
  expect(boundary.positionRad).not.toBe(plant.positionRad); expect(boundary.velocityRadS).not.toBe(plant.velocityRadS)
  expect(capture.actual!.bodyPositionM).not.toBe(run.translation.rows.find(row => row.atMs === capture.issuedAtMs)!.positionM)
  capture.encoder.positionCounts[0] = 8000; capture.encoder.positionRad[0] = 8
  capture.actual!.bodyPositionM[0] = 99; boundary.positionRad[0] = 99
  expect(JSON.stringify(packet)).toBe(packetBefore); expect(JSON.stringify(plant)).toBe(plantBefore)
  expect(Reflect.set(run.model.encoderMeasurement, 'quantumRad', 9)).toBe(true)
  const after = cinema.simulateCountedTranslatingCinema({ scenario: 'source-expiry-with-foreign' })
  expect(input).toEqual({ scenario: 'source-expiry-with-foreign' })
  expect(after.model.encoderMeasurement).not.toBe(run.model.encoderMeasurement)
  expect(JSON.stringify(after.model.encoderMeasurement)).toBe(methodBefore)
  expect(after.captures[0]!.encoder).toEqual(packet)
  expect(after.gimbal.rows.at(-1)).toEqual(plant)
}, 70000)
