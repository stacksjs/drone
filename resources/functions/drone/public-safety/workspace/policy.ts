import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentRow } from '../access/policy'
import { createHash, randomUUID } from 'node:crypto'
import { asRow, lockRow } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { Gate } from '@stacksjs/auth/gate'
import { PublicSafetyAccessError } from '../access/errors'
import { requireIncidentAccess, validateIncidentKey } from '../access/policy'
import { projection } from '../access/mutations'
import { associateIncidentDeadline, checkedIncidentResult } from '../access/deadline'

const incarnationProcess = randomUUID()
/** Internal seam shared by the coherent snapshot and content-free stream checks. */
export async function workspaceAccess(tx: TransactionHandle, key: string, expectedScope?: string) {
  validateIncidentKey(key)
  if (expectedScope !== undefined && (typeof expectedScope !== 'string' || !/^[a-f0-9]{64}$/.test(expectedScope))) throw new PublicSafetyAccessError(422, 'Invalid workspace scope')
  const row = asRow<IncidentRow & { created_at: string }>(await lockRow(tx, 'public_safety_incidents', { incident_key: key }))
  if (!row) throw new PublicSafetyAccessError(404, 'Incident is unavailable')
  const access = await requireIncidentAccess(key, 'view', tx, row)
  if (!await Gate.allows('public-safety:view', access.principal.user, key)) throw new PublicSafetyAccessError(403, 'This incident action is not permitted')
  projection(access.incident, access.member)
  if (typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) throw new PublicSafetyAccessError(409, 'Incident scope is unavailable')
  const scope = createHash('sha256').update(JSON.stringify([incarnationProcess, row.id, row.created_at, row.incident_key, row.revision, row.purpose, row.config_json, row.retain_until])).digest('hex')
  if (expectedScope !== undefined && scope !== expectedScope) throw new PublicSafetyAccessError(409, 'Workspace scope has changed')
  const deadline = Math.min(Date.parse(row.retain_until), access.principal.tokenDeadline)
  return { ...access, scope, deadline }
}
/** Fresh native read authority with no source staging. Its return is not an authorization capability. */
export async function readWorkspaceAccess(key: string, expectedScope?: string): Promise<{ incidentId: number, accountId: number, scope: string, deadline: number }> {
  return checkedIncidentResult(transaction(async tx => {
    const access = await workspaceAccess(tx, key, expectedScope)
    return associateIncidentDeadline({ incidentId: access.incident.id, accountId: access.principal.userId, scope: access.scope, deadline: access.deadline }, access.deadline)
  }))
}
