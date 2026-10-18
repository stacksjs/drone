export type SensorKind = 'imu' | 'barometer' | 'gnss'
export type SensorVector = [number, number, number]
export interface SensorPacket {
  kind: SensorKind
  sequence: number
  bootId: bigint
  capturedUs: bigint
  completedUs: bigint
  flags: number
  deviceId: number
  uncertaintyUs: number
  payload: Uint8Array
}
export interface SensorClockAnchor {
  bootId: bigint
  boardUs: bigint
  localMs: number
  uncertaintyUs: number
  driftPpm: number
  source: 'fixture' | 'handshake'
}
export interface ImuCalibration {
  id: string
  provenance: 'fixture' | 'measured'
  axes: SensorVector
  referenceC: number
  minC: number
  maxC: number
  accelBias: SensorVector
  gyroBias: SensorVector
  accelScale: SensorVector
  gyroScale: SensorVector
  accelTempSlope: SensorVector
  gyroTempSlope: SensorVector
  accelNoiseStd: SensorVector
  gyroNoiseStd: SensorVector
}
export interface PressureCalibration {
  id: string
  provenance: 'fixture' | 'measured'
  offsetPa: number
  tempSlopePaPerC: number
  referenceC: number
  minC: number
  maxC: number
  noiseStdPa: number
}
export interface SensorCalibrationSet { imu?: ImuCalibration, barometer?: PressureCalibration }
export interface ImuMeasurement {
  frame: 'BODY_FRD' | 'SENSOR_XYZ'
  temperatureC: number
  specificForceMps2: SensorVector
  angularRateRadS: SensorVector
  specificForceVariance: SensorVector | null
  angularRateVariance: SensorVector | null
}
export interface PressureMeasurement { pressurePa: number, temperatureC: number, variancePa2: number | null }
export interface GnssMeasurement {
  frame: 'WGS84_GEODETIC_NED_VELOCITY'
  sourceTowMs: number
  latitudeDeg: number
  longitudeDeg: number
  ellipsoidHeightM: number
  mslHeightM: number
  velocityNedMps: SensorVector
  positionVarianceNedM2: SensorVector
  velocityVarianceNedM2S2: SensorVector
}
export interface SensorObservation {
  kind: SensorKind
  deviceId: string
  sequence: number
  capturedUs: bigint
  receivedAtMs: number
  estimatedCaptureMs: number
  measurementAgeUpperMs: number | null
  transportAgeUpperMs: number
  timeUncertaintyUs: number | null
  quality: string[]
  healthy: boolean
  calibrationId: string | null
  value: ImuMeasurement | PressureMeasurement | GnssMeasurement | null
}
