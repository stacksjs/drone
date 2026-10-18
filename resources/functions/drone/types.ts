/** Local coordinates: metres north/east/down from a fixed launch origin. */
export interface Vector3 { north: number, east: number, down: number }

export interface Telemetry {
  position: Vector3
  velocity: Vector3
  batteryPercent: number
  positionHealthy: boolean
  mode: 'guided' | 'manual' | 'land' | 'rtl'
  armed: boolean
  /** Monotonic local receipt time, never a remote device's wall clock. */
  receivedAtMs: number
}

export interface Target {
  id: string
  position: Vector3
  headingRadians: number
  confidence: number
  accuracyMeters: number
  receivedAtMs: number
}

export interface FlightLimits {
  radiusMeters: number
  minAltitudeMeters: number
  maxAltitudeMeters: number
  maxSpeedMps: number
  maxClimbMps: number
  minSeparationMeters: number
  minBatteryPercent: number
  maxTelemetryAgeMs: number
  maxTargetAgeMs: number
  maxTargetAccuracyMeters: number
  minConfidence: number
  predictionSeconds: number
}

export interface FollowOptions { distanceMeters: number, altitudeMeters: number, gain: number }
export interface BehaviorContext { telemetry: Readonly<Telemetry>, target: Readonly<Target>, nowMs: number }
export interface Behavior {
  name: string
  velocity: (context: BehaviorContext) => Vector3
}

export type Decision =
  | { kind: 'velocity', velocity: Vector3, reason: string }
  | { kind: 'hold' | 'release', reason: string }

export interface FlightAdapter {
  readonly kind: 'simulation' | 'sitl' | 'telemetry-only'
  read: () => Telemetry | undefined
  send: (decision: Decision) => void
  close: () => void
}
