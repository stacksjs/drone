import type { GeodeticOrigin } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { VisionCalibration, VisionValidationSample } from '../vision/types'
import type { MissionPlan } from '../missions/plan'
import type { MissionTrace } from '../missions/engine'
import type { VehicleMeasurementPose } from '../vehicles/types'

/** Bounded south-facing vertical bridge face. U=east, V=up, outward normal=south. */
export interface InspectionAsset {
  version: 1
  id: string
  revision: string
  kind: 'bridge-face'
  frame: 'LOCAL_NED'
  axes: 'EAST_UP_SOUTH'
  origin: GeodeticOrigin
  centerM: SensorVector
  widthM: number
  heightM: number
  registrationSigmaM: number
}
export interface InspectionConfig {
  version: 1
  id: string
  asset: InspectionAsset
  stations: { id: string, uM: number, vM: number }[]
  standOffM: number
  speedMps: number
  clearance: { minSeparationM: number, bodyRadiusM: number, positionBoundM: number, assetMotionBoundM: number, brakingAccelerationMps2: number, reactionMs: number }
  quality: { maxGsdM: number, maxBlurPx: number, minAssetFraction: number, maxPoseSigmaM: number, maxAttitudeSigmaRad: number, maxStationOffsetM: number }
  exposureTimeUs: number
  power: { availableWh: number, hoverW: number, reservePercent: number }
  calibration: VisionCalibration
  heldOut: VisionValidationSample[]
}
export interface InspectionStation { id: string, uM: number, vM: number, assetPointM: SensorVector, vehiclePositionM: SensorVector }
export interface InspectionPlan {
  version: 1
  config: InspectionConfig
  stations: InspectionStation[]
  inflatedClearanceM: number
  minimumPlannedSeparationM: number
  mission: MissionPlan
  assumptions: string[]
}
export interface InspectionImage {
  width: number
  height: number
  rgba: Uint8Array
  /** Ideal synthetic surface temperature field, not a calibrated physical radiometer. Zero is background/nodata. */
  thermalCentiKelvin: Uint16Array
}
/** Three face points measured in body FRD. Plant pose is used only by the synthetic sensor producer. */
export interface InspectionRangePacket {
  version: 1
  evidence: 'modeled-asset-range'
  assetId: string
  revision: string
  sequence: number
  capturedAtMs: number
  receivedAtMs: number
  rangeSigmaM: number
  clockUncertaintyMs: number
  pointsBodyM: [SensorVector, SensorVector, SensorVector]
}
export interface InspectionAssetObservation {
  sequence: number
  capturedAtMs: number
  receivedAtMs: number
  reference: string
  centerM: SensorVector
  normalNed: SensorVector
  uncertaintyM: number
  registrationDisplacementM: number
  cameraSeparationM: number
}
export interface InspectionCapture {
  id: string
  visitId: string
  stationId: string
  assetId: string
  revision: string
  sessionId: string
  sequence: number
  issuedAtMs: number
  capturedAtMs: number
  acknowledgedAtMs: number
  calibrationId: string
  clockUncertaintyMs: number
  exposureTimeUs: number
  pose: VehicleMeasurementPose
  cameraPositionM: SensorVector
  positionSigmaM: number
  attitudeSigmaRad: number
  assetObservation: InspectionAssetObservation
  image: InspectionImage
  quality: InspectionCaptureQuality
}
export interface InspectionCaptureQuality {
  qualified: boolean
  reasons: string[]
  gsdM: number
  blurPx: number
  assetFraction: number
  stationOffsetM: number
  viewIncidenceRad: number
  velocityMps: number
  angularRateRadS: number
}
export type InspectionScenario = 'nominal' | 'wind' | 'gnss-loss' | 'structure-motion' | 'camera-loss' | 'wrong-ack' | 'pause-resume' | 'abort' | 'rc-override'
export interface InspectionRun {
  version: 1
  evidence: 'owned-inspection-physics-simulation'
  physicalFlightEnabled: false
  physicalInspectionVerified: false
  visitId: string
  scenario: InspectionScenario
  plan: InspectionPlan
  trace: MissionTrace
  status: 'completed' | 'aborted' | 'blocked' | 'incomplete'
  reason: string
  captures: InspectionCapture[]
  boardNeutral: boolean
  minimumObservedSeparationM: number | null
  path: { atMs: number, positionM: SensorVector | null, targetM: SensorVector | null, taskId: string, state: string }[]
}
export interface InspectionReviewInput {
  id: string
  captureId: string
  reviewerId: string
  reviewedAt: string
  decision: 'suspected-defect' | 'no-defect-observed' | 'needs-follow-up'
  modality: 'visible' | 'thermal'
  pixel: [number, number]
  note: string
}
export interface InspectionReview extends InspectionReviewInput {
  version: 1
  visitId: string
  assetId: string
  revision: string
  captureSha256: string
  assetUvM: [number, number]
  identityAuthenticated: false
  physicalDefectVerified: false
}
export interface InspectionComparison {
  version: 1
  assetId: string
  revision: string
  beforeVisitId: string
  afterVisitId: string
  status: 'comparable' | 'partial'
  pairs: { stationId: string, beforeCaptureId: string, afterCaptureId: string, comparable: boolean, reasons: string[], cameraOffsetM: number, cameraOffsetUpperM: number, viewAngleRad: number, viewAngleUpperRad: number, gsdRatio: number }[]
  missingStations: string[]
  defectChangeDetermined: false
  limitations: string[]
}
