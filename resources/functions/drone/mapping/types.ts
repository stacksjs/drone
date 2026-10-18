import type { GeodeticOrigin, Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { VisionCalibration, VisionValidationSample } from '../vision/types'
import type { MissionPlan } from '../missions/plan'
import type { MissionTrace } from '../missions/engine'

export type SurveyPoint = [number, number]
export interface SurveyConfig {
  version: 1
  id: string
  origin: GeodeticOrigin
  boundary: SurveyPoint[]
  holes: SurveyPoint[][]
  altitudeAglM: number
  maxGsdM: number
  overlap: { front: number, side: number }
  headingDeg: number
  crosshatch: boolean
  terrain: { downAtOriginM: number, gradient: SurveyPoint }
  speedMps: number
  minTriggerIntervalMs: number
  exposureTimeUs: number
  power: { availableWh: number, hoverW: number, reservePercent: number }
  calibration: VisionCalibration
  heldOut: VisionValidationSample[]
}
export interface SurveyLane { id: string, fromM: SensorVector, toM: SensorVector, lengthM: number, headingDeg: number }
export interface SurveyPlan {
  version: 1
  config: SurveyConfig
  areaM2: number
  lanes: SurveyLane[]
  footprintM: { along: number, across: number }
  gsdM: number
  captureSpacingM: number
  triggerIntervalMs: number
  estimatedPhotos: number
  distanceM: number
  estimatedSeconds: number
  requiredWh: number
  assumptions: string[]
}
export interface SurveyPose {
  capturedAtMs: number
  reference: string
  positionM: SensorVector
  quaternionWxyz: Quaternion
  cameraPositionM: SensorVector
  geodetic: GeodeticOrigin
  positionSigmaM: number
  headingAlignment: 'initial-simulation-north'
  positionCapturedAtMs: number
  attitudeCapturedAtMs: number
  attitudePrediction: 'qualified-gyro-hold'
}
export interface SurveyCapture {
  id: string
  filename: string
  laneId: string
  sessionId: string
  sequence: number
  issuedAtMs: number
  capturedAtMs: number
  acknowledgedAtMs: number
  exposureTimeUs: number
  timestampReference: 'synthetic-exposure-midpoint'
  clockDomain: 'fixture-monotonic-ms'
  clockUncertaintyMs: number
  calibrationId: string
  pose: SurveyPose
  width: number
  height: number
  rgba: Uint8Array
  footprintM: SurveyPoint[]
  rtk: { status: 'unavailable', reason: string }
  ppk: { status: 'unavailable', reason: string }
  gcps: { status: 'unavailable', reason: string }
}
export interface SurveyRun {
  version: 1
  evidence: 'owned-mapping-physics-simulation'
  physicalFlightEnabled: false
  collectionOnly: true
  reconstructionPerformed: false
  plan: SurveyPlan
  mission: MissionPlan
  trace: MissionTrace
  status: 'completed' | 'aborted' | 'blocked' | 'incomplete'
  reason: string
  captures: SurveyCapture[]
  boardNeutral: boolean
  path: { atMs: number, positionM: SensorVector | null, targetM: SensorVector | null, taskId: string, state: string }[]
}
