import type { AssignableIncidentRole, IncidentProjection } from '../access/types'
import type { HandoverDesk, HandoverNewerContext } from '../access/handover-types'
import type { ObservationProjection, RecordPage, ReviewProjection, SourceProjection } from '../access/record-types'

export interface WorkspaceOptions {
  sourceDigest?: string
  sourcesAfterSequence?: number
  contextCursor?: string
  offerKey?: string
  handoverAfterSequence?: number
  membersAfterUserId?: number
  limit?: number
}

export interface WorkspaceRecipient {
  userId: number
  role: AssignableIncidentRole
  membershipVersion: number
}

export interface WorkspaceContext {
  source: SourceProjection
  contextThroughSequence: number
  entries: Array<ObservationProjection | ReviewProjection>
  cursor: string | null
  hasMore: boolean
  newerContext: HandoverNewerContext
}

export interface WorkspaceSnapshot {
  profile: 'incident-workspace-v1'
  scope: string
  viewer: { accountId: number, canCoordinate: boolean }
  throughSequence: number
  availableUntil: string
  incident: IncidentProjection
  sources: RecordPage<SourceProjection>
  selected: WorkspaceContext | null
  handover: HandoverDesk
  recipients: { entries: WorkspaceRecipient[], cursor: number, hasMore: boolean } | null
  actions: {
    canRegisterSource: boolean
    canObserve: boolean
    canReview: boolean
    canManageMembers: boolean
    canClose: boolean
  }
}
