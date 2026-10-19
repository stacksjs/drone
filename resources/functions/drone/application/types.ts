import type { SensorVector } from '../sensors/types'
import type { VolumeXY } from '../volumes/types'
import type { VehicleMissionPlan } from '../vehicles/types'

/** Quantities use litres for water or kilograms for inert granules, never nutrient mass or an inferred chemical prescription. */
export type ApplicationImplement = 'sprayer' | 'spreader'
export interface ApplicationPulseCalibration { pulses: number, litres: number, durationMs: number }
export interface ApplicationScaleCalibration { tareRaw: number, loadedRaw: number, knownMassKg: number }
export interface ApplicationConfig {
  version: 1
  id: string
  frame: 'LOCAL_NED'
  origin: { latitudeDeg: number, longitudeDeg: number, ellipsoidHeightM: number }
  /** Polygon coordinates are [north, east] metres. Flat local ground is down=0. */
  boundary: VolumeXY[]
  exclusions: VolumeXY[][]
  prescription: { id: string, polygon: VolumeXY[], ratePerHa: number }[]
  /** Explicit operator-planned route, including a dry approach point. */
  routeM: VolumeXY[]
  gridResolutionM: number
  material: { id: string, batch: string, kind: 'water' | 'inert-granules', unit: 'L' | 'kg', densityKgPerL: number | null, initialAmount: number }
  implement: { type: ApplicationImplement, swathM: number, footprintLengthM: number, fallTimeS: number, minSpeedMps: number, maxSpeedMps: number }
  calibration: {
    id: string
    evidence: 'synthetic'
    pulse: ApplicationPulseCalibration | null
    scale: ApplicationScaleCalibration
    minRatePerSecond: number
    maxRatePerSecond: number
    primaryCloseMs: number
    masterCloseMs: number
    energyTauMs: number
    noFlowTimeoutMs: number
    closingAllowanceMs: number
    encoderCounts: number
  }
  weather: { windMps: [number, number], temperatureC: number, humidityPercent: number, inversion: boolean }
  weatherLimits: { maxWindMps: number, minTemperatureC: number, maxTemperatureC: number, minHumidityPercent: number, maxAgeMs: number }
  localRequirements: { status: 'unqualified', jurisdiction: string | null, operatorId: string, evidenceLinks: string[] }
}
export interface ApplicationPlan {
  config: ApplicationConfig
  mission: VehicleMissionPlan
  fieldAreaM2: number
  excludedAreaM2: number
  treatableAreaM2: number
  prescribedAmount: number
  availableAmount: number
  inventorySufficient: boolean
  worstCaseMs: number
  requiredWh: number
  physicalTrialEligible: false
}
export type ApplicationScenario = 'nominal' | 'empty' | 'stuck-valve' | 'master-stuck' | 'blocked-flow' | 'meter-loss' | 'meter-replay' | 'weather' | 'manual' | 'host-loss' | 'emergency' | 'localization-loss' | 'guard-open' | 'lease-expiry'
export interface ApplicationOptions {
  config?: unknown
  scenario?: ApplicationScenario
  visitId?: string
  seconds?: number
  authorizeImplement?: boolean
  testMode?: boolean
}
/** Independent modeled plant probe. This is not an authenticated flow instrument or a host estimate. */
export interface ApplicationPlantSnapshot {
  atMs: number
  primaryPosition: number
  masterPosition: number
  energy: number
  flowPerSecond: number
  remainingAmount: number
  emittedAmount: number
  unmeteredLossAmount: number
  pulseCount: number
  scaleRaw: number
}
/** Amount emitted by actual 4ms plant integration, optionally grouped at the 20ms capture cadence. */
export interface ApplicationRelease {
  atMs: number
  amount: number
  positionM: SensorVector
  yawRad: number
  windMps: [number, number]
  taskId: string | null
  hostAvailable: boolean
  positionEvidence: 'modeled-plant-truth'
}
export interface ApplicationCell {
  id: string
  boundsM: [number, number, number, number]
  areaM2: number
  excludedAreaM2: number
  coveredAreaM2: number
  overlapAreaM2: number
  depositedAmount: number
  prescribedAmount: number
  dosePerHa: number | null
  prescriptionIds: string[]
}
export interface ApplicationReport {
  version: 1
  unit: 'L' | 'kg'
  fieldAreaM2: number
  treatableAreaM2: number
  coveredAreaM2: number
  missedAreaM2: number
  overlapAreaM2: number
  emittedAmount: number
  inFieldAmount: number
  excludedAmount: number
  outsideAmount: number
  inFlightAmount: number
  conservationError: number
  cells: ApplicationCell[]
  coverageEvidence: 'modeled-deposition-truth'
  physicalApplicationVerified: false
  limitations: string[]
}
