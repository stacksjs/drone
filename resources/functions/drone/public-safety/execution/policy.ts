import type { TransactionHandle } from '@stacksjs/orm'
import { AsyncResource } from 'node:async_hooks'
import { Gate } from '@stacksjs/auth/gate'
import { asRow, isInTransaction } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { getCurrentRequest, runWithRequest } from '@stacksjs/router'
import limits from '../../../../../config/execution'
import { PublicSafetyAccessError } from '../access/errors'
import { associateIncidentDeadline, checkedIncidentResult } from '../access/deadline'
import { requireIncidentAccess, validateIncidentKey } from '../access/policy'
import { workspaceAccess } from '../workspace/policy'
import { executionOwner } from './state'

const contextBrand = Symbol.for('@stacksjs/drone:incident-execution-context:v1')
export interface ExecutionContext {
  readonly key: string
  readonly [contextBrand]: true
  readonly run: <T>(work: () => Promise<T>) => Promise<T>
}
export interface ExecutionBinding {
  key: string, scope: string, accountId: number, tokenId: number, memberId: number,
  memberVersion: number, role: string, incidentId: number, createdAt: string,
  configJson: string, purpose: string, retainUntil: string, authorityUntil: number,
}
export interface ExecutionAuthority { binding: ExecutionBinding, deadline: number }
/** Capture complete native ALS synchronously before any awaited Action work or transaction. */
export function captureExecutionContext(key: string): ExecutionContext {
  validateIncidentKey(key)
  const request = getCurrentRequest()
  if (!request) throw new PublicSafetyAccessError(401, 'A valid incident access token is required')
  if (isInTransaction()) throw new PublicSafetyAccessError(409, 'Execution context must precede transaction work')
  const run = AsyncResource.bind(<T>(work: () => Promise<T>) => runWithRequest(request, work))
  return Object.freeze({ key, [contextBrand]: true as const, run })
}
function context(value: ExecutionContext): void {
  if (!value || value[contextBrand] !== true || typeof value.run !== 'function' || typeof value.key !== 'string') throw new PublicSafetyAccessError(401, 'A valid incident access token is required')
}
export function requireExecutionScope(scope: unknown): asserts scope is string {
  if (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope)) throw new PublicSafetyAccessError(422, 'Invalid execution scope')
}
export function matchExecutionBinding(original: ExecutionBinding, current: ExecutionBinding): void {
  const fields = ['key', 'scope', 'accountId', 'tokenId', 'memberId', 'memberVersion', 'role', 'incidentId', 'createdAt', 'configJson', 'purpose', 'retainUntil'] as const
  if (fields.some(field => original[field] !== current[field])) throw new PublicSafetyAccessError(409, 'Original execution authority has changed')
}
/** Handle-taking policy for fresh reads and the sole source registration writer. */
export async function executionAccess(tx: TransactionHandle, key: string, scope: string, original?: ExecutionBinding): Promise<ExecutionAuthority> {
  requireExecutionScope(scope)
  const read = await workspaceAccess(tx, key, scope)
  const access = await requireIncidentAccess(key, 'source-register', tx, read.incident)
  if (!await Gate.allows('public-safety:source-register', access.principal.user, key)) throw new PublicSafetyAccessError(403, 'This incident action is not permitted')
  if (access.principal.userId !== read.principal.userId || access.principal.tokenId !== read.principal.tokenId) throw new PublicSafetyAccessError(403, 'Execution authority is unavailable')
  const row = asRow<{ created_at: string }>(await tx.selectFrom('public_safety_incidents').select('created_at').where('id', '=', access.incident.id).executeTakeFirst())
  if (!row || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))) throw new PublicSafetyAccessError(409, 'Incident scope is unavailable')
  const deadline = Math.min(read.deadline, access.principal.tokenDeadline, original?.authorityUntil ?? Number.POSITIVE_INFINITY)
  const binding: ExecutionBinding = {
    key, scope, accountId: access.principal.userId, tokenId: access.principal.tokenId,
    memberId: access.member.id, memberVersion: access.member.version, role: access.member.role,
    incidentId: access.incident.id, createdAt: row.created_at, configJson: access.incident.config_json!,
    purpose: access.incident.purpose!, retainUntil: access.incident.retain_until, authorityUntil: deadline,
  }
  if (original) matchExecutionBinding(original, binding)
  return associateIncidentDeadline({ binding, deadline }, deadline)
}
/** A timed-out native decision retains its pending budget until the real promise settles. */
export async function checkExecutionAuthority(captured: ExecutionContext, scope: string, original?: ExecutionBinding): Promise<ExecutionAuthority> {
  context(captured)
  requireExecutionScope(scope)
  const owner = executionOwner()
  if (owner.pendingChecks >= limits.pendingChecks) throw new PublicSafetyAccessError(409, 'Execution checks are busy')
  owner.pendingChecks++
  const pending = captured.run(() => checkedIncidentResult(transaction(tx => executionAccess(tx, captured.key, scope, original)))).finally(() => { owner.pendingChecks-- })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<never>((resolve, reject) => {
      void resolve
      timer = setTimeout(() => reject(new PublicSafetyAccessError(404, 'Incident is unavailable')), limits.checkTimeoutMs)
    })])
  }
  finally { clearTimeout(timer) }
}
