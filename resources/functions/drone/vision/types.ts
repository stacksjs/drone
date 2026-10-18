import type { TrackingSnapshot } from '../camera/types'
import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'

export type VisionEvidence = 'synthetic' | 'declared-bench'
/** Calibration pixels refer to one fixed lens/sensor mode before this explicit crop/scale. */
export interface VisionCalibration {
  version: 1
  id: string
  cameraId: string
  modeId: string
  evidence: VisionEvidence
  intrinsics: { width: number, height: number, fx: number, fy: number, cx: number, cy: number, distortion: [number, number, number, number, number] }
  output: { width: number, height: number, crop: [number, number, number, number] }
  /** Optical RDF to body FRD, then translation of the optical origin in body metres. */
  extrinsics: { quaternionWxyz: Quaternion, translationM: SensorVector }
  uncertainty: { pixelSigmaPx: number, depthSigmaM: number, translationSigmaM: number, rotationSigmaRad: number, modelSigmaM: number }
  timing: { clockUncertaintyMs: number, maxSkewMs: number, maxAgeMs: number }
}
/** Held-out correspondences, acquired independently of the calibration fit. Assertions are not provenance authentication. */
export interface VisionValidationSample {
  id: string
  /** Pixels in the calibrated output image, not normalized box coordinates. */
  pixel: [number, number]
  opticalDepthM: number
  bodyPointM: SensorVector
}
export interface VisionCalibrationReport {
  calibrationId: string
  evidence: VisionEvidence
  samples: number
  rmsErrorM: number
  maxErrorM: number
  minDepthM: number
  maxDepthM: number
  physicalCalibrationVerified: false
}
export interface VisionCameraEpoch {
  cameraId: string
  sessionId: string
  modeId: string
  frameSequence: number
  capturedAtMs: number
  receivedAtMs: number
}
/** Registered optical Z at the exact selected detection centre, not slant range or closest obstacle. */
export interface VisionDepthObservation {
  evidence: VisionEvidence
  sourceId: string
  sequence: number
  calibrationId: string
  cameraSessionId: string
  frameSequence: number
  candidateId: string
  capturedAtMs: number
  receivedAtMs: number
  /** Pixels in the calibrated output image, exactly at the normalized selected box centre scaled to that image. */
  pixel: [number, number]
  opticalDepthM: number
  sigmaM: number
  clockUncertaintyMs: number
}
export interface VisionCapturePose {
  evidence: VisionEvidence
  reference: string
  capturedAtMs: number
  positionM: SensorVector
  quaternionWxyz: Quaternion
  positionSigmaM: number
  attitudeSigmaRad: number
  clockUncertaintyMs: number
  headingAlignment: 'initial-simulation-north' | 'surveyed-body-to-ned'
}
export interface VisionLocalizationInput {
  nowMs: number
  tracking: TrackingSnapshot
  camera: VisionCameraEpoch
  depth: VisionDepthObservation | null
  pose: VisionCapturePose | null
}
export interface VisionMetricObservation {
  evidence: VisionEvidence
  calibrationId: string
  cameraSessionId: string
  lockId: string
  candidateId: string
  frameSequence: number
  depthSourceId: string
  depthSequence: number
  reference: string
  capturedAtMs: number
  receivedAtMs: number
  /** Inclusive local monotonic expiry preserving all capture clocks and the calibration age budget. */
  validUntilMs: number
  positionM: SensorVector
  /** Isotropic covariance upper bound, including shared pose/calibration and timing assumptions. */
  sigmaM: number
  physicalFlightEnabled: false
}
/** Independent selected GNSS source, in the exact same fixed NED frame and clock. */
export interface VisionTargetFix {
  evidence: VisionEvidence
  sourceId: string
  sessionId: string
  targetId: string
  reference: string
  sequence: number
  capturedAtMs: number
  receivedAtMs: number
  positionM: SensorVector
  sigmaM: number
}
export interface VisionPairing {
  cameraSessionId: string
  lockId: string
  calibrationId: string
  depthSourceId: string
  targetSourceId: string
  targetSessionId: string
  targetId: string
  reference: string
  /** Vector from the registered visible point to the GNSS target origin, in LOCAL_NED. */
  visualToTargetOffsetM: SensorVector
  offsetSigmaM: number
}
export interface VisionFusionSnapshot {
  state: 'unpaired' | 'paired' | 'tracking' | 'lost'
  reason: string
  pairing: VisionPairing | null
  target: { id: string, reference: string, positionM: SensorVector, capturedAtMs: number, validUntilMs: number, sigmaM: number } | null
  innovationM: number | null
  physicalFlightEnabled: false
}
