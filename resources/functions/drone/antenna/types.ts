import type { GeodeticOrigin } from '../estimation/frames'
import type { AntennaPointing } from './geometry'

/** Level mount, surveyed WGS84 origin and true north. Heights must be ellipsoidal. */
export interface AntennaConfig {
  origin: GeodeticOrigin
  calibration: { id: string, panZeroTrueNorthDeg: number, tiltZeroElevationDeg: number, surveyAccuracyM: number }
  clockDomainId: string
  panMinDeg: number
  panMaxDeg: number
  tiltMinDeg: number
  tiltMaxDeg: number
  cableNeutralPanDeg: number
  maxCableTwistDeg: number
  initialPanDeg: number
  initialTiltDeg: number
  maxRateDegPerSecond: number
  maxAccelerationDegPerSecond2: number
  maxFixAgeMs: number
  maxClockUncertaintyMs: number
  maxTickGapMs: number
  maxPositionAccuracyM: number
  maxPointingUncertaintyDeg: number
  maxRangeM: number
  minSnrDb: number
  maxPacketLossFraction: number
}
export interface AntennaSelection { targetId: string, telemetrySessionId: string }
/** Qualified transport input only. Epochs must already be mapped to the declared local clock. */
export interface AntennaTelemetry extends AntennaSelection {
  sequence: number
  clockDomainId: string
  capturedAtMs: number
  clockUncertaintyMs: number
  position: GeodeticOrigin
  horizontalAccuracyM: number
  verticalAccuracyM: number
  link: { capturedAtMs: number, rssiDbm: number, snrDb: number, packetLossFraction: number }
}
export interface AntennaAngles { panDeg: number, tiltDeg: number }
export type AntennaMode = 'disabled' | 'tracking' | 'manual' | 'fault' | 'emergency'
export type AntennaStopReason = 'disabled' | 'no-selection' | 'no-target' | 'other-target' | 'wrong-session' | 'clock' | 'replay' | 'stale-target' | 'invalid-target' | 'uncertain-target' | 'link-quality' | 'singular-target' | 'range' | 'travel-limit' | 'cable-twist' | 'tick-gap' | 'manual-expired' | 'emergency'
export interface AntennaSnapshot {
  evidence: 'simulation-only'
  physicalActuationEnabled: false
  mode: AntennaMode
  directive: 'trajectory' | 'stop'
  reason: AntennaStopReason | null
  atMs: number
  selection: AntennaSelection | null
  calibrationId: string
  position: AntennaAngles
  velocity: { panDegPerSecond: number, tiltDegPerSecond: number }
  goal: AntennaAngles | null
  pointing: AntennaPointing | null
  pointingUncertaintyDeg: number | null
  targetSequence: number | null
  link: AntennaTelemetry['link'] | null
}
