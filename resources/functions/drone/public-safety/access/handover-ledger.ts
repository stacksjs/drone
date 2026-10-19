import type { TransactionHandle } from '@stacksjs/orm'
import type { AssignableIncidentRole } from './types'
import type { HandoverAcknowledgement, HandoverEvent, HandoverNewerContext, HandoverOfferInput, HandoverDecisionInput } from './handover-types'
import type { HandoverReader } from './handover-policy'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { asRow } from '@stacksjs/database/runtime'
import { exactRecord, maximumVersion } from './mutations'
import { PublicSafetyAccessError } from './errors'

export const handoverProfile = 'incident-coordination-handover-v1' as const
export const handoverTable = 'public_safety_audits'
export function handoverConflict(): never { throw new PublicSafetyAccessError(409, 'Incident handover has changed') }
export function handoverUnavailable(): never { throw new PublicSafetyAccessError(404, 'Incident handover is unavailable') }
export const hashHandover = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
export function handoverInteger(value: unknown, min = 1, max = maximumVersion): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new PublicSafetyAccessError(422, 'Invalid handover number')
  return value as number
}
export function handoverUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) || value.length !== 36) throw new PublicSafetyAccessError(422, 'Invalid handover identifier')
}
export function handoverDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value) || value.length !== 64) throw new PublicSafetyAccessError(422, 'Invalid handover digest')
}
export function handoverRole(value: unknown): AssignableIncidentRole {
  if (!['pilot', 'observer', 'reviewer', 'evidence-custodian'].includes(value as string)) throw new PublicSafetyAccessError(422, 'Invalid outgoing role')
  return value as AssignableIncidentRole
}
export function handoverPlain(input: unknown, keys: string[]) {
  if (types.isProxy(input)) throw new PublicSafetyAccessError(422, 'Invalid handover fields')
  return exactRecord(input, keys)
}
export function offerInput(input: unknown): HandoverOfferInput {
  const body = handoverPlain(input, ['requestId', 'assignment', 'recipientUserId', 'recipientMembershipVersion', 'sourceDigest', 'outgoingRole', 'expiresInSeconds'])
  const assignment = handoverPlain(body.assignment, ['kind', 'coordinatorId', 'coordinatorMembershipVersion'])
  handoverUuid(body.requestId); handoverDigest(body.sourceDigest)
  if (assignment.kind !== 'incident-coordination') throw new PublicSafetyAccessError(422, 'Invalid handover assignment')
  return { requestId: body.requestId, assignment: { kind: 'incident-coordination', coordinatorId: handoverInteger(assignment.coordinatorId, 1, Number.MAX_SAFE_INTEGER), coordinatorMembershipVersion: handoverInteger(assignment.coordinatorMembershipVersion) }, recipientUserId: handoverInteger(body.recipientUserId, 1, Number.MAX_SAFE_INTEGER), recipientMembershipVersion: handoverInteger(body.recipientMembershipVersion), sourceDigest: body.sourceDigest, outgoingRole: handoverRole(body.outgoingRole), expiresInSeconds: handoverInteger(body.expiresInSeconds, 30, 1800) }
}
export function decisionInput(input: unknown): HandoverDecisionInput {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new PublicSafetyAccessError(422, 'Invalid handover decision')
  const descriptor = Object.getOwnPropertyDescriptor(input, 'decision')
  const decision = descriptor && 'value' in descriptor ? descriptor.value : undefined
  if (!['accept', 'decline', 'cancel'].includes(decision)) throw new PublicSafetyAccessError(422, 'Invalid handover decision')
  const body = handoverPlain(input, decision === 'accept' ? ['requestId', 'offerKey', 'decision', 'acknowledgement'] : ['requestId', 'offerKey', 'decision'])
  handoverUuid(body.requestId); handoverUuid(body.offerKey)
  if (decision !== 'accept') return { requestId: body.requestId, offerKey: body.offerKey, decision }
  const ack = handoverPlain(body.acknowledgement, ['offerDigest', 'assignment', 'sourceDigest', 'contextThroughSequence', 'uncertaintyAcknowledged'])
  handoverDigest(ack.offerDigest); handoverDigest(ack.sourceDigest)
  if (ack.assignment !== 'incident-coordination' || ack.uncertaintyAcknowledged !== true) throw new PublicSafetyAccessError(422, 'Explicit handover acknowledgement is required')
  return { requestId: body.requestId, offerKey: body.offerKey, decision, acknowledgement: { offerDigest: ack.offerDigest, assignment: 'incident-coordination', sourceDigest: ack.sourceDigest, contextThroughSequence: handoverInteger(ack.contextThroughSequence), uncertaintyAcknowledged: true } }
}
export function commandDigest(key: string, actor: number, command: HandoverOfferInput | HandoverDecisionInput): string {
  return hashHandover(JSON.stringify([handoverProfile, key, actor, 'assignment' in command ? 'offer' : 'decision', command]))
}
export interface OfferFacts {
  profile: typeof handoverProfile
  key: string
  incidentKey: string
  incidentRevision: string
  coordinatorId: number
  coordinatorMembershipVersion: number
  recipientUserId: number
  recipientRole: AssignableIncidentRole
  recipientMembershipVersion: number
  outgoingRole: AssignableIncidentRole
  sourceId: number
  sourceDigest: string
  sourceByteLength: number
  sourceCreatedSequence: number
  sourceUploaderId: number
  sourceUploadedAt: string
  configDigest: string
  offeredAt: string
  expiresAt: string
  contextThroughSequence: number
}
const offerKeys = ['profile', 'key', 'incidentKey', 'incidentRevision', 'coordinatorId', 'coordinatorMembershipVersion', 'recipientUserId', 'recipientRole', 'recipientMembershipVersion', 'outgoingRole', 'sourceId', 'sourceDigest', 'sourceByteLength', 'sourceCreatedSequence', 'sourceUploaderId', 'sourceUploadedAt', 'configDigest', 'offeredAt', 'expiresAt', 'contextThroughSequence'] as const
export const offerDigest = (facts: OfferFacts) => hashHandover(JSON.stringify(offerKeys.map(key => facts[key])))
export interface HandoverAuditRow {
  id: number, incident_id: number, sequence: number, actor_id: number, action: HandoverEvent['action'], target_user_id: number | null,
  at_iso: string, details_json: string, handover_key: string, handover_step: 'offer' | 'terminal', handover_assignment_version: number, request_id: string, request_digest: string,
}
function jsonDetails(row: HandoverAuditRow): Record<string, unknown> {
  if (typeof row.details_json !== 'string' || Buffer.byteLength(row.details_json, 'utf8') > 2048) handoverConflict()
  try { return JSON.parse(row.details_json) }
  catch { return handoverConflict() }
}
function validateRow(row: HandoverAuditRow) {
  handoverUuid(row.handover_key); handoverUuid(row.request_id); handoverDigest(row.request_digest)
  handoverInteger(row.incident_id, 1, Number.MAX_SAFE_INTEGER); handoverInteger(row.sequence); handoverInteger(row.actor_id, 1, Number.MAX_SAFE_INTEGER); handoverInteger(row.handover_assignment_version)
  if (!['offer', 'terminal'].includes(row.handover_step) || !['handover-offered', 'handover-accepted', 'handover-declined', 'handover-canceled'].includes(row.action) || (row.action === 'handover-offered') !== (row.handover_step === 'offer') || !validIso(row.at_iso)) handoverConflict()
}
function validIso(value: unknown): value is string { return typeof value === 'string' && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
export function parseOffer(row: HandoverAuditRow): OfferFacts {
  try {
    validateRow(row)
    const body = handoverPlain(jsonDetails(row), [...offerKeys, 'offerDigest'])
    if (row.action !== 'handover-offered' || body.profile !== handoverProfile || body.key !== row.handover_key || body.coordinatorId !== row.actor_id || body.recipientUserId !== row.target_user_id || body.contextThroughSequence !== row.sequence || body.coordinatorMembershipVersion !== row.handover_assignment_version || body.offeredAt !== row.at_iso) handoverConflict()
    handoverUuid(body.key); handoverDigest(body.sourceDigest); handoverDigest(body.configDigest); handoverDigest(body.offerDigest)
    for (const key of ['coordinatorId', 'recipientUserId', 'sourceId', 'sourceUploaderId']) handoverInteger(body[key], 1, Number.MAX_SAFE_INTEGER)
    for (const key of ['coordinatorMembershipVersion', 'recipientMembershipVersion', 'sourceCreatedSequence', 'contextThroughSequence']) handoverInteger(body[key])
    handoverInteger(body.sourceByteLength, 1, 16777216)
    handoverRole(body.recipientRole); handoverRole(body.outgoingRole)
    if (typeof body.incidentKey !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(body.incidentKey) || typeof body.incidentRevision !== 'string' || body.incidentRevision.length < 1 || body.incidentRevision.length > 64 || !validIso(body.offeredAt) || !validIso(body.expiresAt) || !validIso(body.sourceUploadedAt) || Date.parse(body.expiresAt) <= Date.parse(body.offeredAt) || body.sourceCreatedSequence as number >= (body.contextThroughSequence as number) || body.coordinatorId === body.recipientUserId) handoverConflict()
    const facts = Object.fromEntries(offerKeys.map(key => [key, body[key]])) as unknown as OfferFacts
    if (offerDigest(facts) !== body.offerDigest) handoverConflict()
    return facts
  }
  catch { return handoverConflict() }
}
export interface TerminalFacts {
  profile: typeof handoverProfile, offerDigest: string, coordinatorBefore: number, coordinatorAfter: number,
  outgoingVersionBefore: number, outgoingVersionAfter: number, recipientVersionBefore: number, recipientVersionAfter: number,
  outgoingRole: AssignableIncidentRole, acknowledged: boolean, sourceDigest: string | null, contextThroughSequence: number | null,
  newerThroughSequence: number | null, newerObservations: number | null, newerReviews: number | null,
}
const terminalKeys = ['profile', 'offerDigest', 'coordinatorBefore', 'coordinatorAfter', 'outgoingVersionBefore', 'outgoingVersionAfter', 'recipientVersionBefore', 'recipientVersionAfter', 'outgoingRole', 'acknowledged', 'sourceDigest', 'contextThroughSequence', 'newerThroughSequence', 'newerObservations', 'newerReviews']
export function eventProjection(row: HandoverAuditRow, facts: OfferFacts): HandoverEvent {
  try {
    validateRow(row)
    if (row.handover_key !== facts.key || row.handover_assignment_version !== facts.coordinatorMembershipVersion) handoverConflict()
    let acknowledgement: HandoverAcknowledgement | null = null, newerContext: HandoverNewerContext | null = null
    if (row.handover_step === 'terminal') {
      const body = handoverPlain(jsonDetails(row), terminalKeys), accepted = row.action === 'handover-accepted'
      if (body.profile !== handoverProfile || body.offerDigest !== offerDigest(facts) || row.sequence <= facts.contextThroughSequence || body.coordinatorBefore !== facts.coordinatorId || body.coordinatorAfter !== (accepted ? facts.recipientUserId : facts.coordinatorId) || body.outgoingVersionBefore !== facts.coordinatorMembershipVersion || body.recipientVersionBefore !== facts.recipientMembershipVersion || body.outgoingVersionAfter !== facts.coordinatorMembershipVersion + (accepted ? 1 : 0) || body.recipientVersionAfter !== facts.recipientMembershipVersion + (accepted ? 1 : 0) || body.outgoingRole !== facts.outgoingRole || body.acknowledged !== accepted || row.actor_id !== (row.action === 'handover-canceled' ? facts.coordinatorId : facts.recipientUserId) || row.target_user_id !== (row.action === 'handover-canceled' ? facts.recipientUserId : facts.coordinatorId)) handoverConflict()
      if (accepted) {
        if (body.sourceDigest !== facts.sourceDigest || body.contextThroughSequence !== facts.contextThroughSequence) handoverConflict()
        const through = handoverInteger(body.newerThroughSequence), observations = handoverInteger(body.newerObservations, 0), reviews = handoverInteger(body.newerReviews, 0)
        if (through < facts.contextThroughSequence || through !== row.sequence - 1 || observations + reviews > through - facts.contextThroughSequence) handoverConflict()
        acknowledgement = { offerDigest: offerDigest(facts), assignment: 'incident-coordination', sourceDigest: facts.sourceDigest, contextThroughSequence: facts.contextThroughSequence, uncertaintyAcknowledged: true }
        newerContext = { throughSequence: through, observations, reviews }
      }
      else if ([body.sourceDigest, body.contextThroughSequence, body.newerThroughSequence, body.newerObservations, body.newerReviews].some(value => value !== null)) handoverConflict()
    }
    else parseOffer(row)
    return { sequence: row.sequence, actorId: row.actor_id, action: row.action, at: row.at_iso, requestId: row.request_id, acknowledgement, newerContext }
  }
  catch { return handoverConflict() }
}
export async function findOffer(tx: HandoverReader, incidentId: number, key: string): Promise<HandoverAuditRow> {
  return asRow<HandoverAuditRow>(await tx.selectFrom(handoverTable).selectAll().where('incident_id', '=', incidentId).where('handover_key', '=', key).where('handover_step', '=', 'offer').executeTakeFirst()) ?? handoverUnavailable()
}
export async function terminalFor(tx: HandoverReader, incidentId: number, key: string): Promise<HandoverAuditRow | undefined> {
  return asRow<HandoverAuditRow>(await tx.selectFrom(handoverTable).selectAll().where('incident_id', '=', incidentId).where('handover_key', '=', key).where('handover_step', '=', 'terminal').executeTakeFirst())
}
export async function appendHandoverAudit(tx: TransactionHandle, input: Omit<HandoverAuditRow, 'id' | 'details_json'>, details: OfferFacts & { offerDigest: string } | TerminalFacts) {
  const encoded = JSON.stringify(details)
  if (Buffer.byteLength(encoded, 'utf8') > 2048) handoverConflict()
  await tx.insertInto(handoverTable).values({ ...input, details_json: encoded, created_at: input.at_iso, updated_at: input.at_iso }).execute()
  return asRow<HandoverAuditRow>(await tx.selectFrom(handoverTable).selectAll().where('incident_id', '=', input.incident_id).where('sequence', '=', input.sequence).executeTakeFirst()) ?? handoverConflict()
}
