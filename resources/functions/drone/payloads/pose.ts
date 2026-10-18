import type { EstimatorSnapshot } from '../estimation/estimator'
import type { PayloadEvidence } from './types'
import { payloadLimits } from './types'
import { validVector } from '../controls/model'
const resetKeys = ['attitude', 'position', 'boot', 'manual', 'clock'] as const
export interface PayloadPose {
  snapshotAtMs: number
  attitudeAtMs: number
  positionMeasurementAtMs: number
  positionPredictedToMs: number
  bootId: bigint
  evidence: 'fixture' | 'handshake'
  origin: NonNullable<NonNullable<EstimatorSnapshot['localPosition']>['origin']>
  positionM: number[]
  quaternionWxyz: number[]
  frame: 'LOCAL_NED'
  attitudeReference: 'GRAVITY_ALIGNED_RELATIVE_YAW'
  altitudeDatum: 'WGS84_ELLIPSOID'
}
/** Nearest qualified snapshot, with explicit component epochs. No extrapolation, heading or camera calibration claim. */
export function createPayloadPoseTimeline() {
  let revision = 0, identity: string | null = null, lastReceived = -Infinity, lastSnapshot = -Infinity, reason = 'no-pose'
  let samples: PayloadPose[] = []
  function clear(why = 'operator-clear') { samples = []; identity = null; revision++; reason = why }
  return {
    clear,
    snapshot() { return { revision, samples: samples.length, reason, lastSnapshotAtMs: Number.isFinite(lastSnapshot) ? lastSnapshot : null } },
    record(e: EstimatorSnapshot, receivedAtMs: number) {
      if (!Number.isFinite(receivedAtMs) || receivedAtMs < 0 || receivedAtMs < lastReceived) { clear('pose-clock-discontinuity'); return false }
      lastReceived = receivedAtMs
      const a = e?.attitude, p = e?.localPosition
      if (!e || !a || !p || !e.health.tilt || !e.health.localPosition || e.physicalFlightEnabled !== false || !['fixture', 'handshake'].includes(e.evidence!) || typeof e.bootId !== 'bigint' || e.bootId <= 0n
        || !Number.isFinite(e.nowMs) || e.nowMs < 0 || e.nowMs > receivedAtMs || receivedAtMs - e.nowMs > payloadLimits.poseOffsetMs || e.nowMs <= lastSnapshot
        || !resetKeys.every(key => Number.isSafeInteger(e.resets[key]) && e.resets[key] >= 0)
        || a.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || a.capturedAtMs === null || !Number.isFinite(a.capturedAtMs) || a.capturedAtMs < 0 || a.capturedAtMs > e.nowMs || e.nowMs - a.capturedAtMs > 80
        || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'WGS84_ELLIPSOID' || !p.origin || ![p.origin.latitudeDeg, p.origin.longitudeDeg, p.origin.ellipsoidHeightM].every(Number.isFinite) || Math.abs(p.origin.latitudeDeg) > 90 || Math.abs(p.origin.longitudeDeg) > 180
        || p.capturedAtMs === null || !Number.isFinite(p.capturedAtMs) || p.capturedAtMs < 0 || p.capturedAtMs > e.nowMs || e.nowMs - p.capturedAtMs > 1500 || p.predictedToMs !== e.nowMs
        || !validVector(p.positionM) || !validVector(p.velocityMps) || a.quaternionWxyz.length !== 4 || !a.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...a.quaternionWxyz) - 1) > 1e-6) { clear('unqualified-pose'); return false }
      const context = JSON.stringify([String(e.bootId), e.evidence, e.resets, p.origin])
      if (identity !== null && identity !== context) clear('pose-reference-changed')
      identity = context; lastSnapshot = e.nowMs; reason = 'qualified'
      samples.push(structuredClone({ snapshotAtMs: e.nowMs, attitudeAtMs: a.capturedAtMs, positionMeasurementAtMs: p.capturedAtMs, positionPredictedToMs: p.predictedToMs, bootId: e.bootId, evidence: e.evidence!, origin: p.origin, positionM: p.positionM, quaternionWxyz: a.quaternionWxyz, frame: p.frame, attitudeReference: a.reference, altitudeDatum: p.altitudeDatum }))
      samples = samples.filter(s => s.snapshotAtMs >= e.nowMs - payloadLimits.poseWindowMs).slice(-payloadLimits.poseSamples)
      return true
    },
    associate(capture: { capturedAtMs: number, clockUncertaintyMs: number, evidence: PayloadEvidence }, expectedRevision: number) {
      const unavailable = (why: string) => ({ status: 'unavailable' as const, reason: why, offsetMs: null, pose: null, georeferenced: false as const })
      if (revision !== expectedRevision) return unavailable('pose-reference-changed-during-capture')
      if (!Number.isFinite(capture.capturedAtMs) || capture.capturedAtMs < 0 || !Number.isFinite(capture.clockUncertaintyMs) || capture.clockUncertaintyMs < 0 || capture.clockUncertaintyMs > payloadLimits.clockUncertaintyMs) return unavailable('capture-clock-unqualified')
      const expectedEvidence = capture.evidence === 'hardware' ? 'handshake' : 'fixture'
      const candidate = samples.filter(s => s.evidence === expectedEvidence && Math.abs(s.snapshotAtMs - capture.capturedAtMs) + capture.clockUncertaintyMs <= payloadLimits.poseOffsetMs
        && Math.abs(s.attitudeAtMs - capture.capturedAtMs) + capture.clockUncertaintyMs <= 80).sort((a, b) => Math.abs(a.snapshotAtMs - capture.capturedAtMs) - Math.abs(b.snapshotAtMs - capture.capturedAtMs))[0]
      if (!candidate) return unavailable('no-nearby-qualified-pose')
      return { status: 'associated' as const, reason: 'nearest-qualified-snapshot', offsetMs: candidate.snapshotAtMs - capture.capturedAtMs, pose: structuredClone(candidate), georeferenced: false as const }
    },
  }
}
export type PayloadPoseTimeline = ReturnType<typeof createPayloadPoseTimeline>
