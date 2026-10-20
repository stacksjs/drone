import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { MissionState, MissionTrace } from '../missions/engine'
import type { VehicleMeasurementPose } from '../vehicles/types'
import type { cinemaModel } from './camera'

export const cinemaScenarios = ['nominal', 'body-disturbance', 'target-loss', 'mechanical-limit', 'camera-loss', 'wrong-ack', 'rc-override'] as const
export type CinemaScenario = typeof cinemaScenarios[number]
export type CinemaFaultCode = 'authority-lost' | 'pose-unqualified' | 'reference-changed' | 'target-unqualified' | 'target-stale' | 'joint-goal-limit' | 'encoder-unqualified' | 'joint-limit' | 'ack-scope' | 'ack-deadline' | 'shutter-failed' | 'active-loiter-lost' | 'capture-missing' | 'horizon-exhausted'
export type CinemaReason = CinemaFaultCode | 'qualified' | 'readiness-window-missed' | 'shot-incomplete' | 'mission-not-completed' | 'mission-nonneutral' | 'admission-reconciliation' | 'frame-quality' | 'motion-bounds'
export type CinemaReference = '55:0,0,0,0,0'
export interface CinemaSelection { id: 'selected-prop', revision: 1, source: 'synthetic-local-poi', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, reference: CinemaReference, positionM: SensorVector }
export interface CinemaTarget { sequence: number, capturedAtMs: number, receivedAtMs: number, targetId: 'selected-prop', revision: 1, reference: CinemaReference, positionM: SensorVector, positionSigmaM: 0.01, clockUncertaintyMs: 0 }
export interface CinemaEncoder { sequence: number, capturedAtMs: number, receivedAtMs: number, positionRad: SensorVector, velocityRadS: SensorVector | null, limitSwitch: boolean }
export interface CinemaPlantRow { atMs: number, requestedAtMs: number, requestedTorqueNm: SensorVector, appliedTorqueNm: SensorVector, positionRad: SensorVector, velocityRadS: SensorVector, accelerationRadS2: SensorVector }
export interface CinemaRetirement { atMs: number, cause: 'shot-completed' | 'fault' | 'window-missed' | 'mission-terminal' | 'horizon-exhausted', requestedTorqueNm: [0, 0, 0], bodyPositionM: SensorVector, bodyQuaternionWxyz: Quaternion }
export interface CinemaFault { atMs: number, code: CinemaFaultCode }
export interface CinemaCounters { trackingCommands: number, shutterAttempts: number, ackReceipts: number, confirmedCaptures: number, uncertainCaptures: number, trackingCommandsAfterRetirement: number, shutterAttemptsAfterRetirement: number }
export interface CinemaShot { phase: 'not-started' | 'completed' | 'fault' | 'incomplete', loiterObservedAtMs: number | null, latestStartMs: number | null, readySinceMs: number | null, readySampleCount: number, startedAtMs: number | null, completedAtMs: number | null, reference: CinemaReference | null, firstFault: CinemaFault | null, retirement: CinemaRetirement, counters: CinemaCounters }
export interface CinemaAck { sessionId: string, sequence: number, reference: CinemaReference | 'wrong-reference', issuedAtMs: number, capturedAtMs: number, acknowledgedAtMs: number, receivedAtMs: number }
export interface CinemaActualCapture { bodyPositionM: SensorVector, bodyQuaternionWxyz: Quaternion, jointPositionRad: SensorVector, appliedTorqueNm: SensorVector }
export interface CinemaImage { width: 64, height: 48, rgba: number[] }
export interface CinemaQuality { expectedPixel: [number, number], observedPixel: [number, number] | null, errorPx: number | null, markerPixels: number, qualified: boolean }
export interface CinemaCapture { sequence: 1 | 2 | 3, state: 'confirmed' | 'uncertain', reason: 'acknowledged' | CinemaFaultCode | 'mission-step-rejected' | 'capture-pending-at-retirement', sessionId: 'cinema-hover-v1', reference: CinemaReference, targetId: 'selected-prop', targetRevision: 1, shotOffsetMs: 1000 | 3000 | 7000, issuedAtMs: number, capturedAtMs: number | null, deadlineMs: number, calibrationId: 'synthetic-cinema-forward-v1', exposureLabelUs: 1000, pose: VehicleMeasurementPose, encoder: CinemaEncoder, actual: CinemaActualCapture | null, image: CinemaImage | null, ack: CinemaAck | null, postStepAdmission: 'valid' | 'invalid', quality: CinemaQuality }
export interface CinemaReconciliation { invalidCaptureSequences: number[], earliestInvalidAtMs: number | null }
export interface CinemaMotion { rows: number, tailRows: 501, maxRateRadS: number, maxAccelerationRadS2: number, maxJerkRadS3: number, maxAppliedTorqueNm: number, maxTorqueSlewNmS: number, withinDynamicBounds: boolean, withinMechanicalBounds: boolean }
export interface CinemaEvaluation { motion: CinemaMotion, frames: { exposed: number, confirmed: number, qualified: number, maxErrorPx: number | null }, qualified: boolean }
export interface CinemaRun { version: 1, evidence: 'owned-cinema-hover-reframe-simulation', profile: 'hover-poi-reframe-v1', scenario: CinemaScenario, status: 'completed' | 'halted' | 'incomplete' | 'failed', reason: CinemaReason, physicalFlightEnabled: false, physicalGimbalActuationEnabled: false, identityAuthenticated: false, selection: CinemaSelection, model: ReturnType<typeof cinemaModel>, mission: { trace: MissionTrace, terminalState: MissionState, terminalReason: string, boardMotorsN: [number, number, number, number], boardFault: string | null, boardNeutral: boolean, finalTruthPositionM: SensorVector }, shot: CinemaShot, gimbal: { rows: CinemaPlantRow[], tail: CinemaPlantRow[] }, targetObservations: CinemaTarget[], encoderObservations: CinemaEncoder[], captures: CinemaCapture[], reconciliation: CinemaReconciliation, evaluation: CinemaEvaluation }
