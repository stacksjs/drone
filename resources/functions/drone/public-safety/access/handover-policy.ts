import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow, IncidentMemberRow } from './policy'
import { Gate } from '@stacksjs/auth/gate'
import { createBqbRbacStore } from '@stacksjs/auth/rbac-store-bqb'
import { asRow, db } from '@stacksjs/database/runtime'
import { requirePublicSafetyPrincipal } from './principal'
import { assertIncidentPayload, requireIncidentUnfrozen, validateIncidentKey } from './policy'
import { projection } from './mutations'
import { PublicSafetyAccessError } from './errors'

export type HandoverAbility = 'read' | 'write'
export type HandoverReader = Pick<TransactionHandle, 'selectFrom'>
export async function requireHandoverAccess(key: string, ability: HandoverAbility, handle: HandoverReader = db.primary, locked?: IncidentRow) {
  validateIncidentKey(key)
  if (ability !== 'read' && ability !== 'write') throw new PublicSafetyAccessError(422, 'Invalid handover ability')
  const principal = await requirePublicSafetyPrincipal(ability === 'read' ? 'read' : 'coordinate')
  const incident = locked ?? asRow<IncidentRow>(await handle.selectFrom('public_safety_incidents').selectAll().where('incident_key', '=', key).executeTakeFirst())
  if (!incident || !Number.isFinite(Date.parse(incident.retain_until)) || Date.parse(incident.retain_until) <= Date.now()) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
  assertIncidentPayload(incident)
  await requireIncidentUnfrozen(handle, incident.id)
  const member = asRow<IncidentMemberRow>(await handle.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', incident.id).where('user_id', '=', principal.userId).executeTakeFirst())
  if (!member || !activeMember(member)) throw new PublicSafetyAccessError(403, 'This handover action is not permitted')
  if (ability === 'write' && incident.status !== 'active') throw new PublicSafetyAccessError(409, 'The incident is closed')
  projection(incident, member)
  return { principal, incident, member }
}
export type HandoverAccess = Awaited<ReturnType<typeof requireHandoverAccess>>
export function activeMember(member: IncidentMemberRow): boolean { return member.active === true || member.active === 1 }
export function isCoordinator(access: HandoverAccess): boolean { return access.member.role === 'coordinator' && access.member.user_id === access.incident.coordinator_id }
/** Native SQL eligibility for another human; current Auth always stays the request actor. */
export async function requireHandoverHuman(handle: HandoverReader, userId: number): Promise<void> {
  const user = await handle.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()
  const store = createBqbRbacStore()
  if (!store.getUserPermissions) throw new Error('Native permission resolution is unavailable')
  const permissions = await store.getUserPermissions(userId)
  if (!user || !permissions.some(permission => permission.guard_name === 'web' && permission.name === 'public-safety:access')) throw new PublicSafetyAccessError(403, 'Handover participant eligibility is required')
}
export async function publicSafetyHandoverGate(user: unknown, key: string, ability: HandoverAbility): Promise<boolean> {
  const access = await requireHandoverAccess(key, ability)
  return !!user && typeof user === 'object' && 'id' in user && user.id === access.principal.userId
}
export async function authorizePublicSafetyHandover(key: string, ability: HandoverAbility): Promise<void> {
  const access = await requireHandoverAccess(key, ability)
  if (!await Gate.allows(`public-safety:handover-${ability}`, access.principal.user, key)) throw new PublicSafetyAccessError(403, 'This handover action is not permitted')
}
