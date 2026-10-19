import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import type { PurgeAbility } from './types'
import { Gate } from '@stacksjs/auth/gate'
import { db } from '@stacksjs/database/runtime'
import { env } from '@stacksjs/env'
import { PublicSafetyAccessError } from '../access/errors'
import { requirePublicSafetyPrincipal } from '../access/principal'
import { requirePublicSafetyRetentionAccess } from '../retention/policy'
import { validateIncidentKey } from '../access/policy'
import { purgeAbilities } from './types'
export type { PurgeAbility } from './types'
export function purgeEnabled(): boolean { return env.PUBLIC_SAFETY_PURGE_ENABLED === true }
export function requirePurgeEnabled(): void { if (!purgeEnabled()) throw new PublicSafetyAccessError(409, 'Local purge execution is disabled') }
export async function requirePublicSafetyPurgeAccess(key: string, ability: PurgeAbility, handle: Pick<TransactionHandle, 'selectFrom'> = db.primary, locked?: IncidentRow) {
  validateIncidentKey(key)
  if (!purgeAbilities.includes(ability)) throw new PublicSafetyAccessError(422, 'Invalid purge ability')
  return requirePublicSafetyRetentionAccess(key, ability === 'accept' || ability === 'retry' ? 'manage' : 'read', handle, locked)
}
export async function publicSafetyPurgeGate(user: unknown, key: string, ability: PurgeAbility): Promise<boolean> {
  const access = await requirePublicSafetyPurgeAccess(key, ability)
  return !!user && typeof user === 'object' && 'id' in user && user.id === access.principal.userId
}
export async function authorizePublicSafetyPurge(key: string, ability: PurgeAbility): Promise<void> {
  validateIncidentKey(key)
  if (!purgeAbilities.includes(ability)) throw new PublicSafetyAccessError(422, 'Invalid purge ability')
  const principal = await requirePublicSafetyPrincipal(ability === 'accept' || ability === 'retry' ? 'coordinate' : 'read')
  if (!await Gate.allows(`public-safety:purge-${ability}`, principal.user, key)) throw new PublicSafetyAccessError(403, 'This purge action is not permitted')
}
