import type { PublicSafetyConfig, IncidentPurpose } from '../types'

export const incidentRoles = ['coordinator', 'pilot', 'observer', 'reviewer', 'evidence-custodian'] as const
export type IncidentRole = typeof incidentRoles[number]
export type AssignableIncidentRole = Exclude<IncidentRole, 'coordinator'>
export type IncidentAbility = 'view' | 'audit' | 'manage-members' | 'close'
export type IncidentAuditAction = 'created' | 'member-granted' | 'member-revoked' | 'closed'
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
