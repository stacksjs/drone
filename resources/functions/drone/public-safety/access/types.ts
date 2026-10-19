import type { PublicSafetyConfig, IncidentPurpose } from '../types'

export const incidentRoles = ['coordinator', 'pilot', 'observer', 'reviewer', 'evidence-custodian'] as const
export type IncidentRole = typeof incidentRoles[number]
export type AssignableIncidentRole = Exclude<IncidentRole, 'coordinator'>
export const incidentAbilities = ['view', 'audit', 'manage-members', 'close', 'source-register', 'observation-create', 'review-append'] as const
export type IncidentAbility = typeof incidentAbilities[number]
export type IncidentAuditAction = 'created' | 'member-granted' | 'member-revoked' | 'closed' | 'source-registered' | 'observation-created' | 'review-appended'
export interface IncidentProjection {
  key: string
  version: number
  status: 'active' | 'closed'
  purpose: IncidentPurpose
  revision: string
  config: PublicSafetyConfig
  retainUntil: string
  coordinatorId: number
  membership: { role: IncidentRole, version: number }
  identityAuthenticated: true
  physicalFlightEnabled: false
}
export interface IncidentAuditProjection {
  sequence: number
  actorId: number
  action: IncidentAuditAction
  targetUserId: number | null
  at: string
  details: Record<string, string | number | boolean | null>
}
export interface MembershipChangeProjection {
  incident: IncidentProjection
  membership: { userId: number, role: IncidentRole, active: boolean, version: number }
}

export interface IncidentAuditOptions {
  afterSequence?: number
  limit?: number
}
export interface IncidentAuditPage {
  entries: IncidentAuditProjection[]
  cursor: number
  hasMore: boolean
}
