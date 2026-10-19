import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow, IncidentMemberRow } from '../access/policy'
import type { RetentionAbility } from './types'
import { Gate } from '@stacksjs/auth/gate'
import { asRow, db } from '@stacksjs/database/runtime'
import { requirePublicSafetyPrincipal } from '../access/principal'
import { validateIncidentKey } from '../access/policy'
import { projection } from '../access/mutations'
import { PublicSafetyAccessError } from '../access/errors'
import { publicSafetyRecordingData } from '../evidence'
import { retentionAbilities } from './types'
export type { RetentionAbility } from './types'

/** Separate custody capability: expired content access is never broadened. */
export async function requirePublicSafetyRetentionAccess(key: string, ability: RetentionAbility, handle: Pick<TransactionHandle, 'selectFrom'> = db.primary, locked?: IncidentRow) {
  validateIncidentKey(key)
  if (!retentionAbilities.includes(ability)) throw new PublicSafetyAccessError(422, 'Invalid custody ability')
  const principal = await requirePublicSafetyPrincipal(ability === 'read' ? 'read' : 'coordinate')
  const incident = locked ?? asRow<IncidentRow>(await handle.selectFrom('public_safety_incidents').selectAll().where('incident_key', '=', key).executeTakeFirst())
  if (!incident) throw new PublicSafetyAccessError(404, 'Incident custody is unavailable')
  const member = asRow<IncidentMemberRow>(await handle.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', incident.id).where('user_id', '=', principal.userId).executeTakeFirst())
  const coordinator = member?.role === 'coordinator' && member.user_id === incident.coordinator_id
  if (!member || member.active !== true && member.active !== 1 || !coordinator && (ability === 'revoke' || member.role !== 'evidence-custodian')) throw new PublicSafetyAccessError(403, 'This custody action is not permitted')
  const scope = asRow<{ freeze_state: 'retained' | 'frozen' | 'purged', original_hold: 'none' | 'declared-review-required' }>(await handle.selectFrom('public_safety_retention_scopes').select(['freeze_state', 'original_hold']).where('incident_id', '=', incident.id).executeTakeFirst())
  if (scope && scope.freeze_state !== 'retained') {
    const purge = asRow<{ state: string, completed_at_iso: string | null, receipt_retain_until_iso: string | null }>(await handle.selectFrom('public_safety_purges').select(['state', 'completed_at_iso', 'receipt_retain_until_iso']).where('incident_id', '=', incident.id).executeTakeFirst())
    if (!purge || (purge.state === 'complete' || purge.completed_at_iso !== null) && (!purge.receipt_retain_until_iso || Date.parse(purge.receipt_retain_until_iso) <= Date.now())) throw new PublicSafetyAccessError(404, 'Incident custody is unavailable')
    return { principal, incident, member, originalHold: scope.original_hold, lifecycle: 'frozen' as const }
  }
  const stored = projection(incident, member)
  if (publicSafetyRecordingData(stored.config) !== incident.config_json) throw new PublicSafetyAccessError(409, 'Stored incident scope is inconsistent')
  return { principal, incident, member, originalHold: stored.config.retention.hold, lifecycle: 'retained' as const }
}
export async function publicSafetyRetentionGate(user: unknown, key: string, ability: RetentionAbility): Promise<boolean> {
  const access = await requirePublicSafetyRetentionAccess(key, ability)
  return !!user && typeof user === 'object' && 'id' in user && user.id === access.principal.userId
}
export async function authorizePublicSafetyRetention(key: string, ability: RetentionAbility): Promise<void> {
  validateIncidentKey(key)
  if (!retentionAbilities.includes(ability)) throw new PublicSafetyAccessError(422, 'Invalid custody ability')
  const principal = await requirePublicSafetyPrincipal(ability === 'read' ? 'read' : 'coordinate')
  if (!await Gate.allows(`public-safety:retention-${ability}`, principal.user, key)) throw new PublicSafetyAccessError(403, 'This custody action is not permitted')
}
