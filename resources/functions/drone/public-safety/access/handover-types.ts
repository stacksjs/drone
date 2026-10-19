import type { AssignableIncidentRole, IncidentProjection } from './types'
import type { ObservationProjection, ReviewProjection, SourceProjection } from './record-types'

export interface HandoverAssignment {
  kind: 'incident-coordination'
  coordinatorId: number
  coordinatorMembershipVersion: number
}
export interface HandoverOfferInput {
  requestId: string
  assignment: HandoverAssignment
  recipientUserId: number
  recipientMembershipVersion: number
  sourceDigest: string
  outgoingRole: AssignableIncidentRole
  expiresInSeconds: number
}
export interface HandoverAcknowledgement {
  offerDigest: string
  assignment: 'incident-coordination'
  sourceDigest: string
  contextThroughSequence: number
  uncertaintyAcknowledged: true
}
export type HandoverDecisionInput =
  | { requestId: string, offerKey: string, decision: 'accept', acknowledgement: HandoverAcknowledgement }
  | { requestId: string, offerKey: string, decision: 'decline' | 'cancel' }
export interface HandoverNewerContext { throughSequence: number, observations: number, reviews: number }
export interface HandoverEvent {
  sequence: number
  actorId: number
  action: 'handover-offered' | 'handover-accepted' | 'handover-declined' | 'handover-canceled'
  at: string
  requestId: string
  acknowledgement: HandoverAcknowledgement | null
  newerContext: HandoverNewerContext | null
}
export interface HandoverOffer {
  profile: 'incident-coordination-handover-v1'
  key: string
  digest: string
  assignment: HandoverAssignment
  incidentKey: string
  incidentRevision: string
  recipientUserId: number
  recipientRole: AssignableIncidentRole
  recipientMembershipVersion: number
  source: SourceProjection
  configDigest: string
  outgoingRole: AssignableIncidentRole
  offeredAt: string
  expiresAt: string
  contextThroughSequence: number
  state: 'pending' | 'accepted' | 'declined' | 'canceled' | 'expired' | 'invalidated'
  terminalEvent: HandoverEvent | null
  physicalFlightEnabled: false
}
export interface HandoverBriefing {
  source: SourceProjection
  contextThroughSequence: number
  entries: Array<ObservationProjection | ReviewProjection>
  cursor: number
  hasMore: boolean
  newerContext: HandoverNewerContext
  acknowledgementRequired: HandoverAcknowledgement
  sourceIdentityAuthenticated: false
  physicalThermalVerified: false
  physicalFlightEnabled: false
}
export interface HandoverDesk {
  assignment: HandoverAssignment
  incident: IncidentProjection
  offer: HandoverOffer | null
  briefing: HandoverBriefing | null
  actionability: { canOffer: boolean, canAccept: boolean, canDecline: boolean, canCancel: boolean }
}
export interface HandoverReceipt {
  incident: IncidentProjection
  offer: HandoverOffer
  event: HandoverEvent
  replayed: boolean
}
export interface HandoverDeskOptions { offerKey?: string, afterSequence?: number, limit?: number }
