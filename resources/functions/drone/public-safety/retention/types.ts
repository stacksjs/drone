export const retentionAbilities = ['read', 'manage', 'revoke'] as const
export type RetentionAbility = typeof retentionAbilities[number]
export type OriginalHold = 'none' | 'declared-review-required'
export type RetentionHoldState = 'none' | 'pending-review' | 'held' | 'released'
export type RetentionAction = 'enrolled' | 'hold-reviewed' | 'member-revoked'
export interface RetentionLimits { purgeImplemented: false, contentDeletionPerformed: false, legacyOfflineExportsManaged: false }
export interface RetentionPreview extends RetentionLimits {
  key: string, incidentVersion: number, retainUntil: string, expired: boolean, originalHold: OriginalHold,
  counts: { sources: number, observations: number, reviews: number }, managedArtifactCount: 0, inventoryDigest: string,
}
export interface RetentionScopeProjection extends RetentionLimits {
  key: string, policyVersion: 'local-managed-v1', version: number, incidentVersion: number, retainUntil: string, expired: boolean,
  originalHold: OriginalHold, holdState: RetentionHoldState, reviewRequired: boolean, reviewOverdue: boolean,
  caseReference: string | null, reviewDueAt: string | null, reviewerUserId: number | null, reviewedAt: string | null,
  enrolledByUserId: number, enrolledAt: string, capabilities: { canManageHold: boolean, canRevokeMembers: boolean },
}
export interface RetentionEventProjection {
  id: number, sequence: number, incidentVersion: number, action: RetentionAction, requestId: string, actorUserId: number, at: string,
  decision: 'retain' | 'release' | null, caseReference: string | null, reviewDueAt: string | null, targetUserId: number | null,
}
export interface RetentionReceipt { scope: RetentionScopeProjection, event: RetentionEventProjection, replayed: boolean }
export interface RetentionEventOptions { afterSequence?: number, limit?: number }
export interface RetentionEventPage { entries: RetentionEventProjection[], cursor: number, hasMore: boolean }
