import type { TaskMotionMissionTrace, TaskMotionMissionSnapshot, TaskMotionMissionReason } from '../missions/engine'
import type { TaskMotionMissionTask } from '../missions/plan'
import type { GimbalCommandToken } from '../payloads/gimbal-authority'
import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { GimbalInhibitCode } from '../payloads/gimbal-authority'
import type { CinemaFaultCode, CinemaReason } from './types'
import type { CinemaCountedEncoder, CinemaCountedEncoderMethod } from './counted-encoder'
import type { CinemaManagedCapture, CinemaManagedRun, CinemaManagedShot } from './managed-types'

export const cinemaCountedTranslationScenarios = ['nominal', 'source-expiry-with-foreign'] as const
export type CinemaCountedTranslationScenario = typeof cinemaCountedTranslationScenarios[number]
export type CinemaCountedMoveFault = 'move-not-ready' | 'active-move-lost'
export type CinemaCountedTranslationFaultCode = CinemaFaultCode | GimbalInhibitCode | CinemaCountedMoveFault
export type CinemaCountedTranslationReason = CinemaReason | GimbalInhibitCode | CinemaCountedMoveFault | 'translation-not-observed'
export type CinemaCountedTranslationCapture = Omit<CinemaManagedCapture, 'reason' | 'encoder'> & { reason: CinemaManagedCapture['reason'] | CinemaCountedMoveFault, encoder: CinemaCountedEncoder }
export type CinemaCountedTranslationShot = Omit<CinemaManagedShot, 'firstFault'> & { firstFault: { atMs: number, code: CinemaCountedTranslationFaultCode } | null }
export interface CinemaCountedTranslationRow { atMs: number, positionM: SensorVector, velocityMps: SensorVector, accelerationMps2: SensorVector, quaternionWxyz: Quaternion }
export interface CinemaCountedTranslationJoin { atMs: number, kind: 'start' | 'exposure' | 'ack' | 'normal-close', reason: 'missing-row' | 'unhealthy' | 'authority' | 'reference' | 'origin' | 'state' | 'task' | 'entry-transition' }
export interface CinemaCountedReadinessSample { atMs: number, quaternionWxyz: Quaternion, positionCapturedAtMs: number, attitudeCapturedAtMs: number, gyroCapturedAtMs: number }
export interface CinemaCountedTranslationAudit {
  version: 3
  evidence: 'owned-cinema-translation-audit'
  frame: 'LOCAL_NED'
  fromM: [0, 0, -1.2]
  toM: [2, 0, -1.2]
  planDefaultSpeedMps: number
  taskRates: { taskId: string, kind: Extract<TaskMotionMissionTask, { speedMps: number }>['kind'], speedMps: number }[]
  policy: { kind: 'native-waypoint-speed-ramp', stageTaskId: 'stage', moveTaskId: 'dolly', startGridMs: 20, maxMoveEntryAfterStageMs: 1600, movingEstimatedCorridorM: 0.2, shotDurationMs: 8000, truthCadenceMs: 20, truthFirstOffsetMs: 20, jerkQualification: 'unqualified-at-4ms', handshake: { nativeVersion: 4, readinessSourceId: 'cinema-stage-counted-v1', minimumDwellMs: 1500, taskTimeoutMs: 3000, posePrediction: 'qualified-gyro-hold', predictedEpoch: 'current-policy-epoch', encoderMethod: 'count-difference-v1' } }
  timeline: { stageEnteredAtMs: number | null, moveEnteredAtMs: number | null, moveObservedAtMs: number | null, readyThroughAtMs: number | null, readySamplesAtEntry: number | null, startAdmission: 'not-started' | 'valid' | 'invalid', normalCloseAdmission: 'not-attempted' | 'valid' | 'invalid', firstInvalidJoin: CinemaCountedTranslationJoin | null }
  readinessSamples: CinemaCountedReadinessSample[]
  releaseCommand: GimbalCommandToken | null
  metrics: { sampleCount: number, durationMs: number | null, forwardDisplacementM: number | null, maxCrossTrackM: number | null, maxSpeedMps: number | null, maxAccelerationMps2: number | null, maxSampledJerkMps3: number | null, captureForwardDisplacementM: number | null, captureForwardSpeedMps: SensorVector | null, firstExposureForwardDisplacementM: number | null, firstExposureForwardSpeedMps: number | null, nominalWitness: 'not-evaluated' | 'satisfied' | 'failed', sourceMotionWitness: 'not-evaluated' | 'satisfied' | 'failed' }
  smoothnessQualified: false
  rows: CinemaCountedTranslationRow[]
}
export type CinemaCountedTranslationRun = Omit<CinemaManagedRun, 'version' | 'evidence' | 'profile' | 'scenario' | 'reason' | 'shot' | 'captures' | 'mission' | 'model' | 'encoderObservations'> & { version: 4, evidence: 'owned-cinema-counted-dolly-simulation', profile: 'straight-poi-dolly-counted-v1', scenario: CinemaCountedTranslationScenario, reason: CinemaCountedTranslationReason, shot: CinemaCountedTranslationShot, captures: CinemaCountedTranslationCapture[], model: CinemaManagedRun['model'] & { encoderMeasurement: CinemaCountedEncoderMethod }, encoderObservations: CinemaCountedEncoder[], mission: { trace: TaskMotionMissionTrace, terminalState: TaskMotionMissionSnapshot['state'], terminalReason: TaskMotionMissionReason, boardMotorsN: [number, number, number, number], boardFault: string | null, boardNeutral: boolean, finalTruthPositionM: SensorVector }, translation: CinemaCountedTranslationAudit }
