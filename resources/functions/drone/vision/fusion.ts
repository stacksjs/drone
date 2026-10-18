import type { SensorVector } from '../sensors/types'
import type { TrackingSnapshot } from '../camera/types'
import { validBox } from '../camera/tracker'
import type { VisionFusionSnapshot, VisionMetricObservation, VisionPairing, VisionTargetFix } from './types'

function bounded(value: unknown, min: number, max: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}
function identifier(value: unknown) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\u0000-\u001F\u007F]/.test(value)
}
function vector(value: unknown, bound = 5000) {
  return Array.isArray(value) && value.length === 3 && [0, 1, 2].every(index => bounded(value[index], -bound, bound))
}
function keys(value: unknown, expected: string[]) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function validPairing(pairing: VisionPairing) {
  return keys(pairing, ['cameraSessionId', 'lockId', 'calibrationId', 'depthSourceId', 'targetSourceId', 'targetSessionId', 'targetId', 'reference', 'visualToTargetOffsetM', 'offsetSigmaM'])
    && [pairing.cameraSessionId, pairing.lockId, pairing.calibrationId, pairing.depthSourceId, pairing.targetSourceId, pairing.targetSessionId, pairing.targetId, pairing.reference].every(identifier)
    && vector(pairing.visualToTargetOffsetM, 2) && Math.hypot(...pairing.visualToTargetOffsetM) <= 2
    && bounded(pairing.offsetSigmaM, 0, 1) && pairing.offsetSigmaM > 0
}
function validTracking(tracking: TrackingSnapshot, lockId: string, nowMs: number) {
  if (!tracking || tracking.state !== 'tracking' || tracking.confirmed !== true
    || !tracking.selected || tracking.selected.id !== lockId || !identifier(lockId)
    || !Number.isSafeInteger(tracking.sequence) || tracking.sequence! < 0
    || !keys(tracking.association, ['frameSequence', 'candidateId', 'capturedAtMs'])
    || !tracking.association || tracking.association.frameSequence !== tracking.sequence
    || !identifier(tracking.association.candidateId)
    || !bounded(tracking.association.capturedAtMs, Math.max(0, nowMs - 200), nowMs)
    || tracking.selected.lastSeenAtMs !== tracking.association.capturedAtMs
    || !Number.isSafeInteger(tracking.selected.confirmations) || tracking.selected.confirmations < 2 || tracking.selected.confirmations > 20
    || !validBox(tracking.selected.box) || !bounded(tracking.selected.confidence, 0, 1)
    || !Array.isArray(tracking.candidates) || tracking.candidates.length < 1 || tracking.candidates.length > 32
    || !tracking.observation || !bounded(tracking.observation.horizontalError, -1, 1) || !bounded(tracking.observation.verticalError, -1, 1)) return false
  if (Array.from(tracking.candidates).some(candidate => !candidate || !identifier(candidate.id) || candidate.label !== 'person' || !validBox(candidate.box) || !bounded(candidate.confidence, 0, 1))) return false
  const matches = tracking.candidates.filter(candidate => candidate && candidate.id === tracking.association!.candidateId)
  const candidate = matches[0]
  return matches.length === 1 && !!candidate && candidate.label === 'person'
    && candidate.confidence === tracking.selected.confidence && validBox(candidate.box)
    && candidate.box.x === tracking.selected.box.x && candidate.box.y === tracking.selected.box.y
    && candidate.box.width === tracking.selected.box.width && candidate.box.height === tracking.selected.box.height
    && Math.abs(tracking.observation.horizontalError - 2 * (candidate.box.x + candidate.box.width / 2 - 0.5)) < 1e-9
    && Math.abs(tracking.observation.verticalError - 2 * (candidate.box.y + candidate.box.height / 2 - 0.5)) < 1e-9
}

function fresh(capturedAtMs: number, receivedAtMs: number, nowMs: number) {
  return bounded(capturedAtMs, Math.max(0, nowMs - 200), nowMs) && bounded(receivedAtMs, capturedAtMs, nowMs)
}
function evidence(value: unknown) {
  return value === 'synthetic' || value === 'declared-bench'
}
function validVision(vision: VisionMetricObservation, pairing: VisionPairing, tracking: TrackingSnapshot, nowMs: number) {
  return keys(vision, ['evidence', 'calibrationId', 'cameraSessionId', 'lockId', 'candidateId', 'frameSequence', 'depthSourceId', 'depthSequence', 'reference', 'capturedAtMs', 'receivedAtMs', 'validUntilMs', 'positionM', 'sigmaM', 'physicalFlightEnabled'])
    && evidence(vision.evidence) && vision.physicalFlightEnabled === false
    && vision.calibrationId === pairing.calibrationId && vision.cameraSessionId === pairing.cameraSessionId
    && vision.lockId === pairing.lockId && vision.depthSourceId === pairing.depthSourceId && vision.reference === pairing.reference
    && vision.frameSequence === tracking.association!.frameSequence && vision.candidateId === tracking.association!.candidateId
    && vision.capturedAtMs === tracking.association!.capturedAtMs
    && Number.isSafeInteger(vision.depthSequence) && vision.depthSequence >= 0
    && bounded(vision.validUntilMs, vision.capturedAtMs, Math.min(Number.MAX_SAFE_INTEGER, vision.capturedAtMs + 200)) && nowMs <= vision.validUntilMs
    && fresh(vision.capturedAtMs, vision.receivedAtMs, nowMs) && vector(vision.positionM) && bounded(vision.sigmaM, 0.0001, 10)
}
function validFix(fix: VisionTargetFix, pairing: VisionPairing, nowMs: number) {
  return keys(fix, ['evidence', 'sourceId', 'sessionId', 'targetId', 'reference', 'sequence', 'capturedAtMs', 'receivedAtMs', 'positionM', 'sigmaM'])
    && evidence(fix.evidence) && fix.sourceId === pairing.targetSourceId && fix.sessionId === pairing.targetSessionId
    && fix.targetId === pairing.targetId && fix.reference === pairing.reference
    && Number.isSafeInteger(fix.sequence) && fix.sequence >= 0
    && fresh(fix.capturedAtMs, fix.receivedAtMs, nowMs) && vector(fix.positionM) && bounded(fix.sigmaM, 0.0001, 10)
}

interface AcceptedMeasurement {
  sequence: number
  capturedAtMs: number
  positionM: SensorVector
  sigmaM: number
  signature: string
}
function compatible(previous: AcceptedMeasurement | null, next: AcceptedMeasurement) {
  if (!previous) return true
  if (next.sequence === previous.sequence) return next.signature === previous.signature
  if (next.sequence < previous.sequence || next.capturedAtMs <= previous.capturedAtMs) return false
  const distanceM = Math.hypot(...next.positionM.map((v, i) => v - previous.positionM[i]!))
  return distanceM <= 2 * (next.capturedAtMs - previous.capturedAtMs) / 1000 + previous.sigmaM + next.sigmaM
}
function visionSignature(vision: VisionMetricObservation, tracking: TrackingSnapshot) {
  return JSON.stringify([
    vision.evidence, vision.calibrationId, vision.cameraSessionId, vision.lockId, vision.candidateId, vision.frameSequence,
    vision.depthSourceId, vision.depthSequence, vision.reference, vision.capturedAtMs, vision.receivedAtMs, vision.validUntilMs, vision.positionM, vision.sigmaM, vision.physicalFlightEnabled,
    tracking.selected!.id, tracking.selected!.lastSeenAtMs, tracking.selected!.confirmations,
    tracking.candidates.map(candidate => [candidate.id, candidate.label, candidate.confidence, candidate.box.x, candidate.box.y, candidate.box.width, candidate.box.height]),
  ])
}
function fixSignature(fix: VisionTargetFix) {
  return JSON.stringify([fix.evidence, fix.sourceId, fix.sessionId, fix.targetId, fix.reference, fix.sequence, fix.capturedAtMs, fix.receivedAtMs, fix.positionM, fix.sigmaM])
}

/** Explicitly paired observations share unknown pose/calibration correlations. CI does not assume independence. */
export function createVisionTargetFusion() {
  let current: VisionFusionSnapshot = { state: 'unpaired', reason: 'Select and pair the visual lock and target source', pairing: null, target: null, innovationM: null, physicalFlightEnabled: false }
  let lastNow = -Infinity
  let acceptedEvidence: VisionMetricObservation['evidence'] | null = null
  let previousVision: AcceptedMeasurement | null = null
  let previousFix: AcceptedMeasurement | null = null
  let previousDepthSequence = -1
  const snapshot = () => structuredClone(current)
  function lose(reason: string) {
    current = { ...current, state: 'lost', reason, target: null, innovationM: null }
    return snapshot()
  }
  return {
    snapshot,
    clear() {
      lastNow = -Infinity
      acceptedEvidence = null
      previousVision = null
      previousFix = null
      previousDepthSequence = -1
      current = { state: 'unpaired', reason: 'Select and pair the visual lock and target source', pairing: null, target: null, innovationM: null, physicalFlightEnabled: false }
      return snapshot()
    },
    pair(pairing: VisionPairing, tracking: TrackingSnapshot, nowMs: number) {
      if (current.state === 'lost') return snapshot()
      if (current.state !== 'unpaired') return lose('Clear before creating a new pairing')
      if (!bounded(nowMs, 0, Number.MAX_SAFE_INTEGER) || nowMs < lastNow) return lose('Clock discontinuity; clear and pair again')
      lastNow = nowMs
      if (!validPairing(pairing) || !validTracking(tracking, pairing.lockId, nowMs)) return lose('Invalid pairing or selected visual lock; clear and pair again')
      current = { ...current, state: 'paired', reason: 'Awaiting paired measurements', pairing: structuredClone(pairing), target: null }
      return snapshot()
    },
    step(input: { nowMs: number, tracking: TrackingSnapshot, vision: VisionMetricObservation | null, fix: VisionTargetFix | null }) {
      if (current.state === 'lost') return snapshot()
      if (!input || !bounded(input.nowMs, 0, Number.MAX_SAFE_INTEGER) || input.nowMs < lastNow) return lose('Clock discontinuity; clear and pair again')
      lastNow = input.nowMs
      if (!current.pairing) return snapshot()
      const { vision, fix, tracking, nowMs } = input
      if (!validTracking(tracking, current.pairing.lockId, nowMs)) return lose('Selected visual lock lost or changed; clear and pair again')
      if (!vision || !fix) return lose('Missing paired metric or target fix; clear and pair again')
      if (!validVision(vision, current.pairing, tracking, nowMs) || !validFix(fix, current.pairing, nowMs)
        || vision.evidence !== fix.evidence || (acceptedEvidence !== null && acceptedEvidence !== vision.evidence)) return lose('Invalid measurement scope, evidence, synchronization or freshness; clear and pair again')
      const nextVision: AcceptedMeasurement = { sequence: vision.frameSequence, capturedAtMs: vision.capturedAtMs, positionM: [...vision.positionM], sigmaM: vision.sigmaM, signature: visionSignature(vision, tracking) }
      const nextFix: AcceptedMeasurement = { sequence: fix.sequence, capturedAtMs: fix.capturedAtMs, positionM: [...fix.positionM], sigmaM: fix.sigmaM, signature: fixSignature(fix) }
      if (!compatible(previousVision, nextVision) || !compatible(previousFix, nextFix)
        || (previousVision !== null && nextVision.sequence > previousVision.sequence && vision.depthSequence <= previousDepthSequence)) return lose('Measurement replay, mutation or target speed exceeded; clear and pair again')
      const skewMs = Math.abs(vision.capturedAtMs - fix.capturedAtMs)
      if (skewMs > 80) return lose('Vision and selected target fix are not synchronized; clear and pair again')
      const visual = vision.positionM.map((v, i) => v + current.pairing!.visualToTargetOffsetM[i]!)
      const innovationM = Math.hypot(...visual.map((v, i) => v - fix.positionM[i]!))
      const innovationLimitM = Math.min(1.5, 3 * (vision.sigmaM + fix.sigmaM + current.pairing.offsetSigmaM) + 2 * skewMs / 1000)
      if (innovationM > innovationLimitM) return lose('Paired sources disagree; clear and pair again')
      // Both describe the oldest capture epoch. Bound unknown target motion of the later observation.
      const a = (vision.sigmaM + current.pairing.offsetSigmaM + 2 * Math.max(0, vision.capturedAtMs - fix.capturedAtMs) / 1000) ** 2
      const b = (fix.sigmaM + 2 * Math.max(0, fix.capturedAtMs - vision.capturedAtMs) / 1000) ** 2
      const variance = 1 / (0.5 / a + 0.5 / b)
      const positionM = visual.map((v, i) => variance * (0.5 * v / a + 0.5 * fix.positionM[i]! / b)) as SensorVector
      const sigmaM = Math.sqrt(variance)
      if (!vector(positionM) || !bounded(sigmaM, 0.0001, 10)) return lose('Fused target exceeds metric bounds; clear and pair again')
      const capturedAtMs = Math.min(vision.capturedAtMs, fix.capturedAtMs)
      if (current.target) {
        const displacementM = Math.hypot(...positionM.map((v, i) => v - current.target!.positionM[i]!))
        const allowedM = 2 * (capturedAtMs - current.target.capturedAtMs) / 1000 + current.target.sigmaM + sigmaM
        if (displacementM > allowedM) return lose('Fused target speed exceeded; clear and pair again')
      }
      acceptedEvidence = vision.evidence
      previousVision = nextVision
      previousFix = nextFix
      previousDepthSequence = vision.depthSequence
      current = {
        ...current, state: 'tracking', reason: 'Paired metric target tracked', innovationM,
        target: { id: current.pairing.targetId, reference: current.pairing.reference, positionM, capturedAtMs, validUntilMs: Math.min(vision.validUntilMs, fix.capturedAtMs + 200), sigmaM },
      }
      return snapshot()
    },
  }
}
