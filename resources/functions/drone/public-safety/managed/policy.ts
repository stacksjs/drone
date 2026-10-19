import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import type { ManagedAbility } from './types'
import { Gate } from '@stacksjs/auth/gate'
import { db } from '@stacksjs/database/runtime'
import { requireIncidentAccess, validateIncidentKey } from '../access/policy'
import { requirePublicSafetyPrincipal } from '../access/principal'
import { requirePublicSafetyRetentionAccess } from '../retention/policy'
import { PublicSafetyAccessError } from '../access/errors'
import { projection } from '../access/mutations'
import { managedAbilities } from './types'
export type { ManagedAbility } from './types'

export function managedDeadline(incident: IncidentRow): void {
  if (!Number.isFinite(Date.parse(incident.retain_until)) || Date.parse(incident.retain_until) <= Date.now()) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
}
export async function requirePublicSafetyManagedAccess(key: string, ability: ManagedAbility, handle: Pick<TransactionHandle, 'selectFrom'> = db.primary, locked?: IncidentRow) {
  validateIncidentKey(key)
  if (!managedAbilities.includes(ability)) throw new PublicSafetyAccessError(422, 'Invalid managed dataset ability')
  const access = ability === 'create' || ability === 'reconcile'
    ? await requirePublicSafetyRetentionAccess(key, 'manage', handle, locked)
    : await requireIncidentAccess(key, ability === 'events' ? 'audit' : 'view', handle, locked)
  managedDeadline(access.incident)
  if ((ability === 'create' || ability === 'reconcile') && access.incident.status !== 'active') throw new PublicSafetyAccessError(409, 'The incident is closed')
  projection(access.incident, access.member)
  return access
}
export async function publicSafetyManagedGate(user: unknown, key: string, ability: ManagedAbility): Promise<boolean> {
  const access = await requirePublicSafetyManagedAccess(key, ability)
  return !!user && typeof user === 'object' && 'id' in user && user.id === access.principal.userId
}
export async function authorizePublicSafetyManaged(key: string, ability: ManagedAbility): Promise<void> {
  validateIncidentKey(key)
  if (!managedAbilities.includes(ability)) throw new PublicSafetyAccessError(422, 'Invalid managed dataset ability')
  const principal = await requirePublicSafetyPrincipal(ability === 'create' || ability === 'reconcile' ? 'coordinate' : 'read')
  if (!await Gate.allows(`public-safety:managed-${ability}`, principal.user, key)) throw new PublicSafetyAccessError(403, 'This managed dataset action is not permitted')
}
