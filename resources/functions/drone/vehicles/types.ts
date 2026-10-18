import type { EstimatorSnapshot } from '../estimation/estimator'
import type { GeodeticOrigin, Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { MissionAction, MissionObservation, MissionState } from '../missions/engine'

export type VehicleKind = 'fixed-wing' | 'ground' | 'surface'
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
export type VehiclePayloadOperation = 'camera-still' | 'material-drop' | 'water-sample' | 'mower-enable' | 'mower-disable'
export interface VehiclePayloadCommand { eventId: string, taskId: string, operation: VehiclePayloadOperation, containerId: string | null, issuedAtMs: number, expiresAtMs: number, positionM: SensorVector, reference: string }
export interface VehiclePayloadAck { eventId: string, taskId: string, operation: VehiclePayloadOperation, containerId: string | null, capturedAtMs: number, reference: string, positionM: SensorVector, outcome: 'confirmed' | 'rejected' | 'uncertain', metadata?: Record<string, number | string | boolean> }
export interface VehiclePayloadPort { observe?(context: VehicleControllerContext): void, request(command: VehiclePayloadCommand): void, poll(nowMs: number): VehiclePayloadAck | null, close(): void }
export type VehicleMissionTask =
  | { id: string, kind: 'start', next: string }
  | { id: string, kind: 'takeoff' | 'waypoint' | 'land' | 'stop', positionM: SensorVector, acceptanceM: number, maxArrivalSpeedMps: number, settleMs: number, timeoutMs: number, next?: string }
  | { id: string, kind: 'return', acceptanceM: number, maxArrivalSpeedMps: number, settleMs: number, timeoutMs: number, next: string }
  | { id: string, kind: 'loiter', positionM: SensorVector, acceptanceM: number, maxArrivalSpeedMps: number, settleMs: number, timeoutMs: number, next: string }
  | { id: string, kind: 'payload', operation: VehiclePayloadOperation, containerId: string | null, timeoutMs: number, next: string }
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
export interface VehicleMissionObservation extends MissionObservation { payloadAck: VehiclePayloadAck | null }
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
  reason: string
  elapsedMs: number
}
export type VehicleMissionAction = MissionAction
export interface VehicleControlOutput {
  kind: 'simulated-vehicle-control'
  vehicle: VehicleKind
  atMs: number
  actuators: number[]
  inhibited: boolean
  reason: string
  physicalFlightEnabled: false
  boardOutputsInhibited: true
}
export interface VehicleMeasurementPose { capturedAtMs: number, reference: string, positionM: SensorVector, quaternionWxyz: Quaternion, positionCapturedAtMs: number, positionPredictedToMs: number, attitudeCapturedAtMs: number, attitudePredictedToMs: number, gyroCapturedAtMs: number, attitudePrediction: 'qualified-gyro-hold' }
export interface VehicleControllerContext { nowMs: number, enabled: boolean, estimate: EstimatorSnapshot, measurement: VehicleMeasurement | null, measurementPose?: VehicleMeasurementPose | null, mission: VehicleMissionSnapshot }
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
}
/** One execution owns its plant, controller, payload and measurement sequence. */
export interface VehicleSession {
  createPlant(): VehiclePlant
  createController(): VehicleController
  createPayload?(): VehiclePayloadPort
  /** Quantize model truth into declared measurements. Called every 20 ms with capture-time reference. */
  renderMeasurement(state: VehiclePlantState, atMs: number, reference: string): VehicleMeasurement
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
  scenarios: readonly string[]
  /** Allocate independent mutable state for each execution. Never reuse a session for another run. */
  createSession(): VehicleSession
  /** Declared fault fixture. Undefined fields retain the nominal environment. */
  faults(scenario: string, atMs: number): VehicleFaults
}
