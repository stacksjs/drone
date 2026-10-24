import type { EstimatorSnapshot } from '../estimation/estimator'
import type { GeodeticOrigin, Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { MissionAction, MissionObservation, MissionState } from '../missions/engine'

export const vehicleKinds = ['quadcopter', 'fixed-wing', 'vtol', 'ground', 'surface', 'subsea'] as const
export type VehicleKind = typeof vehicleKinds[number]
export interface VehicleActuator { name: string, unit: 'normalized' | 'newton' | 'radian' | 'metres-per-second', min: number, max: number, neutral: number }
export interface VehiclePlantState {
  positionM: SensorVector
  velocityMps: SensorVector
  accelerationMps2: SensorVector
  quaternionWxyz: Quaternion
  angularRateRadS: SensorVector
  onSurface: boolean
  details: Record<string, number | boolean>
}
export interface VehicleEnvironment { windMps: SensorVector, currentMps: SensorVector }
export interface VehiclePlant { snapshot(): VehiclePlantState, step(actuators: number[], dtS: number, environment: VehicleEnvironment): VehiclePlantState }
/** Rendered, timestamped sensor data. Controllers never receive VehiclePlantState. */
export interface VehicleMeasurement {
  version: 1
  evidence: 'modeled-vehicle-sensors'
  vehicle: VehicleKind
  sequence: number
  reference: string
  capturedAtMs: number
  receivedAtMs: number
  values: Record<string, number | boolean | string | number[]>
}
export interface VehicleBatteryModel { evidence: 'modeled-vehicle-battery-v1', capacityWh: number, maximumSourceW: number }
export interface VehicleBatteryObservation {
  evidence: 'modeled-vehicle-battery-v1'
  observedAtMs: number
  capturedAtMs: number
  sequence: number
  reference: string
  energyUsedWh: number
  remainingWhLowerBound: number
  remainingPercentLowerBound: number
  sourcePowerW: number
  loadPowerW: number
  currentA: number
  terminalV: number
  cutoff: boolean
}
export type VehiclePayloadOperation = 'camera-still' | 'material-drop' | 'water-sample' | 'mower-enable' | 'mower-disable' | 'inspection-capture'
export interface VehiclePayloadCommand { eventId: string, taskId: string, operation: VehiclePayloadOperation, containerId: string | null, issuedAtMs: number, expiresAtMs: number, positionM: SensorVector, reference: string }
export interface VehiclePayloadAck { eventId: string, taskId: string, operation: VehiclePayloadOperation, containerId: string | null, capturedAtMs: number, reference: string, positionM: SensorVector, outcome: 'confirmed' | 'rejected' | 'uncertain', metadata?: Record<string, number | string | boolean> }
export interface VehiclePayloadPort { observe?(context: VehicleControllerContext): void, request(command: VehiclePayloadCommand): void, poll(nowMs: number): VehiclePayloadAck | null, close(): void }
export type VehicleVtolMode = 'hover' | 'cruise'
export interface VehicleVtolTransitionCommand { eventId: string, taskId: string, mode: VehicleVtolMode, headingRad: number, issuedAtMs: number, expiresAtMs: number, positionM: SensorVector, reference: string, supersedesEventId?: string }
export interface VehicleVtolTransitionObservation { evidence: 'modeled-vtol-controller-observation', eventId: string, taskId: string, mode: VehicleVtolMode, reference: string, capturedAtMs: number, measurementCapturedAtMs: number, phase: 'hover' | 'front-transition' | 'cruise' | 'back-transition', outcome: 'progress' | 'confirmed' | 'aborted', reason: string }
export type VehicleMissionTask =
  | { id: string, kind: 'start', next: string }
  | { id: string, kind: 'vtol-mode', mode: VehicleVtolMode, headingRad: number, timeoutMs: number, next: string, onFailure?: string }
  | { id: string, kind: 'takeoff' | 'waypoint' | 'land' | 'stop', positionM: SensorVector, acceptanceM: number, maxArrivalSpeedMps: number, settleMs: number, timeoutMs: number, next?: string }
  | { id: string, kind: 'return', acceptanceM: number, maxArrivalSpeedMps: number, settleMs: number, timeoutMs: number, next: string }
  | { id: string, kind: 'loiter', positionM: SensorVector, acceptanceM: number, maxArrivalSpeedMps: number, settleMs: number, timeoutMs: number, next: string }
  | { id: string, kind: 'payload', operation: VehiclePayloadOperation, containerId: string | null, timeoutMs: number, next: string, onFailure?: string }
  | { id: string, kind: 'branch', batteryAtLeast: number, then: string, otherwise: string }
  | { id: string, kind: 'abort' }
/** Explicit v2 profile; v1 quadcopter plans and traces retain their original contract. */
export interface VehicleMissionPlan {
  version: 2
  vehicle: VehicleKind
  id: string
  frame: 'LOCAL_NED'
  altitude: 'ORIGIN_RELATIVE_DOWN'
  terrain: 'DECLARED_MODEL_SURFACE'
  origin: GeodeticOrigin
  fence: { radiusM: number, minDownM: number, maxDownM: number }
  rallyM: SensorVector
  power: { availableWh: number, maxW: number, reservePercent: number }
  start: string
  tasks: VehicleMissionTask[]
}
export interface VehicleMissionObservation extends MissionObservation { payloadAck: VehiclePayloadAck | null, transition?: VehicleVtolTransitionObservation | null }
export interface VehicleMissionSnapshot {
  version: 2
  vehicle: VehicleKind
  evidence: 'owned-vehicle-mission-simulation'
  physicalFlightEnabled: false
  state: MissionState
  taskId: string
  taskKind: VehicleMissionTask['kind']
  targetM: SensorVector | null
  payload: VehiclePayloadCommand | null
  /** Present only for plans with explicit VTOL mode tasks; legacy recording shapes stay unchanged. */
  transition?: VehicleVtolTransitionCommand | null
  /** Present after entering an explicitly planned transition-failure hover/landing route. */
  recovery?: { failedEventId: string | null, failedTaskId: string, hoverTaskId: string, triggeredAtMs: number, cause: 'timeout' | 'controller-aborted' | 'operator-abort' | 'operator-pause' | 'operator-recover', abortRequestedAtMs?: number }
  /** A declared one-way payload failure route. Landing it does not confirm delivery. */
  payloadFailure?: { eventId: string, taskId: string, operation: VehiclePayloadOperation, containerId: string | null, reason: 'timeout' | 'rejected' | 'uncertain' | 'scope-mismatch', triggeredAtMs: number, approachTaskId: string, landingTaskId: string }
  reason: string
  elapsedMs: number
}
export type VehicleMissionAction = MissionAction
export interface VehicleControlOutput {
  kind: 'simulated-vehicle-control'
  /** One capture-bound response, consumed by the next mission evaluation for explicit mode plans. */
  transition?: VehicleVtolTransitionObservation | null
  vehicle: VehicleKind
  atMs: number
  actuators: number[]
  inhibited: boolean
  reason: string
  physicalFlightEnabled: false
  boardOutputsInhibited: true
}
export interface VehicleMeasurementPose { capturedAtMs: number, reference: string, positionM: SensorVector, quaternionWxyz: Quaternion, positionCapturedAtMs: number, positionPredictedToMs: number, attitudeCapturedAtMs: number, attitudePredictedToMs: number, gyroCapturedAtMs: number, attitudePrediction: 'qualified-gyro-hold' }
/** Current calibrated gyro from the same qualified raw IMU capture as estimator attitude. */
export interface VehicleControlRate { evidence: 'modeled-qualified-imu', reference: string, capturedAtMs: number, angularRateRadS: SensorVector }
export interface VehicleControllerContext { nowMs: number, enabled: boolean, estimate: EstimatorSnapshot, measurement: VehicleMeasurement | null, measurementPose?: VehicleMeasurementPose | null, controlRate?: VehicleControlRate | null, mission: VehicleMissionSnapshot }
export interface VehicleController { step(context: VehicleControllerContext): VehicleControlOutput }
export interface VehicleFaults {
  windMps?: SensorVector
  currentMps?: SensorVector
  dropImu?: boolean
  dropPosition?: boolean
  dropVehicleSensor?: boolean
  hostLost?: boolean
  rcOverride?: boolean
  kill?: boolean
  linkLost?: boolean
}
/** One execution owns its plant, controller, payload and measurement sequence. */
export interface VehicleNavigation { update(base: EstimatorSnapshot, measurement: VehicleMeasurement | null, nowMs: number): EstimatorSnapshot }
export interface VehicleSession {
  /** Optional received link evidence on the runtime's monotonic clock, without receipt-time restamping. */
  linkObservation?(nowMs: number): { capturedAtMs: number, connected: boolean }
  createNavigation?(): VehicleNavigation
  createPlant(): VehiclePlant
  createController(): VehicleController
  createPayload?(): VehiclePayloadPort
  /** Quantize model truth into declared measurements. Called every 20 ms with capture-time reference. */
  renderMeasurement(state: VehiclePlantState, atMs: number, reference: string): VehicleMeasurement
  /** Independent simulator probes only. Never a controller measurement or host estimate. */
  observeIndependent?(state: VehiclePlantState, atMs: number, actuators: number[], hostAvailable: boolean): void
}
export interface VehicleProfile {
  scenario: string
  vehicle: VehicleKind
  name: string
  evidence: 'modeled-vehicle-profile'
  physicalFlightEnabled: false
  actuators: VehicleActuator[]
  authorityFence: { radiusM: number, minDownM: number, maxDownM: number }
  mission: VehicleMissionPlan
  /** Optional captured source envelope. Legacy profiles retain declared-ceiling energy accounting. */
  batteryModel?: VehicleBatteryModel
  scenarios: readonly string[]
  /** Allocate independent mutable state for each execution. Never reuse a session for another run. */
  createSession(): VehicleSession
  /** Declared fault fixture. Tail probes may preserve an active fault but must not invent a new host event. */
  faults(scenario: string, atMs: number, phase?: 'host' | 'independent-tail'): VehicleFaults
}
