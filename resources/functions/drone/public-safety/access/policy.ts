import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentAbility, IncidentRole } from './types'
import { asRow, db } from '@stacksjs/database/runtime'
import { incidentAbilities } from './types'
import { PublicSafetyAccessError } from './errors'
import { requirePublicSafetyPrincipal } from './principal'

export interface IncidentRow {
  id: number
  incident_key: string
  version: number
  coordinator_id: number
  status: 'active' | 'closed'
  purpose: 'search-and-rescue' | 'fire-observation' | 'disaster-assessment' | 'lawful-police-observation'
  revision: string
  config_json: string
  retain_until: string
}
export interface IncidentMemberRow {
  id: number
  incident_id: number
  user_id: number
  role: IncidentRole
  active: boolean | number
  version: number
}
export function validateIncidentKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.match(/^[a-z][a-z0-9-]{0,63}$/)?.[0] !== key) throw new PublicSafetyAccessError(422, 'Invalid incident key')
}
export function incidentPermission(member: IncidentMemberRow, incident: IncidentRow, ability: IncidentAbility): boolean {
  if (member.active !== true && member.active !== 1) return false
  if (ability === 'view') return true
  if (ability === 'audit') return member.role === 'evidence-custodian' || member.role === 'coordinator' && member.user_id === incident.coordinator_id
  if (ability === 'observation-create') return true
  if (ability === 'source-register' && (member.role === 'pilot' || member.role === 'evidence-custodian')) return true
  if (ability === 'review-append' && member.role === 'reviewer') return true
  return member.role === 'coordinator' && member.user_id === incident.coordinator_id
}

/** Recheck current token, platform grant, retention and membership on the actual native connection. */
export async function requireIncidentAccess(key: string, ability: IncidentAbility, handle: Pick<TransactionHandle, 'selectFrom'> = db.primary, locked?: IncidentRow) {
  validateIncidentKey(key)
  if (!incidentAbilities.includes(ability)) throw new PublicSafetyAccessError(422, 'Invalid incident ability')
  const principal = await requirePublicSafetyPrincipal(ability === 'view' || ability === 'audit' ? 'read' : 'coordinate')
  const incident = locked ?? asRow<IncidentRow>(await handle.selectFrom('public_safety_incidents').selectAll().where('incident_key', '=', key).executeTakeFirst())
  if (!incident || !Number.isFinite(Date.parse(incident.retain_until)) || Date.parse(incident.retain_until) <= Date.now()) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
  const member = asRow<IncidentMemberRow>(await handle.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', incident.id).where('user_id', '=', principal.userId).executeTakeFirst())
  if (!member || !incidentPermission(member, incident, ability)) throw new PublicSafetyAccessError(403, 'This incident action is not permitted')
  if ((ability !== 'view' && ability !== 'audit') && incident.status !== 'active') throw new PublicSafetyAccessError(409, 'The incident is closed')
  return { principal, incident, member }
}

/** app/Gates delegates here. The supplied Gate user is checked against native request identity, never treated as a principal. */
export async function publicSafetyIncidentGate(user: unknown, key: string, ability: IncidentAbility): Promise<boolean> {
  const access = await requireIncidentAccess(key, ability)
  return !!user && typeof user === 'object' && 'id' in user && user.id === access.principal.userId
}
export async function publicSafetyCreateGate(user: unknown): Promise<boolean> {
  const principal = await requirePublicSafetyPrincipal('coordinate', true)
  return !!user && typeof user === 'object' && 'id' in user && user.id === principal.userId
}
