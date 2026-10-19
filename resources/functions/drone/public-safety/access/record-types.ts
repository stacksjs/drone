import type { IncidentProjection } from './types'

export const reviewDispositions = ['unresolved', 'supported-by-source', 'not-supported-by-source'] as const
export type ReviewDisposition = typeof reviewDispositions[number]
export type ObservationModality = 'visible' | 'thermal'
export type RecordingData = null | boolean | number | string | RecordingData[] | { [key: string]: RecordingData }
export interface RecordPageOptions { afterSequence?: number, limit?: number }
export interface RecordPage<T> { entries: T[], cursor: number, hasMore: boolean }
export interface SourceProjection {
  id: number
  digest: string
  byteLength: number
  replayProfile: 'owned-public-safety-collection-v1'
  evidence: 'owned-public-safety-physics-simulation'
  uploaderId: number
  uploadedAt: string
  createdSequence: number
  sourceIdentityAuthenticated: false
  uploaderAuthenticated: true
  physicalFlightEnabled: false
  physicalThermalVerified: false
}
export interface ObservationProjection {
  id: number
  sourceDigest: string
  captureId: string
  modality: ObservationModality
  pixel: { x: number, y: number }
  note: string
  uncertaintyNote: string
  actorId: number
  observedAt: string
  createdSequence: number
  sourceIdentityAuthenticated: false
  physicalFlightEnabled: false
  physicalThermalVerified: false
}
export interface ReviewProjection {
  id: number
  observationId: number
  sourceDigest: string
  previousReviewId: number | null
  disposition: ReviewDisposition
  note: string
  uncertaintyNote: string
  actorId: number
  reviewedAt: string
  createdSequence: number
  selfReview: boolean
  sourceIdentityAuthenticated: false
  physicalFlightEnabled: false
  physicalThermalVerified: false
}
export interface SourceRegistration { incident: IncidentProjection, source: SourceProjection }
export interface SourceRead { source: SourceProjection, recording: RecordingData }
export interface ObservationAppend { incident: IncidentProjection, observation: ObservationProjection }
export interface ReviewAppend { incident: IncidentProjection, review: ReviewProjection }
