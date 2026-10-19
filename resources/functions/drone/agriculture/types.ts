import type { GeodeticOrigin } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { SurveyCapture, SurveyConfig, SurveyPlan, SurveyRun } from '../mapping/types'

export type AgricultureBandName = 'red' | 'nir'
/** Coefficients and pixel coordinates refer to the raw DN grid, never a display RGB image. */
export interface AgricultureBandCalibration {
  name: AgricultureBandName
  wavelengthNm: number
  bandwidthNm: number
  width: number
  height: number
  bitDepth: 16
  blackLevelDn: number
  coefficients: [number, number, number]
  vignetteCenterPx: [number, number]
  vignettePolynomial: [number, number, number, number, number, number]
}
export interface AgriculturePanel {
  id: string
  band: AgricultureBandName
  certificateId: string
  capturedAtMs: number
  exposureTimeUs: number
  gain: number
  reflectance: number
  reflectanceUncertainty: number
  irradianceWm2Nm: number
  samples: { pixel: [number, number], dn: number }[]
}
export interface AgricultureRadiometry {
  id: string
  model: 'micasense-v1'
  evidence: 'synthetic' | 'declared-bench'
  bands: [AgricultureBandCalibration, AgricultureBandCalibration]
  panels: AgriculturePanel[]
  maxPanelAgeMs: number
  maxIrradianceAgeMs: number
  maxSyncMs: number
  maxRegistrationErrorPx: number
  relativeRadianceUncertainty: number
  relativeIrradianceUncertainty: number
}
/** Bounds are north-min, east-min, north-max, east-max, clipped to the surveyed field and holes. */
export interface AgricultureParcel { id: string, name: string, boundsM: [number, number, number, number] }
export interface AgricultureConfig {
  version: 1
  id: string
  survey: SurveyConfig
  parcels: AgricultureParcel[]
  radiometry: AgricultureRadiometry
  gridResolutionM: number
}
export interface AgriculturePlan { version: 1, config: AgricultureConfig, survey: SurveyPlan, assumptions: string[] }
export interface AgricultureBandFrame {
  band: AgricultureBandName
  capturedAtMs: number
  exposureTimeUs: number
  gain: number
  irradiance: { capturedAtMs: number, valueWm2Nm: number }
  counts: Uint16Array
}
export interface AgricultureImage {
  width: number
  height: number
  rgba: Uint8Array
  registrationId: string
  registrationErrorPx: number
  bands: [AgricultureBandFrame, AgricultureBandFrame]
}
export interface AgricultureCapture {
  captureId: string
  sessionId: string
  sequence: number
  reference: string
  issuedAtMs: number
  capturedAtMs: number
  acknowledgedAtMs: number
  image: AgricultureImage
}
export type AgricultureScenario = 'nominal' | 'irradiance-loss' | 'band-skew' | 'saturation' | 'camera-loss' | 'wrong-ack' | 'position-loss' | 'rc-override' | 'abort'
export interface AgricultureRun {
  version: 1
  evidence: 'owned-agriculture-physics-simulation'
  physicalFlightEnabled: false
  physicalCalibrationVerified: false
  visitId: string
  scenario: AgricultureScenario
  plan: AgriculturePlan
  survey: SurveyRun
  captures: AgricultureCapture[]
  status: SurveyRun['status']
  reason: string
}
export interface AgricultureCalibratedImage {
  width: number
  height: number
  red: Float64Array
  nir: Float64Array
  ndvi: Float64Array
  lower: Float64Array
  upper: Float64Array
  valid: Uint8Array
  invalidReasons: Record<string, number>
  qualified: boolean
  validFraction: number
  /** Conditional on declared calibration/irradiance/panel bounds, not a field accuracy guarantee. */
  uncertaintyEvidence: 'conditional-declared-input-bounds'
}
export interface AgricultureCell {
  id: string
  positionM: SensorVector
  geodetic: GeodeticOrigin
  areaM2: number
  parcelIds: string[]
  ndvi: number | null
  bounds: [number, number] | null
  redReflectance: number | null
  nirReflectance: number | null
  source: { captureId: string, pixel: [number, number], positionSigmaM: number } | null
  reason: 'valid' | 'uncovered' | 'masked'
}
export interface AgricultureLayer {
  version: 1
  visitId: string
  grid: { northMinM: number, eastMinM: number, northMaxM: number, eastMaxM: number, rows: number, columns: number, resolutionM: number }
  /** Row-major, north descending and east ascending. Zero-area cells remain explicit. */
  cells: AgricultureCell[]
  parcels: { id: string, name: string, areaM2: number, observedAreaM2: number, meanNdvi: number | null, missingAreaM2: number }[]
  fieldAreaM2: number
  observedAreaM2: number
  meanNdvi: number | null
  physicalAgronomyVerified: false
  limitations: string[]
}
export interface LivestockObservationInput {
  id: string
  animalId: string
  captureId: string
  pixel: [number, number]
  observerId: string
  observedAt: string
  note: string
}
export interface LivestockObservation extends LivestockObservationInput {
  version: 1
  visitId: string
  selection: 'explicit-operator-selected-animal'
  captureSha256: string
  positionM: SensorVector
  geodetic: GeodeticOrigin
  positionSigmaM: number
  parcelIds: string[]
  identityAuthenticated: false
  physicalAnimalVerified: false
}
export type AgricultureSurveyCapture = SurveyCapture
