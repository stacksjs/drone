export const purgeAbilities = ['preview', 'accept', 'read', 'events', 'retry'] as const
export type PurgeAbility = typeof purgeAbilities[number]
export const purgeOutcomes = ['executor-disabled', 'ownership-uncertain', 'inspection-unavailable', 'identity-changed', 'unexpected-entry', 'unexpected-link', 'missing-unarmed', 'io-failed', 'sql-failed', 'inventory-changed', 'foreign-reference', 'capacity-exceeded'] as const
export type PurgeOutcome = typeof purgeOutcomes[number]
export type PurgeState = 'building' | 'ready' | 'running' | 'blocked' | 'minimizing' | 'complete'
export type PurgeArmState = 'pending' | 'running' | 'blocked' | 'complete'
export type PurgeAction = 'accept' | 'build' | 'arm' | 'result' | 'db-batch' | 'blocked' | 'retry' | 'minimize' | 'complete' | 'member-revoked'
export interface PurgeCounts {
  incidentPayloads: number, sources: number, observations: number, reviews: number, audits: number,
  nonCustodyMemberships: number, managedArtifacts: number, managedFiles: number, managedEvents: number,
  managedDirectories: number, manifestAliases: number, totalPlannedFileBytes: number,
}
export interface PurgeProgress {
  sourceRowsRemoved: number, observationRowsRemoved: number, reviewRowsRemoved: number, auditRowsRemoved: number,
  nonCustodyMembershipRowsRemoved: number, incidentPayloadRowsCleared: number, fileInodesVerifiedAbsent: number,
  namesVerifiedAbsent: number, namesUnlinked: number, namesInitiallyAbsent: number, namesAbsenceReconciled: number,
  directoriesVerifiedAbsent: number, noPreparationObserved: number, observedFileBytes: number,
}
export interface PurgeExclusions {
  historicalDiagnostics: true, offlineExports: true, downloadedCopies: true,
  backupsAndReplicas: true, processMemory: true, mediaResiduals: true,
}
export const purgeCoverage = 'active-db-and-registered-namespace-v1' as const
export const purgePolicy = 'local-managed-purge-v1' as const
export const purgeExclusions: Readonly<PurgeExclusions> = Object.freeze({ historicalDiagnostics: true, offlineExports: true, downloadedCopies: true, backupsAndReplicas: true, processMemory: true, mediaResiduals: true })
export interface PurgeLimits { diagnosticsErased: false, allCopiesErased: false, mediaErasure: false }
export interface PurgePreview {
  key: string, incidentVersion: number, retentionVersion: number, eligibleAt: string, expired: boolean, executorEnabled: boolean,
  holdState: 'none' | 'pending-review' | 'held' | 'released', eligibility: 'eligible' | 'ineligible',
  reason: 'eligible' | 'executor-disabled' | 'not-due' | 'held' | 'already-accepted', inventoryDigest: string,
  existingPurgeKey: string | null, inventoryKind: 'current-preview' | 'accepted-frozen',
  counts: PurgeCounts, coverage: typeof purgeCoverage, exclusions: PurgeExclusions, limits: PurgeLimits,
  receiptRetentionDays: { min: 1, max: 365 },
}
export interface PurgeStatus extends PurgeLimits {
  key: string, purgeKey: string, policyVersion: typeof purgePolicy, coverage: typeof purgeCoverage, version: number,
  incidentVersion: number, retentionVersion: number, state: PurgeState, fsState: PurgeArmState, dbState: PurgeArmState,
  acceptedAt: string, acceptedByUserId: number, completedAt: string | null, receiptRetentionDays: number,
  receiptRetainUntil: string | null, blockedReviewDueAt: string | null, reviewOverdue: boolean, inventoryDigest: string,
  planned: PurgeCounts, completed: PurgeProgress, outcomeCode: PurgeOutcome | null, contentDeletionPerformed: boolean,
}
export type PurgeActor = { kind: 'human', userId: number } | { kind: 'system', name: 'public-safety-local-purge-v1' }
export interface PurgeEvent {
  sequence: number, incidentVersion: number, retentionVersion: number, actor: PurgeActor, action: PurgeAction,
  at: string, outcome: PurgeOutcome | null, delta: PurgeProgress,
}
export interface PurgeReceipt { purge: PurgeStatus, event: PurgeEvent, replayed: boolean }
export interface PurgeEventPage { entries: PurgeEvent[], cursor: number, hasMore: boolean }
export interface PurgeEventOptions { after?: number, limit?: number }
export interface PurgeAcceptInput {
  expectedVersion: number, expectedRetentionVersion: number, policyVersion: typeof purgePolicy, coverage: typeof purgeCoverage,
  inventoryDigest: string, exclusions: PurgeExclusions, receiptRetentionDays: number, requestId: string,
}
export interface PurgeRetryInput { expectedPurgeVersion: number, expectedRetentionVersion: number, requestId: string }
export function zeroPurgeCounts(): PurgeCounts { return { incidentPayloads: 0, sources: 0, observations: 0, reviews: 0, audits: 0, nonCustodyMemberships: 0, managedArtifacts: 0, managedFiles: 0, managedEvents: 0, managedDirectories: 0, manifestAliases: 0, totalPlannedFileBytes: 0 } }
export function zeroPurgeProgress(): PurgeProgress { return { sourceRowsRemoved: 0, observationRowsRemoved: 0, reviewRowsRemoved: 0, auditRowsRemoved: 0, nonCustodyMembershipRowsRemoved: 0, incidentPayloadRowsCleared: 0, fileInodesVerifiedAbsent: 0, namesVerifiedAbsent: 0, namesUnlinked: 0, namesInitiallyAbsent: 0, namesAbsenceReconciled: 0, directoriesVerifiedAbsent: 0, noPreparationObserved: 0, observedFileBytes: 0 } }
