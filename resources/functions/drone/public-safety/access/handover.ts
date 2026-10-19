import type { TransactionHandle } from '@stacksjs/orm'
import type { IncidentMemberRow, IncidentRow } from './policy'
import type { HandoverAssignment, HandoverDesk, HandoverDeskOptions, HandoverOffer, HandoverReceipt } from './handover-types'
import type { HandoverAccess, HandoverReader } from './handover-policy'
import type { HandoverAuditRow, OfferFacts, TerminalFacts } from './handover-ledger'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { asRow, asRows, db, lockRow, mutationCount } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { PublicSafetyAccessError } from './errors'
import { assertIncidentPayload } from './policy'
import { maximumVersion, projection, advance, pagination } from './mutations'
import { associateIncidentDeadline, assertIncidentDeadline, checkedIncidentResult } from './deadline'
import { activeMember, authorizePublicSafetyHandover, isCoordinator, requireHandoverAccess, requireHandoverHuman } from './handover-policy'
import { appendHandoverAudit, commandDigest, decisionInput, eventProjection, findOffer, handoverConflict, handoverPlain, handoverProfile, handoverTable, handoverUnavailable, handoverUuid, hashHandover, offerDigest, offerInput, parseOffer, terminalFor } from './handover-ledger'
import { handoverBriefing, handoverSourceFields, newerHandoverContext, offeredSource, stageHandoverSource, unchangedHandoverSource, verifiedHandoverSource } from './handover-context'

/** Also tag independently returnable nested projections, using the existing shared deadline. */
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
async function lockedAccess(tx: TransactionHandle, key: string, ability: 'read' | 'write'): Promise<HandoverAccess> {
  const row = asRow<IncidentRow>(await lockRow(tx, 'public_safety_incidents', { incident_key: key })) ?? handoverUnavailable()
  return requireHandoverAccess(key, ability, tx, row)
}
async function memberFor(tx: HandoverReader, incidentId: number, userId: number): Promise<IncidentMemberRow | undefined> {
  return asRow<IncidentMemberRow>(await tx.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', incidentId).where('user_id', '=', userId).executeTakeFirst())
}
async function currentAssignment(tx: HandoverReader, access: HandoverAccess): Promise<HandoverAssignment> {
  const rows = asRows<IncidentMemberRow>(await tx.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', access.incident.id).where('role', '=', 'coordinator').where('active', '=', 1).limit(2).execute())
  if (rows.length !== 1 || rows[0]!.user_id !== access.incident.coordinator_id || rows[0]!.version < 1 || rows[0]!.version > maximumVersion) handoverConflict()
  return { kind: 'incident-coordination', coordinatorId: rows[0]!.user_id, coordinatorMembershipVersion: rows[0]!.version }
}
function visible(access: HandoverAccess, facts: OfferFacts): boolean {
  return access.principal.userId === facts.coordinatorId || access.principal.userId === facts.recipientUserId || isCoordinator(access) || access.member.role === 'evidence-custodian'
}
function requireVisible(access: HandoverAccess, facts: OfferFacts) { if (!visible(access, facts)) handoverUnavailable() }
async function bindings(tx: HandoverReader, access: HandoverAccess, facts: OfferFacts): Promise<boolean> {
  const outgoing = await memberFor(tx, access.incident.id, facts.coordinatorId), recipient = await memberFor(tx, access.incident.id, facts.recipientUserId)
  const source = asRow<{ id: number, digest: string, byte_length: number, created_sequence: number, uploader_id: number, uploaded_at_iso: string, replay_profile: string, evidence: string }>(await tx.selectFrom('public_safety_sources').select(handoverSourceFields.filter(field => field !== 'canonical_json')).where('id', '=', facts.sourceId).where('incident_id', '=', access.incident.id).executeTakeFirst())
  return access.incident.status === 'active' && facts.incidentKey === access.incident.incident_key && facts.incidentRevision === access.incident.revision && facts.configDigest === hashHandover(access.incident.config_json!) && access.incident.coordinator_id === facts.coordinatorId && !!outgoing && activeMember(outgoing) && outgoing.role === 'coordinator' && outgoing.version === facts.coordinatorMembershipVersion && !!recipient && activeMember(recipient) && recipient.role === facts.recipientRole && recipient.version === facts.recipientMembershipVersion && !!source && source.digest === facts.sourceDigest && source.byte_length === facts.sourceByteLength && source.created_sequence === facts.sourceCreatedSequence && source.uploader_id === facts.sourceUploaderId && source.uploaded_at_iso === facts.sourceUploadedAt && source.replay_profile === 'owned-public-safety-collection-v1' && source.evidence === 'owned-public-safety-physics-simulation'
}
async function offerProjection(tx: HandoverReader, access: HandoverAccess, facts: OfferFacts): Promise<HandoverOffer> {
  const terminal = await terminalFor(tx, access.incident.id, facts.key), event = terminal ? eventProjection(terminal, facts) : null
  const state = event ? event.action === 'handover-accepted' ? 'accepted' : event.action === 'handover-declined' ? 'declined' : 'canceled' : Date.now() >= Date.parse(facts.expiresAt) ? 'expired' : await bindings(tx, access, facts) ? 'pending' : 'invalidated'
  return { profile: handoverProfile, key: facts.key, digest: offerDigest(facts), assignment: { kind: 'incident-coordination', coordinatorId: facts.coordinatorId, coordinatorMembershipVersion: facts.coordinatorMembershipVersion }, incidentKey: facts.incidentKey, incidentRevision: facts.incidentRevision, recipientUserId: facts.recipientUserId, recipientRole: facts.recipientRole, recipientMembershipVersion: facts.recipientMembershipVersion, source: offeredSource(facts), configDigest: facts.configDigest, outgoingRole: facts.outgoingRole, offeredAt: facts.offeredAt, expiresAt: facts.expiresAt, contextThroughSequence: facts.contextThroughSequence, state, terminalEvent: event, physicalFlightEnabled: false }
}
async function latestOffer(tx: HandoverReader, access: HandoverAccess, assignment: HandoverAssignment): Promise<HandoverAuditRow | undefined> {
  return asRow<HandoverAuditRow>(await tx.selectFrom(handoverTable).selectAll().where('incident_id', '=', access.incident.id).where('actor_id', '=', assignment.coordinatorId).where('handover_assignment_version', '=', assignment.coordinatorMembershipVersion).where('action', '=', 'handover-offered').orderBy('sequence', 'desc').limit(1).executeTakeFirst())
}
async function receipt(tx: HandoverReader, access: HandoverAccess, facts: OfferFacts, row: HandoverAuditRow, replayed: boolean): Promise<HandoverReceipt> {
  const offer = await offerProjection(tx, access, facts)
  if (offer.state === 'expired') handoverUnavailable()
  const deadline = !replayed || !offer.terminalEvent ? Math.min(Date.parse(facts.expiresAt), Date.parse(access.incident.retain_until)) : Date.parse(access.incident.retain_until)
  return release({ incident: projection(access.incident, access.member), offer, event: eventProjection(row, facts), replayed }, deadline)
}
async function replay(tx: HandoverReader, access: HandoverAccess, requestId: string, fingerprint: string): Promise<HandoverReceipt | undefined> {
  const row = asRow<HandoverAuditRow>(await tx.selectFrom(handoverTable).selectAll().where('incident_id', '=', access.incident.id).where('request_id', '=', requestId).executeTakeFirst())
  if (!row) return
  const facts = parseOffer(await findOffer(tx, access.incident.id, row.handover_key))
  requireVisible(access, facts)
  if (row.actor_id !== access.principal.userId || row.request_digest !== fingerprint) handoverConflict()
  return receipt(tx, access, facts, row, true)
}

/** Stage expensive bounded canonical verification outside the final authority transaction.
 * A prior request never stages content: replay remains behind fresh tx authorization.
 */
async function stageCommand(key: string, requestId: string, sourceDigest?: string, offerKey?: string) {
  const access = await requireHandoverAccess(key, 'write')
  const prior = await db.primary.selectFrom(handoverTable).select('id').where('incident_id', '=', access.incident.id).where('request_id', '=', requestId).executeTakeFirst()
  if (prior) return
  if (!offerKey && !isCoordinator(access)) throw new PublicSafetyAccessError(403, 'Only the current coordinator may offer handover')
  let digest = sourceDigest
  if (offerKey) {
    const facts = parseOffer(await findOffer(db.primary, access.incident.id, offerKey))
    requireVisible(access, facts)
    if (access.principal.userId !== facts.recipientUserId) throw new PublicSafetyAccessError(403, 'This handover decision is not permitted')
    digest = facts.sourceDigest
  }
  if (!digest) handoverConflict()
  return stageHandoverSource(db.primary, access.incident, digest)
}

export async function readIncidentHandoverDesk(key: string, options: HandoverDeskOptions = {}): Promise<HandoverDesk> {
  // Descriptor-safe optional keys; pagination() rejects all other shapes and accessors.
  if (!options || typeof options !== 'object' || types.isProxy(options)) throw new PublicSafetyAccessError(422, 'Invalid handover options')
  const names = Object.keys(Object.getOwnPropertyDescriptors(options))
  if (names.some(name => !['offerKey', 'afterSequence', 'limit'].includes(name))) throw new PublicSafetyAccessError(422, 'Invalid handover options')
  const body = handoverPlain(options, names), { after, limit } = pagination(Object.fromEntries(['afterSequence', 'limit'].filter(name => body[name] !== undefined).map(name => [name, body[name]])))
  if (body.offerKey !== undefined) handoverUuid(body.offerKey)
  await authorizePublicSafetyHandover(key, 'read')
  return checkedIncidentResult(transaction(async tx => {
    const access = await lockedAccess(tx, key, 'read'), assignment = await currentAssignment(tx, access)
    const row = body.offerKey === undefined ? await latestOffer(tx, access, assignment) : await findOffer(tx, access.incident.id, body.offerKey as string)
    const facts = row ? parseOffer(row) : null
    if (facts && !visible(access, facts) && body.offerKey !== undefined) handoverUnavailable()
    const selected = facts && visible(access, facts) ? await offerProjection(tx, access, facts) : null
    if (selected?.state === 'expired' && body.offerKey !== undefined) handoverUnavailable()
    const offer = selected?.state === 'expired' ? null : selected
    const pending = offer?.state === 'pending'
    let briefing = null
    if (facts && pending) {
      await verifiedHandoverSource(tx, access.incident, facts.sourceDigest)
      briefing = await handoverBriefing(tx, access.incident, facts, after, limit)
    }
    const current = body.offerKey === undefined ? row : await latestOffer(tx, access, assignment)
    const currentPending = current ? (await offerProjection(tx, access, parseOffer(current))).state === 'pending' : false
    const coordinate = access.principal.canCoordinate && access.incident.status === 'active'
    const desk: HandoverDesk = { assignment, incident: projection(access.incident, access.member), offer, briefing, actionability: { canOffer: coordinate && isCoordinator(access) && !currentPending, canAccept: coordinate && !!pending && access.principal.userId === facts?.recipientUserId, canDecline: coordinate && !!pending && access.principal.userId === facts?.recipientUserId, canCancel: coordinate && !!pending && isCoordinator(access) && access.principal.userId === facts?.coordinatorId } }
    return release(desk, offer && !offer.terminalEvent ? Math.min(Date.parse(facts!.expiresAt), Date.parse(access.incident.retain_until)) : Date.parse(access.incident.retain_until))
  }))
}

export async function offerIncidentCoordination(key: string, input: unknown): Promise<HandoverReceipt> {
  const body = offerInput(input)
  await authorizePublicSafetyHandover(key, 'write')
  const staged = await stageCommand(key, body.requestId, body.sourceDigest)
  return checkedIncidentResult(transaction(async tx => {
    const access = await lockedAccess(tx, key, 'write'), fingerprint = commandDigest(key, access.principal.userId, body)
    const previous = await replay(tx, access, body.requestId, fingerprint)
    if (previous) return previous
    const assignment = await currentAssignment(tx, access)
    if (!isCoordinator(access)) throw new PublicSafetyAccessError(403, 'Only the current coordinator may offer handover')
    if (body.assignment.coordinatorId !== assignment.coordinatorId || body.assignment.coordinatorMembershipVersion !== assignment.coordinatorMembershipVersion) handoverConflict()
    if (body.recipientUserId === access.principal.userId) throw new PublicSafetyAccessError(422, 'Handover requires another member')
    const incoming = await memberFor(tx, access.incident.id, body.recipientUserId)
    if (!incoming || !activeMember(incoming) || incoming.role === 'coordinator' || incoming.version !== body.recipientMembershipVersion) handoverConflict()
    await requireHandoverHuman(tx, incoming.user_id)
    const latest = await latestOffer(tx, access, assignment)
    if (latest && (await offerProjection(tx, access, parseOffer(latest))).state === 'pending') handoverConflict()
    if (!staged) handoverConflict()
    const source = await unchangedHandoverSource(tx, access.incident, staged)
    // Recheck request identity after source verification and any awaited native queries.
    await requireHandoverAccess(key, 'write', tx, access.incident)
    const offeredAt = new Date().toISOString(), expiry = Math.min(Date.now() + body.expiresInSeconds * 1000, Date.parse(access.incident.retain_until))
    const incident = await advance(tx, access.incident)
    assertIncidentPayload(incident)
    const facts: OfferFacts = { profile: handoverProfile, key: randomUUID(), incidentKey: incident.incident_key, incidentRevision: incident.revision!, coordinatorId: assignment.coordinatorId, coordinatorMembershipVersion: assignment.coordinatorMembershipVersion, recipientUserId: incoming.user_id, recipientRole: incoming.role, recipientMembershipVersion: incoming.version, outgoingRole: body.outgoingRole, sourceId: source.id, sourceDigest: source.digest, sourceByteLength: source.byte_length, sourceCreatedSequence: source.created_sequence, sourceUploaderId: source.uploader_id, sourceUploadedAt: source.uploaded_at_iso, configDigest: hashHandover(incident.config_json!), offeredAt, expiresAt: new Date(expiry).toISOString(), contextThroughSequence: incident.version }
    const row = await appendHandoverAudit(tx, { incident_id: incident.id, sequence: incident.version, actor_id: access.principal.userId, action: 'handover-offered', target_user_id: incoming.user_id, at_iso: offeredAt, handover_key: facts.key, handover_step: 'offer', handover_assignment_version: assignment.coordinatorMembershipVersion, request_id: body.requestId, request_digest: fingerprint }, { ...facts, offerDigest: offerDigest(facts) })
    access.incident = incident
    return receipt(tx, access, facts, row, false)
  }))
}

export async function decideIncidentHandover(key: string, input: unknown): Promise<HandoverReceipt> {
  const body = decisionInput(input)
  await authorizePublicSafetyHandover(key, 'write')
  const staged = body.decision === 'accept' ? await stageCommand(key, body.requestId, undefined, body.offerKey) : undefined
  return checkedIncidentResult(transaction(async tx => {
    const access = await lockedAccess(tx, key, 'write'), fingerprint = commandDigest(key, access.principal.userId, body)
    const previous = await replay(tx, access, body.requestId, fingerprint)
    if (previous) return previous
    const facts = parseOffer(await findOffer(tx, access.incident.id, body.offerKey))
    requireVisible(access, facts)
    const actor = body.decision === 'cancel' ? facts.coordinatorId : facts.recipientUserId
    if (access.principal.userId !== actor) throw new PublicSafetyAccessError(403, 'This handover decision is not permitted')
    const offer = await offerProjection(tx, access, facts)
    if (offer.state !== 'pending') handoverConflict()
    await currentAssignment(tx, access)
    const outgoing = (await memberFor(tx, access.incident.id, facts.coordinatorId))!, incoming = (await memberFor(tx, access.incident.id, facts.recipientUserId))!
    let newer = null
    if (body.decision === 'accept') {
      const ack = body.acknowledgement
      if (ack.offerDigest !== offer.digest || ack.sourceDigest !== facts.sourceDigest || ack.contextThroughSequence !== facts.contextThroughSequence) handoverConflict()
      if (!staged) handoverConflict()
      await unchangedHandoverSource(tx, access.incident, staged)
      await requireHandoverHuman(tx, facts.coordinatorId)
      await requireHandoverHuman(tx, facts.recipientUserId)
      newer = await newerHandoverContext(tx, access.incident, facts)
      if (outgoing.version >= maximumVersion || incoming.version >= maximumVersion) handoverConflict()
    }
    await requireHandoverAccess(key, 'write', tx, access.incident)
    if (Date.now() >= Date.parse(facts.expiresAt) || access.incident.version >= maximumVersion) handoverConflict()
    const at = new Date().toISOString(), accepted = body.decision === 'accept'
    if (accepted) {
      for (const [member, role] of [[outgoing, facts.outgoingRole], [incoming, 'coordinator']] as const) {
        const changed = await tx.updateTable('public_safety_incident_members').set({ role, version: member.version + 1, active: true, granted_by: access.principal.userId, revoked_by: null, updated_at: at }).where('id', '=', member.id).where('version', '=', member.version).where('role', '=', member.role).where('active', '=', 1).executeTakeFirst()
        if (mutationCount(changed) !== 1) handoverConflict()
      }
      const changed = await tx.updateTable('public_safety_incidents').set({ coordinator_id: facts.recipientUserId, version: access.incident.version + 1, updated_at: at }).where('id', '=', access.incident.id).where('version', '=', access.incident.version).where('coordinator_id', '=', facts.coordinatorId).executeTakeFirst()
      if (mutationCount(changed) !== 1) handoverConflict()
      access.incident = { ...access.incident, coordinator_id: facts.recipientUserId, version: access.incident.version + 1 }
      access.member = { ...incoming, role: 'coordinator', version: incoming.version + 1 }
      await currentAssignment(tx, access)
    }
    else {
      const incident = await advance(tx, access.incident)
      assertIncidentPayload(incident)
      access.incident = incident
    }
    const details: TerminalFacts = { profile: handoverProfile, offerDigest: offer.digest, coordinatorBefore: facts.coordinatorId, coordinatorAfter: accepted ? facts.recipientUserId : facts.coordinatorId, outgoingVersionBefore: outgoing.version, outgoingVersionAfter: outgoing.version + (accepted ? 1 : 0), recipientVersionBefore: incoming.version, recipientVersionAfter: incoming.version + (accepted ? 1 : 0), outgoingRole: facts.outgoingRole, acknowledged: accepted, sourceDigest: accepted ? facts.sourceDigest : null, contextThroughSequence: accepted ? facts.contextThroughSequence : null, newerThroughSequence: newer?.throughSequence ?? null, newerObservations: newer?.observations ?? null, newerReviews: newer?.reviews ?? null }
    const row = await appendHandoverAudit(tx, { incident_id: access.incident.id, sequence: access.incident.version, actor_id: access.principal.userId, action: accepted ? 'handover-accepted' : body.decision === 'decline' ? 'handover-declined' : 'handover-canceled', target_user_id: body.decision === 'cancel' ? facts.recipientUserId : facts.coordinatorId, at_iso: at, handover_key: facts.key, handover_step: 'terminal', handover_assignment_version: facts.coordinatorMembershipVersion, request_id: body.requestId, request_digest: fingerprint }, details)
    return receipt(tx, access, facts, row, false)
  }))
}
