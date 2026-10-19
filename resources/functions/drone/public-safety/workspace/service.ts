import type { IncidentMemberRow } from '../access/policy'
import type { WorkspaceOptions, WorkspaceRecipient, WorkspaceSnapshot } from './types'
import { asRows, db } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { PublicSafetyAccessError } from '../access/errors'
import { authorizePublicSafetyIncident } from '../access/service'
import { incidentPermission } from '../access/policy'
import { projection } from '../access/mutations'
import { associateIncidentDeadline, assertIncidentDeadline, checkedIncidentResult, incidentDeadline } from '../access/deadline'
import { projectIncidentSourceCatalog, sourceProjection } from '../access/records'
import { projectIncidentHandoverDesk, pendingWorkspaceHandoverSource } from '../access/handover'
import { stageHandoverSource, unchangedHandoverSource, projectIncidentSourceContext } from '../access/handover-context'
import { workspaceAccess } from './policy'
import { contextCursor, readContextCursor, workspaceOptions } from './cursor'

const maximumSnapshotBytes = 4 * 1024 * 1024
function release<T extends object>(value: T, deadline: number): T {
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return
    associateIncidentDeadline(item, deadline)
    for (const nested of Object.values(item)) visit(nested)
  }
  visit(value)
  assertIncidentDeadline(value)
  return value
}

/** One coherent native snapshot; expensive canonical replay is staged before its final authority lock. */
export async function readIncidentWorkspace(key: string, options: WorkspaceOptions = {}): Promise<WorkspaceSnapshot> {
  const input = workspaceOptions(options)
  await authorizePublicSafetyIncident(key, 'view')
  const stage = await checkedIncidentResult(transaction(async tx => {
    const access = await workspaceAccess(tx, key)
    const offerSource = await pendingWorkspaceHandoverSource(tx, access, input.offerKey)
    return associateIncidentDeadline({ incident: access.incident, scope: access.scope, offerSource }, access.deadline)
  }))
  const staged = new Map<string, Awaited<ReturnType<typeof stageHandoverSource>>>()
  for (const digest of new Set([input.sourceDigest, stage.offerSource])) {
    if (digest !== undefined) staged.set(digest, await stageHandoverSource(db.primary, stage.incident, digest))
  }
  return checkedIncidentResult(transaction(async tx => {
    const access = await workspaceAccess(tx, key, stage.scope), incident = access.incident
    if (input.sourcesAfter > incident.version || input.handoverAfter > incident.version) throw new PublicSafetyAccessError(422, 'Invalid workspace sequence')
    const sources = await projectIncidentSourceCatalog(tx, incident, input.sourcesAfter, input.limit)
    let selected: WorkspaceSnapshot['selected'] = null
    if (input.sourceDigest !== undefined) {
      const source = await unchangedHandoverSource(tx, incident, staged.get(input.sourceDigest)!)
      const cursor = readContextCursor(input.contextCursor, access.scope, source.digest, incident.version)
      if (cursor.through < source.created_sequence) throw new PublicSafetyAccessError(422, 'Invalid workspace context cutoff')
      const context = await projectIncidentSourceContext(tx, incident, { sourceId: source.id, sourceDigest: source.digest, contextThroughSequence: cursor.through }, cursor.after, input.limit)
      selected = { source: sourceProjection(source), contextThroughSequence: cursor.through, entries: context.entries, cursor: context.hasMore ? contextCursor(access.scope, source.digest, cursor.through, context.cursor) : null, hasMore: context.hasMore, newerContext: context.newerContext }
    }
    const handover = await projectIncidentHandoverDesk(tx, access, { offerKey: input.offerKey, afterSequence: input.handoverAfter, limit: input.limit }, staged)
    const coordinator = access.member.role === 'coordinator' && access.member.user_id === incident.coordinator_id
    let recipients: WorkspaceSnapshot['recipients'] = null
    if (coordinator) {
      const rows = asRows<IncidentMemberRow>(await tx.selectFrom('public_safety_incident_members').select(['user_id', 'role', 'version']).where('incident_id', '=', incident.id).where('active', '=', 1).where('role', '!=', 'coordinator').where('user_id', '!=', access.principal.userId).where('user_id', '>', input.membersAfter).orderBy('user_id', 'asc').limit(input.limit + 1).execute())
      const entries = rows.slice(0, input.limit).map(row => ({ userId: row.user_id, role: row.role as WorkspaceRecipient['role'], membershipVersion: row.version }))
      recipients = { entries, cursor: entries.at(-1)?.userId ?? input.membersAfter, hasMore: rows.length > input.limit }
    }
    // Recheck authority after awaited projectors, on the very same native handle.
    const final = await workspaceAccess(tx, key, access.scope)
    if (final.incident.version !== incident.version || final.member.version !== access.member.version || final.member.role !== access.member.role || final.principal.userId !== access.principal.userId || final.principal.canCoordinate !== access.principal.canCoordinate) throw new PublicSafetyAccessError(409, 'Workspace state has changed')
    const deadline = Math.min(access.deadline, final.deadline, incidentDeadline(handover) ?? Number.POSITIVE_INFINITY)
    const can = (ability: Parameters<typeof incidentPermission>[2]) => final.principal.canCoordinate && incident.status === 'active' && incidentPermission(final.member, incident, ability)
    const result: WorkspaceSnapshot = { profile: 'incident-workspace-v1', scope: access.scope, viewer: { accountId: final.principal.userId, canCoordinate: final.principal.canCoordinate }, throughSequence: incident.version, availableUntil: new Date(deadline).toISOString(), incident: projection(incident, final.member), sources, selected, handover, recipients, actions: { canRegisterSource: can('source-register'), canObserve: can('observation-create'), canReview: can('review-append'), canManageMembers: can('manage-members'), canClose: can('close') } }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maximumSnapshotBytes) throw new PublicSafetyAccessError(409, 'Workspace projection exceeds its byte limit')
    return release(result, deadline)
  }))
}
