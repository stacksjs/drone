import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentAbility, IncidentAuditAction, IncidentAuditProjection, IncidentProjection, MembershipChangeProjection, AssignableIncidentRole } from './types'
import type { IncidentRow, IncidentMemberRow } from './policy'
import { Gate } from '@stacksjs/auth/gate'
import { asRow, asRows, lockRow, mutationCount } from '@stacksjs/database/runtime'
import { isUniqueViolation, transaction } from '@stacksjs/orm'
import { planPublicSafetyMission } from '../planner'
import { publicSafetyRecordingData } from '../evidence'
import { PublicSafetyAccessError } from './errors'
import { requirePublicSafetyPrincipal } from './principal'
import { requireIncidentAccess, validateIncidentKey } from './policy'

export { PublicSafetyAccessError } from './errors'
const maximumVersion = 2147483647

function exactRecord(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length) throw new PublicSafetyAccessError(422, 'Invalid incident action fields')
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Object.keys(descriptors).length !== keys.length || keys.some(key => !descriptors[key] || !('value' in descriptors[key]!) || !descriptors[key]!.enumerable)) throw new PublicSafetyAccessError(422, 'Invalid incident action fields')
  return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]))
}
function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= maximumVersion) throw new PublicSafetyAccessError(422, 'Invalid incident version')
  return value as number
}
function projection(incident: IncidentRow, member: IncidentMemberRow): IncidentProjection {
  let plan: ReturnType<typeof planPublicSafetyMission>
  try { plan = planPublicSafetyMission(JSON.parse(incident.config_json)) }
  catch { throw new PublicSafetyAccessError(409, 'Stored incident scope is unavailable') }
  if (plan.config.id !== incident.incident_key || plan.config.revision !== incident.revision || plan.config.purpose !== incident.purpose || plan.config.retention.expiresAt !== incident.retain_until) throw new PublicSafetyAccessError(409, 'Stored incident scope is inconsistent')
  return { key: incident.incident_key, version: incident.version, status: incident.status, purpose: incident.purpose, revision: incident.revision, config: plan.config, retainUntil: incident.retain_until, coordinatorId: incident.coordinator_id, membership: { role: member.role, version: member.version }, identityAuthenticated: true, physicalFlightEnabled: false }
}

export async function authorizePublicSafetyCreate(): Promise<void> {
  const principal = await requirePublicSafetyPrincipal('coordinate', true)
  if (!await Gate.allows('public-safety:create', principal.user)) throw new PublicSafetyAccessError(403, 'Incident creation is not permitted')
}
export async function authorizePublicSafetyIncident(key: string, ability: IncidentAbility): Promise<void> {
  validateIncidentKey(key)
  const principal = await requirePublicSafetyPrincipal(ability === 'view' || ability === 'audit' ? 'read' : 'coordinate')
  if (!await Gate.allows(`public-safety:${ability}`, principal.user, key)) throw new PublicSafetyAccessError(403, 'This incident action is not permitted')
}
async function audit(tx: TransactionHandle, incident: IncidentRow, actorId: number, action: IncidentAuditAction, targetUserId: number | null, details: IncidentAuditProjection['details']) {
  const at = new Date().toISOString()
  await tx.insertInto('public_safety_audits').values({ incident_id: incident.id, sequence: incident.version, actor_id: actorId, action, target_user_id: targetUserId, at_iso: at, details_json: JSON.stringify(details), created_at: at, updated_at: at }).execute()
}

export async function createPublicSafetyIncident(input: unknown): Promise<IncidentProjection> {
  const body = exactRecord(input, ['config'])
  let plan: ReturnType<typeof planPublicSafetyMission>
  try { plan = planPublicSafetyMission(body.config) }
  catch { throw new PublicSafetyAccessError(422, 'Invalid incident configuration') }
  const expiry = Date.parse(plan.config.retention.expiresAt)
  if (expiry <= Date.now() || expiry - Date.now() > 366 * 86400000) throw new PublicSafetyAccessError(422, 'Incident retention must expire within the next 366 days')
  const configJson = publicSafetyRecordingData(plan.config)
  await authorizePublicSafetyCreate()
  try {
    return await transaction(async tx => {
      const principal = await requirePublicSafetyPrincipal('coordinate', true)
      // The native user row serializes simultaneous creates from this coordinating account.
      if (!await lockRow(tx, 'users', { id: principal.userId })) throw new PublicSafetyAccessError(401, 'The incident account is unavailable')
      if (expiry <= Date.now()) throw new PublicSafetyAccessError(422, 'Incident retention has expired')
      if (await tx.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', plan.config.id).executeTakeFirst()) throw new PublicSafetyAccessError(409, 'Incident key already exists')
      const at = new Date().toISOString()
      await tx.insertInto('public_safety_incidents').values({ incident_key: plan.config.id, version: 1, coordinator_id: principal.userId, status: 'active', purpose: plan.config.purpose, revision: plan.config.revision, config_json: configJson, retain_until: plan.config.retention.expiresAt, created_at: at, updated_at: at }).execute()
      const incident = asRow<IncidentRow>(await tx.selectFrom('public_safety_incidents').selectAll().where('incident_key', '=', plan.config.id).executeTakeFirst())!
      await tx.insertInto('public_safety_incident_members').values({ incident_id: incident.id, user_id: principal.userId, role: 'coordinator', active: true, version: 1, granted_by: principal.userId, revoked_by: null, created_at: at, updated_at: at }).execute()
      await audit(tx, incident, principal.userId, 'created', null, { revision: incident.revision, purpose: incident.purpose })
      const member = asRow<IncidentMemberRow>(await tx.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', incident.id).where('user_id', '=', principal.userId).executeTakeFirst())!
      return projection(incident, member)
    })
  }
  catch (error) {
    if (isUniqueViolation(error)) throw new PublicSafetyAccessError(409, 'Incident key already exists')
    throw error
  }
}

export async function readPublicSafetyIncident(key: string): Promise<IncidentProjection> {
  await authorizePublicSafetyIncident(key, 'view')
  return transaction(async tx => {
    const { incident, member } = await requireIncidentAccess(key, 'view', tx)
    return projection(incident, member)
  })
}

async function mutation<T>(key: string, ability: 'manage-members' | 'close', expected: number, work: (tx: TransactionHandle, access: Awaited<ReturnType<typeof requireIncidentAccess>>) => Promise<T>): Promise<T> {
  return transaction(async tx => {
    const row = asRow<IncidentRow>(await lockRow(tx, 'public_safety_incidents', { incident_key: key }))
    if (!row) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
    const access = await requireIncidentAccess(key, ability, tx, row)
    if (access.incident.version !== expected) throw new PublicSafetyAccessError(409, 'Incident version has changed')
    return work(tx, access)
  })
}
async function advance(tx: TransactionHandle, incident: IncidentRow, closed = false): Promise<IncidentRow> {
  if (incident.version >= maximumVersion) throw new PublicSafetyAccessError(409, 'Incident version capacity reached')
  const next = { ...incident, version: incident.version + 1, ...(closed ? { status: 'closed' as const } : {}) }
  const result = await tx.updateTable('public_safety_incidents').set({ version: next.version, status: next.status, updated_at: new Date().toISOString() }).where('id', '=', incident.id).where('version', '=', incident.version).executeTakeFirst()
  if (mutationCount(result) !== 1) throw new PublicSafetyAccessError(409, 'Incident version has changed')
  return next
}

export async function changePublicSafetyMembership(key: string, input: unknown): Promise<MembershipChangeProjection> {
  const body = exactRecord(input, ['expectedVersion', 'userId', 'role']), expected = expectedVersion(body.expectedVersion)
  if (!Number.isSafeInteger(body.userId) || (body.userId as number) < 1 || body.role !== null && !['pilot', 'observer', 'reviewer', 'evidence-custodian'].includes(body.role as string)) throw new PublicSafetyAccessError(422, 'Invalid incident membership')
  const userId = body.userId as number, role = body.role as AssignableIncidentRole | null
  await authorizePublicSafetyIncident(key, 'manage-members')
  return mutation(key, 'manage-members', expected, async (tx, access) => {
    if (userId === access.incident.coordinator_id) throw new PublicSafetyAccessError(409, 'Coordinator transfer requires an explicit handover workflow')
    if (!await tx.selectFrom('users').select('id').where('id', '=', userId).executeTakeFirst()) throw new PublicSafetyAccessError(422, 'Membership requires an existing account')
    const member = asRow<IncidentMemberRow>(await tx.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', access.incident.id).where('user_id', '=', userId).executeTakeFirst())
    if (role === null && (!member || member.active !== true && member.active !== 1)) throw new PublicSafetyAccessError(409, 'The incident membership is already inactive')
    const at = new Date().toISOString(), nextVersion = (member?.version ?? 0) + 1
    if (nextVersion > maximumVersion) throw new PublicSafetyAccessError(409, 'Membership version capacity reached')
    const values = { role: role ?? member!.role, active: role !== null, version: nextVersion, granted_by: role === null ? undefined : access.principal.userId, revoked_by: role === null ? access.principal.userId : null, updated_at: at }
    if (member) {
      const { granted_by, ...rest } = values
      await tx.updateTable('public_safety_incident_members').set(granted_by === undefined ? rest : { ...rest, granted_by }).where('id', '=', member.id).execute()
    }
    else await tx.insertInto('public_safety_incident_members').values({ ...values, incident_id: access.incident.id, user_id: userId, created_at: at }).execute()
    const incident = await advance(tx, access.incident)
    await audit(tx, incident, access.principal.userId, role === null ? 'member-revoked' : 'member-granted', userId, { role: values.role, active: values.active, membershipVersion: nextVersion })
    return { incident: projection(incident, access.member), membership: { userId, role: values.role, active: values.active, version: nextVersion } }
  })
}

export async function closePublicSafetyIncident(key: string, input: unknown): Promise<IncidentProjection> {
  const expected = expectedVersion(exactRecord(input, ['expectedVersion']).expectedVersion)
  await authorizePublicSafetyIncident(key, 'close')
  return mutation(key, 'close', expected, async (tx, access) => {
    const incident = await advance(tx, access.incident, true)
    await audit(tx, incident, access.principal.userId, 'closed', null, {})
    return projection(incident, access.member)
  })
}

export async function readPublicSafetyAudit(key: string): Promise<IncidentAuditProjection[]> {
  await authorizePublicSafetyIncident(key, 'audit')
  return transaction(async tx => {
    const { incident } = await requireIncidentAccess(key, 'audit', tx)
    const rows = asRows<{ sequence: number, actor_id: number, action: IncidentAuditAction, target_user_id: number | null, at_iso: string, details_json: string }>(await tx.selectFrom('public_safety_audits').select(['sequence', 'actor_id', 'action', 'target_user_id', 'at_iso', 'details_json']).where('incident_id', '=', incident.id).orderBy('sequence', 'asc').limit(1001).execute())
    if (rows.length > 1000) throw new PublicSafetyAccessError(409, 'Incident audit requires bounded pagination')
    return rows.map(row => ({ sequence: row.sequence, actorId: row.actor_id, action: row.action, targetUserId: row.target_user_id, at: row.at_iso, details: JSON.parse(row.details_json) }))
  })
}
