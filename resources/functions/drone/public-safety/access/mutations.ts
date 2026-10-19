import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentAbility, IncidentAuditAction, IncidentAuditProjection, IncidentProjection } from './types'
import type { IncidentRow, IncidentMemberRow } from './policy'
import { asRow, lockRow, mutationCount } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { planPublicSafetyMission } from '../planner'
import { PublicSafetyAccessError } from './errors'
import { requireIncidentAccess, assertIncidentPayload } from './policy'
import { associateIncidentDeadline, assertIncidentDeadline, checkedIncidentResult } from './deadline'

export const maximumVersion = 2147483647

export function exactRecord(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) throw new PublicSafetyAccessError(422, 'Invalid incident action fields')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !descriptors[key] || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable)) throw new PublicSafetyAccessError(422, 'Invalid incident action fields')
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
}
export function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= maximumVersion) throw new PublicSafetyAccessError(422, 'Invalid incident version')
  return value as number
}
export function projection(incident: IncidentRow, member: IncidentMemberRow): IncidentProjection {
  assertIncidentPayload(incident)
  let plan: ReturnType<typeof planPublicSafetyMission>
  try { plan = planPublicSafetyMission(JSON.parse(incident.config_json)) }
  catch { throw new PublicSafetyAccessError(409, 'Stored incident scope is unavailable') }
  if (plan.config.id !== incident.incident_key || plan.config.revision !== incident.revision || plan.config.purpose !== incident.purpose || plan.config.retention.expiresAt !== incident.retain_until) throw new PublicSafetyAccessError(409, 'Stored incident scope is inconsistent')
  return associateIncidentDeadline({ key: incident.incident_key, version: incident.version, status: incident.status, purpose: incident.purpose, revision: incident.revision, config: plan.config, retainUntil: incident.retain_until, coordinatorId: incident.coordinator_id, membership: { role: member.role, version: member.version }, identityAuthenticated: true, physicalFlightEnabled: false } satisfies IncidentProjection, Date.parse(incident.retain_until))
}

export async function audit(tx: TransactionHandle, incident: IncidentRow, actorId: number, action: IncidentAuditAction, targetUserId: number | null, details: IncidentAuditProjection['details']) {
  const at = new Date().toISOString()
  await tx.insertInto('public_safety_audits').values({ incident_id: incident.id, sequence: incident.version, actor_id: actorId, action, target_user_id: targetUserId, at_iso: at, details_json: JSON.stringify(details), created_at: at, updated_at: at }).execute()
}

export async function mutation<T extends object>(key: string, ability: Exclude<IncidentAbility, 'view' | 'audit'>, expected: number, work: (tx: TransactionHandle, access: Awaited<ReturnType<typeof requireIncidentAccess>>) => Promise<T>): Promise<T> {
  return checkedIncidentResult(transaction(async tx => {
    const row = asRow<IncidentRow>(await lockRow(tx, 'public_safety_incidents', { incident_key: key }))
    if (!row) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
    const access = await requireIncidentAccess(key, ability, tx, row)
    if (access.incident.version !== expected) throw new PublicSafetyAccessError(409, 'Incident version has changed')
    const result = associateIncidentDeadline(await work(tx, access), Date.parse(access.incident.retain_until))
    assertIncidentDeadline(result)
    return result
  }))
}
export async function advance(tx: TransactionHandle, incident: IncidentRow, closed = false): Promise<IncidentRow> {
  if (incident.version >= maximumVersion) throw new PublicSafetyAccessError(409, 'Incident version capacity reached')
  const next = { ...incident, version: incident.version + 1, ...(closed ? { status: 'closed' as const } : {}) }
  const result = await tx.updateTable('public_safety_incidents').set({ version: next.version, status: next.status, updated_at: new Date().toISOString() }).where('id', '=', incident.id).where('version', '=', incident.version).executeTakeFirst()
  if (mutationCount(result) !== 1) throw new PublicSafetyAccessError(409, 'Incident version has changed')
  return next
}

export function pagination(options: unknown = {}): { after: number, limit: number } {
  if (!options || typeof options !== 'object' || Object.getPrototypeOf(options) !== Object.prototype || Object.getOwnPropertySymbols(options).length) throw new PublicSafetyAccessError(422, 'Invalid incident pagination')
  const descriptors = Object.getOwnPropertyDescriptors(options)
  if (Object.keys(descriptors).some(key => !['afterSequence', 'limit'].includes(key) || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable)) throw new PublicSafetyAccessError(422, 'Invalid incident pagination')
  const after = descriptors.afterSequence?.value === undefined ? 0 : descriptors.afterSequence.value, limit = descriptors.limit?.value === undefined ? 100 : descriptors.limit.value
  if (!Number.isSafeInteger(after) || after < 0 || after > maximumVersion || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new PublicSafetyAccessError(422, 'Invalid incident pagination')
  return { after, limit }
}
