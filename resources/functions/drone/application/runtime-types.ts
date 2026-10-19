import type { SensorVector } from '../sensors/types'
import type { GroundObservation } from '../vehicles/ground/odometry'
import type { VehiclePlant, VehiclePlantState } from '../vehicles/types'
import type { runVehicleSimulation } from '../vehicles/runtime'
import type { ApplicationConfig, ApplicationOptions, ApplicationPlan, ApplicationPlantSnapshot, ApplicationRelease, ApplicationScenario } from './types'

export interface ApplicationMeterFeedback {
  sequence: number
  capturedAtMs: number
  pulseCount: number
  scaleRaw: number
  primaryEncoder: number
  masterEncoder: number
  energyEncoder: number
}
export interface ApplicationGrant {
  action: 'grant' | 'renew' | 'revoke'
  sequence: number
  issuedAtMs: number
  expiresAtMs: number
  visitId: string
  configId: string
  materialId: string
  reference: string
}
/** Recorded qualified host inputs contain no plant truth or command-derived flow. */
export interface ApplicationControllerInput {
  atMs: number
  enabled: boolean
  reference: string
  missionState: string
  taskId: string
  ground: GroundObservation
  feedback: ApplicationMeterFeedback | null
  weather: ApplicationConfig['weather'] & { capturedAtMs: number }
  grant: ApplicationGrant | null
  emergency: boolean
}
export interface ApplicationDecision {
  atMs: number
  state: 'dry' | 'applying' | 'standby' | 'latched'
  reason: string
  taskId: string
  prescriptionId: string | null
  targetPerSecond: number
  measuredPerSecond: number | null
  measuredDeliveredAmount: number
  measurementUncertainty: number
  estimatedPositionM: SensorVector
  grantExpiresAtMs: number | null
  /** Primary meter, independent master isolation and pump/auger energy. */
  channels: [number, number, number]
  stopVehicle: boolean
}
export interface ApplicationProbe { atMs: number, hostAvailable: boolean, positionM: SensorVector, yawRad: number, state: ApplicationPlantSnapshot, boardChannels: number[] }
export interface ApplicationShutdown {
  requestedAtMs: number
  finalAtMs: number
  emittedAfterRequest: number
  closureVerified: boolean
  evidence: 'independent-modeled-plant-tail'
}
export interface ApplicationRun {
  version: 1
  evidence: 'owned-application-physics-simulation'
  physicalFlightEnabled: false
  physicalApplicationVerified: false
  physicalTrialEligible: false
  options: Required<Omit<ApplicationOptions, 'config'>>
  config: ApplicationConfig
  plan: ApplicationPlan
  vehicle: ReturnType<typeof runVehicleSimulation>
  inputs: ApplicationControllerInput[]
  decisions: ApplicationDecision[]
  releases: ApplicationRelease[]
  probes: ApplicationProbe[]
  final: ApplicationPlantSnapshot
  shutdown: ApplicationShutdown
  status: 'dry-completed' | 'completed' | 'blocked' | 'host-lost' | 'incomplete'
  reason: string
  faultDemonstrated: boolean
}
export interface ApplicationPlant extends VehiclePlant {
  meterSnapshot(): ApplicationPlantSnapshot
  setFault(fault: ApplicationScenario | null): void
  /** One 4ms integration release amount, independent of host observations. */
  takeRelease(): number
}
export interface ApplicationPlantOptions { ground?: VehiclePlant, initialAmount?: number, startAtMs?: number }
export type ApplicationTruthState = VehiclePlantState
