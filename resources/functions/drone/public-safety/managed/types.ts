export const managedAbilities = ['read', 'create', 'events', 'reconcile'] as const
export type ManagedAbility = typeof managedAbilities[number]
export const managedStates = ['intent', 'prepared', 'inspecting', 'complete', 'interrupted', 'blocked'] as const
export type ManagedState = typeof managedStates[number]
export const managedActions = ['intent-recorded', 'ownership-recorded', 'published', 'reconcile-claimed', 'reconciled-complete', 'interrupted', 'blocked'] as const
export type ManagedAction = typeof managedActions[number]
export type ManagedOutcome = 'io-failed' | 'ownership-uncertain' | 'interrupted' | 'outcome-unknown' | null
export interface ManagedArtifactProjection {
  key: string, version: number, incidentVersion: number, state: ManagedState,
  sourceId: number, sourceDigest: string, datasetProfile: 'owned-public-safety-dataset-v1',
  requesterUserId: number, requestedAt: string, completedAt: string | null,
  fileCount: number, totalBytes: number, ownershipRecorded: boolean, outcome: ManagedOutcome,
  sourceIdentityAuthenticated: false, physicalFlightEnabled: false, physicalThermalVerified: false,
  purgeImplemented: false, contentDeletionPerformed: false,
}
export interface ManagedFileProjection { id: number, ordinal: number, role: 'recording' | 'visible' | 'thermal' | 'support' | 'readme' | 'manifest', captureId: string | null, filename: string, mimeType: string, bytes: number, sha256: string }
export interface ManagedEventProjection { id: number, sequence: number, incidentVersion: number, action: ManagedAction, actorUserId: number, requestId: string, at: string, outcome: ManagedOutcome }
export interface ManagedArtifactRead { artifact: ManagedArtifactProjection, files: ManagedFileProjection[] }
export interface ManagedReceipt { artifact: ManagedArtifactProjection, event: ManagedEventProjection, replayed: boolean }
export interface ManagedListOptions { afterId?: number, limit?: number, requestId?: string }
export interface ManagedArtifactPage { entries: ManagedArtifactProjection[], cursor: number, hasMore: boolean }
export interface ManagedEventOptions { afterSequence?: number, limit?: number }
export interface ManagedEventPage { entries: ManagedEventProjection[], cursor: number, hasMore: boolean }
/** HTTP must check retainUntil synchronously immediately before Response construction, with no intervening await. */
export interface ManagedDownload { bytes: Uint8Array, mimeType: string, filename: string, retainUntil: string }
export interface ManagedCreateInput { expectedVersion: number, expectedRetentionVersion: number, sourceDigest: string, datasetProfile: 'owned-public-safety-dataset-v1', requestId: string }
export interface ManagedReconcileInput { expectedVersion: number, expectedArtifactVersion: number, requestId: string }
