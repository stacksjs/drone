import type { IncidentRow } from './policy'
import type { SourceRow } from './records'
import type { ObservationProjection, ReviewProjection, SourceProjection } from './record-types'
import type { HandoverBriefing, HandoverNewerContext } from './handover-types'
import type { HandoverReader } from './handover-policy'
import type { OfferFacts } from './handover-ledger'
import { asRow, asRows } from '@stacksjs/database/runtime'
import { matchConfig, verifyStoredSource } from './records'
import { handoverConflict, handoverInteger, handoverUnavailable, offerDigest } from './handover-ledger'

const flags = { sourceIdentityAuthenticated: false, physicalFlightEnabled: false, physicalThermalVerified: false } as const
export const handoverSourceFields = ['id', 'incident_id', 'digest', 'byte_length', 'canonical_json', 'replay_profile', 'evidence', 'uploader_id', 'uploaded_at_iso', 'created_sequence']
export async function stageHandoverSource(tx: HandoverReader, incident: IncidentRow, digest: string) {
  const row = asRow<SourceRow>(await tx.selectFrom('public_safety_sources').select(handoverSourceFields).where('incident_id', '=', incident.id).where('digest', '=', digest).executeTakeFirst()) ?? handoverUnavailable()
  const run = verifyStoredSource(row)
  matchConfig(run, incident)
  return { row, run }
}
export async function unchangedHandoverSource(tx: HandoverReader, incident: IncidentRow, staged: Awaited<ReturnType<typeof stageHandoverSource>>): Promise<SourceRow> {
  const current = asRow<SourceRow>(await tx.selectFrom('public_safety_sources').select(handoverSourceFields).where('incident_id', '=', incident.id).where('id', '=', staged.row.id).executeTakeFirst())
  if (!current || JSON.stringify(current) !== JSON.stringify(staged.row)) handoverConflict()
  matchConfig(staged.run, incident)
  return current
}
export async function verifiedHandoverSource(tx: HandoverReader, incident: IncidentRow, digest: string): Promise<SourceRow> {
  return unchangedHandoverSource(tx, incident, await stageHandoverSource(tx, incident, digest))
}
export function offeredSource(facts: OfferFacts): SourceProjection {
  return { id: facts.sourceId, digest: facts.sourceDigest, byteLength: facts.sourceByteLength, replayProfile: 'owned-public-safety-collection-v1', evidence: 'owned-public-safety-physics-simulation', uploaderId: facts.sourceUploaderId, uploadedAt: facts.sourceUploadedAt, createdSequence: facts.sourceCreatedSequence, uploaderAuthenticated: true, ...flags }
}
interface ContextObservation {
  id: number, capture_id: string, modality: 'visible' | 'thermal', pixel_x: number, pixel_y: number, note: string, uncertainty_note: string, actor_id: number, observed_at_iso: string, created_sequence: number,
}
interface ContextReview {
  id: number, observation_id: number, previous_review_id: number | null, disposition: ReviewProjection['disposition'], note: string, actor_id: number, reviewed_at_iso: string, created_sequence: number, uncertainty_note: string, observation_actor_id: number,
}
type SourceContext = Pick<OfferFacts, 'sourceId' | 'sourceDigest' | 'contextThroughSequence'>
export async function newerHandoverContext(tx: HandoverReader, incident: IncidentRow, facts: SourceContext): Promise<HandoverNewerContext> {
  const observations = await tx.selectFrom('public_safety_observations').where('source_id', '=', facts.sourceId).where('created_sequence', '>', facts.contextThroughSequence).where('created_sequence', '<=', incident.version).count()
  const reviews = await tx.selectFrom('public_safety_reviews').innerJoin('public_safety_observations', 'public_safety_observations.id', '=', 'public_safety_reviews.observation_id').where('public_safety_observations.source_id', '=', facts.sourceId).where('public_safety_reviews.created_sequence', '>', facts.contextThroughSequence).where('public_safety_reviews.created_sequence', '<=', incident.version).count()
  return { throughSequence: incident.version, observations: handoverInteger(observations, 0), reviews: handoverInteger(reviews, 0) }
}
/** Internal shared selected-source projector, with one immutable cutoff and current newer counts. */
export async function projectIncidentSourceContext(tx: HandoverReader, incident: IncidentRow, facts: SourceContext, after: number, limit: number) {
  const observations = asRows<ContextObservation>(await tx.selectFrom('public_safety_observations').select(['id', 'capture_id', 'modality', 'pixel_x', 'pixel_y', 'note', 'uncertainty_note', 'actor_id', 'observed_at_iso', 'created_sequence']).where('source_id', '=', facts.sourceId).where('created_sequence', '>', after).where('created_sequence', '<=', facts.contextThroughSequence).orderBy('created_sequence', 'asc').limit(limit + 1).execute())
  const reviews = asRows<ContextReview>(await tx.selectFrom('public_safety_reviews').innerJoin('public_safety_observations', 'public_safety_observations.id', '=', 'public_safety_reviews.observation_id').select(['public_safety_reviews.id', 'public_safety_reviews.observation_id', 'public_safety_reviews.previous_review_id', 'public_safety_reviews.disposition', 'public_safety_reviews.note', 'public_safety_reviews.actor_id', 'public_safety_reviews.reviewed_at_iso', 'public_safety_reviews.created_sequence', 'public_safety_observations.uncertainty_note', 'public_safety_observations.actor_id as observation_actor_id']).where('public_safety_observations.source_id', '=', facts.sourceId).where('public_safety_reviews.created_sequence', '>', after).where('public_safety_reviews.created_sequence', '<=', facts.contextThroughSequence).orderBy('public_safety_reviews.created_sequence', 'asc').limit(limit + 1).execute())
  const entries: Array<ObservationProjection | ReviewProjection> = [
    ...observations.map(row => ({ id: row.id, sourceDigest: facts.sourceDigest, captureId: row.capture_id, modality: row.modality, pixel: { x: row.pixel_x, y: row.pixel_y }, note: row.note, uncertaintyNote: row.uncertainty_note, actorId: row.actor_id, observedAt: row.observed_at_iso, createdSequence: row.created_sequence, ...flags })),
    ...reviews.map(row => ({ id: row.id, observationId: row.observation_id, sourceDigest: facts.sourceDigest, previousReviewId: row.previous_review_id, disposition: row.disposition, note: row.note, uncertaintyNote: row.uncertainty_note, actorId: row.actor_id, reviewedAt: row.reviewed_at_iso, createdSequence: row.created_sequence, selfReview: row.actor_id === row.observation_actor_id, ...flags })),
  ].sort((a, b) => a.createdSequence - b.createdSequence)
  const page = entries.slice(0, limit)
  return { contextThroughSequence: facts.contextThroughSequence, entries: page, cursor: page.at(-1)?.createdSequence ?? after, hasMore: entries.length > limit, newerContext: await newerHandoverContext(tx, incident, facts) }
}
export async function handoverBriefing(tx: HandoverReader, incident: IncidentRow, facts: OfferFacts, after: number, limit: number): Promise<HandoverBriefing> {
  return { ...await projectIncidentSourceContext(tx, incident, facts, after, limit), source: offeredSource(facts), acknowledgementRequired: { offerDigest: offerDigest(facts), assignment: 'incident-coordination', sourceDigest: facts.sourceDigest, contextThroughSequence: facts.contextThroughSequence, uncertaintyAcknowledged: true }, ...flags }
}
