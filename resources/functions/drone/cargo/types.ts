import type { AuthorityState } from '../authority/supervisor'
import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { Motors } from '../controls/model'

export type CargoLoadCase = 'centered-carried' | 'forward-carried' | 'forward-separated' | 'link-loss'
export interface CargoLoadProperties {
  id: string
  phase: 'attached' | 'separated'
  pointMassKg: number
  forwardM: number
  totalMassKg: number
  cgBodyM: SensorVector
  inertiaDiagonalKgM2: SensorVector
}
export interface CargoLoadSnapshot { properties: CargoLoadProperties, centerPositionM: SensorVector, centerVelocityMps: SensorVector }
export interface CargoEventSide {
  properties: CargoLoadProperties
  bodyPositionM: SensorVector
  bodyVelocityMps: SensorVector
  quaternionWxyz: Quaternion
  angularRateRadS: SensorVector
  actualMotorsN: Motors
  centerPositionM: SensorVector
  centerVelocityMps: SensorVector
}
export interface CargoParcel { massKg: number, positionM: SensorVector, velocityMps: SensorVector }
export type CargoBodySeparation = { outcome: 'separated', reason: 'prescribed-zero-ejection', before: CargoEventSide, after: CargoEventSide, parcel: CargoParcel } | { outcome: 'refused', reason: 'already-separated' }
export interface CargoScheduledSeparation {
  scheduledAtMs: 12000 | null
  attemptedAtMs: 12000 | null
  outcome: 'not-requested' | 'separated' | 'refused'
  reason: null | 'prescribed-zero-ejection' | 'authority-not-current' | 'board-not-current' | 'control-inhibited' | 'readiness-window' | 'already-separated'
  before: CargoEventSide | null
  after: CargoEventSide | null
  parcel: CargoParcel | null
}
export interface CargoBodyRecord {
  positionM: SensorVector
  velocityMps: SensorVector
  accelerationMps2: SensorVector
  quaternionWxyz: Quaternion
  angularRateRadS: SensorVector
  actualMotorsN: Motors
  groundContact: boolean
}
export interface CargoPhysicalRow {
  atMs: number
  stepKind: 'held-support' | 'integrated'
  load: CargoLoadSnapshot
  body: CargoBodyRecord
  commandAppliedN: Motors
  commandNextN: Motors
  thrustN: number
  motorTorqueAtBNm: SensorVector
  motorTorqueAtCgNm: SensorVector
  alphaStepRadS2: SensorVector
}
export interface CargoRawStamp {
  sequence: number
  capturedUs: string
  capturedAtMs: number
  receivedAtMs: number
  ageUpperMs: number | null
  uncertaintyUs: number | null
  deviceId: string
  calibrationId: string | null
  healthy: boolean
  quality: string[]
}
export interface CargoImu { stamp: CargoRawStamp, specificForceMps2: SensorVector, angularRateRadS: SensorVector }
export interface CargoGnss { stamp: CargoRawStamp, geodetic: SensorVector, velocityNedMps: SensorVector }
export interface CargoEstimate {
  nowMs: number
  bootId: string | null
  resets: [number, number, number, number, number]
  origin: SensorVector | null
  frameQualified: boolean
  healthy: [boolean, boolean]
  attitude: { capturedAtMs: number | null, quaternionWxyz: Quaternion } | null
  position: { capturedAtMs: number | null, predictedToMs: number, positionM: SensorVector, velocityMps: SensorVector } | null
}
export interface CargoControl { inhibited: boolean, reason: string, motorsN: Motors, limited: boolean, rateCapturedAtMs: number | null }
export interface CargoSupervisor {
  scope: [string, string]
  state: AuthorityState
  reason: string
  epoch: number
  commandSequence: number
  lastCheckedAtMs: number | null
  leaseUntilMs: number | null
}
export interface CargoBoard { bootId: string, epoch: number, frameSequence: number, lastCheckedAtMs: number | null, expiresAtMs: number | null, fault: string | null, motorsN: Motors }
export interface CargoReadiness { qualified: boolean, count: number, startAtMs: number | null, lastImuSequence: number | null, lastImuCapturedUs: string | null }
export interface CargoPolicyRow {
  atMs: number
  imu: CargoImu | null
  gnss: CargoGnss | null
  estimate: CargoEstimate
  control: CargoControl | null
  supervisor: CargoSupervisor
  board: CargoBoard
  readiness: CargoReadiness
}
export interface CargoConservation { originM: SensorVector, linearResidual: SensorVector, angularResidual: SensorVector, kineticResidualJ: number, potentialResidualJ: number, continuityMax: number, passed: boolean }
export interface CargoMetrics {
  maxTiltRad: number
  maxRateRadS: number
  maxCommandSlewNPerS: number
  groundContactRows: number
  tailMaxPositionErrorM: number
  tailRmsPositionErrorM: number
  firstAuthorityLossAtMs: number | null
  firstBoardZeroAtMs: number | null
  separationCount: number
  conservation: CargoConservation | null
}
export type CargoEvaluationReason = 'cargo-load-conservation' | 'cargo-load-authority-lost' | 'cargo-load-control-inhibited' | 'cargo-load-estimate-unqualified' | 'cargo-load-ground-contact' | 'cargo-load-body-envelope' | 'cargo-load-separation-refused' | 'cargo-load-hover-tail'
export interface CargoEvaluation { reasons: CargoEvaluationReason[], metrics: CargoMetrics, faultCharacterizationPassed: boolean | null }
export interface CargoCounts { worldSnapshots: number, heldSupportRows: number, integratedSteps: number, policyRows: number, separationAttempts: number, separationTransitions: number }
export interface CargoFinal { body: CargoBodyRecord, load: CargoLoadSnapshot, supervisor: CargoSupervisor, board: CargoBoard, experimentEnded: true, landingPerformed: false }
export interface CargoModel {
  baseMassKg: 1.5
  baseInertia: [0.03, 0.03, 0.05]
  gravityMps2: 9.80665
  loadMassKg: 0.1
  loadForwardM: 0 | 0.08
  dtMs: 4
  policyMs: 20
  durationMs: 20000
  supportWarmupMs: 600
  separationAtMs: 12000 | null
  targetM: [0, 0, -1]
  massAwareController: false
  inertialPositionFusion: false
  separationModel: 'prescribed-instantaneous-zero-ejection-point-mass'
  energyModel: 'not-qualified'
  contactModel: 'structural-point-plane-approximation'
}
/** Detached JSON-domain characterization facts. These are not delivery or physical-control claims. */
export interface CargoLoadEvidence {
  version: 1
  scenario: CargoLoadCase
  model: CargoModel
  counts: CargoCounts
  separation: CargoScheduledSeparation
  physical: CargoPhysicalRow[]
  policy: CargoPolicyRow[]
  evaluation: CargoEvaluation
  final: CargoFinal
}

export interface CargoCapabilities {
  deliveryPerformed: false
  releaseMechanismVerified: false
  custodyVerified: false
  recipientConfirmed: false
  missionExecuted: false
  energyMarginQualified: false
}
export interface CargoLoadRun {
  version: 1
  evidence: 'owned-airborne-cargo-load-characterization'
  profile: 'forward-point-load-v1'
  scenario: CargoLoadCase
  status: 'characterized' | 'unqualified'
  reason: CargoEvaluationReason | null
  physicalFlightEnabled: false
  boardOutputsInhibited: true
  identityAuthenticated: false
  capabilities: CargoCapabilities
  model: CargoModel
  counts: CargoCounts
  separation: CargoScheduledSeparation
  physical: CargoPhysicalRow[]
  policy: CargoPolicyRow[]
  evaluation: CargoEvaluation
  final: CargoFinal
}

export interface CargoLoadSummary {
  version: 1
  evidence: 'owned-airborne-cargo-load-characterization'
  profile: 'forward-point-load-v1'
  scenario: CargoLoadCase
  status: 'characterized' | 'unqualified'
  reason: CargoEvaluationReason | null
  physicalFlightEnabled: false
  boardOutputsInhibited: true
  identityAuthenticated: false
  capabilities: CargoCapabilities
  model: CargoModel
  counts: CargoCounts
  separation: { scheduledAtMs: 12000 | null, attemptedAtMs: 12000 | null, outcome: CargoScheduledSeparation['outcome'], reason: CargoScheduledSeparation['reason'], beforeProperties: CargoLoadProperties | null, afterProperties: CargoLoadProperties | null }
  metrics: CargoMetrics
  final: { authorityState: AuthorityState, authorityReason: string, boardFault: string | null, boardMotorsN: Motors, boardExpiresAtMs: number | null, loadPhase: 'attached' | 'separated', bodyPositionM: SensorVector, bodyVelocityMps: SensorVector, experimentEnded: true, landingPerformed: false }
}
