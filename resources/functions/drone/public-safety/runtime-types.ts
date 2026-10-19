import type { SurveyPoint, SurveyRun } from '../mapping/types'
import type { SensorVector } from '../sensors/types'
import type { AuthorityState } from '../authority/supervisor'
import type { PublicSafetyPlan, PublicSafetyThermalAck } from './types'

export const publicSafetyScenarios = ['nominal', 'link-loss', 'link-stale', 'battery-loss', 'boundary-change', 'endurance-change', 'camera-loss', 'wrong-ack', 'position-loss', 'manual'] as const
export type PublicSafetyScenario = typeof publicSafetyScenarios[number]
export interface PublicSafetyEpoch {
  atMs: number
  positionM: SensorVector | null
  positionSigmaM: number | null
  authority: AuthorityState
  battery: { capturedAtMs: number, remainingPercent: number }
  link: { capturedAtMs: number, connected: boolean }
  missionState: string
  taskId: string
  incidentRevision: string
  remainingFlightMs: number | null
  decision: 'continue' | 'stop'
  reason: string
}
export interface PublicSafetyUpdate {
  sequence: number
  atMs: number
  incidentId: string
  visitId: string
  previousRevision: string
  revision: string
  kind: 'boundary-change' | 'endurance-change'
  operatingBoundary: SurveyPoint[] | null
  remainingFlightMs: number | null
  requiresNewPilotAcceptance: true
}
export interface PublicSafetyEvent {
  sequence: number
  atMs: number
  kind: 'mission-observation' | 'capture-confirmed' | 'incident-update'
  captureId: string | null
  observationCount: number
  captureCount: number
  incidentRevision: string
}
/** Synthetic-only producer. Actor identity, multiuser access and legal authority are not established here. */
export interface PublicSafetyRun {
  version: 1
  evidence: 'owned-public-safety-physics-simulation'
  physicalFlightEnabled: false
  physicalThermalVerified: false
  identityAuthenticated: false
  replayProfile: 'owned-public-safety-collection-v1'
  plan: PublicSafetyPlan
  scenario: PublicSafetyScenario
  seconds: number
  sessionId: string
  survey: SurveyRun
  captures: PublicSafetyThermalAck[]
  unmatchedAcks: PublicSafetyThermalAck[]
  epochs: PublicSafetyEpoch[]
  updates: PublicSafetyUpdate[]
  events: PublicSafetyEvent[]
  faultAtMs: number | null
  faultDemonstrated: boolean
}
