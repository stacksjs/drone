import type { PublicSafetyEvent, PublicSafetyScenario } from '../runtime-types'

export interface ExecutionStartInput { intent: string, scope: string, scenario: PublicSafetyScenario, seconds: number }
export interface ExecutionStatusInput { scope: string }
export interface ExecutionLocator { execution: string, scope: string }
export interface ExecutionAdmissionInput extends ExecutionLocator { digest: string, expectedVersion: number }
export type ExecutionPhase = 'waiting-for-consumer' | 'running' | 'stopping' | 'completed' | 'canceled' | 'failed' | 'discarded'
export type ExecutionReason = 'consumer-absent' | 'authority-unavailable' | 'deadline-expired' | 'producer-failed' | 'protocol-refused' | 'stopped-by-owner' | 'discarded-by-owner' | 'consumer-failed' | 'stop-unconfirmed' | 'admission-outcome-unknown' | null
export interface ExecutionCompletion {
  digest: string
  byteLength: number
  eventCount: number
  epochCount: number
  captureCount: number
  virtualTimeMs: number
  surveyStatus: string
  faultDemonstrated: boolean
}
/** Volatile authenticated synthetic progress. No recording planes or account/token identifiers. */
export interface ExecutionView {
  execution: string
  intent: string
  scope: string
  profile: 'owned-public-safety-collection-v1'
  phase: ExecutionPhase
  reason: ExecutionReason
  producer: 'pending' | 'finished' | 'unconfirmed'
  scenario: PublicSafetyScenario
  requestedSeconds: number
  startedAt: string
  availableUntil: string
  latestEvent: PublicSafetyEvent | null
  completion: ExecutionCompletion | null
  admission: 'unsubmitted' | 'submitting' | 'confirmed' | 'unknown'
  identityAuthenticated: true
  sourceIdentityAuthenticated: false
  physicalFlightEnabled: false
  physicalThermalVerified: false
}

/** Private native adapter handle, never serialized or supplied by a browser. */
export interface ExecutionAttachment {
  readonly initial: ExecutionView
  check: () => Promise<ExecutionView>
  activate: () => Promise<void>
  release: () => void
}
