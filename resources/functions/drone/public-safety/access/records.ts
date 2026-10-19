import type { TransactionHandle } from '@stacksjs/orm'
import type { PublicSafetyRun } from '../runtime-types'
import type { IncidentRow } from './policy'
import type { RecordPageOptions, RecordPage, RecordingData, SourceProjection, SourceRead, SourceRegistration, ObservationProjection, ObservationAppend, ObservationModality, ReviewProjection, ReviewAppend, ReviewDisposition } from './record-types'
import { createHash } from 'node:crypto'
import { asRow, asRows, db } from '@stacksjs/database/runtime'
import { transaction } from '@stacksjs/orm'
import { publicSafetyRecordingData, publicSafetyEvidenceLimits, validatePublicSafetyRun } from '../evidence'
import { PublicSafetyAccessError } from './errors'
import { authorizePublicSafetyIncident } from './service'
import { requireIncidentAccess } from './policy'
import { exactRecord, expectedVersion, projection, mutation, advance, audit, pagination } from './mutations'
import { reviewDispositions } from './record-types'

interface SourceRow {
  id: number, incident_id: number, digest: string, byte_length: number, canonical_json: string,
  replay_profile: SourceProjection['replayProfile'], evidence: SourceProjection['evidence'], uploader_id: number, uploaded_at_iso: string, created_sequence: number,
}
interface ObservationRow {
  id: number, source_id: number, capture_id: string, modality: ObservationModality, pixel_x: number, pixel_y: number,
  note: string, uncertainty_note: string, actor_id: number, observed_at_iso: string, created_sequence: number, source_digest: string,
}
interface ReviewRow { id: number, observation_id: number, previous_review_id: number | null, disposition: ReviewDisposition, note: string, actor_id: number, reviewed_at_iso: string, created_sequence: number }
type Reader = Pick<TransactionHandle, 'selectFrom'>
const sourceFields = ['id', 'incident_id', 'digest', 'byte_length', 'canonical_json', 'replay_profile', 'evidence', 'uploader_id', 'uploaded_at_iso', 'created_sequence']
const observationFields = ['id', 'source_id', 'capture_id', 'modality', 'pixel_x', 'pixel_y', 'note', 'uncertainty_note', 'actor_id', 'observed_at_iso', 'created_sequence']
const flags = { sourceIdentityAuthenticated: false, physicalFlightEnabled: false, physicalThermalVerified: false } as const
const digestOf = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const bytes = (text: string) => new TextEncoder().encode(text).length
function unavailable(): never { throw new PublicSafetyAccessError(404, 'Incident record is unavailable') }
function inconsistent(): never { throw new PublicSafetyAccessError(409, 'Stored incident source is unavailable') }
function digest(value: unknown): asserts value is string { if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) throw new PublicSafetyAccessError(422, 'Invalid source digest') }
function rowId(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new PublicSafetyAccessError(422, 'Invalid incident record identifier')
}
function privateNote(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > maximum) throw new PublicSafetyAccessError(422, 'Invalid incident declaration')
  return value
}
function sourceProjection(row: SourceRow): SourceProjection {
  if (row.replay_profile !== 'owned-public-safety-collection-v1' || row.evidence !== 'owned-public-safety-physics-simulation') inconsistent()
  return { id: row.id, digest: row.digest, byteLength: row.byte_length, replayProfile: row.replay_profile, evidence: row.evidence, uploaderId: row.uploader_id, uploadedAt: row.uploaded_at_iso, createdSequence: row.created_sequence, uploaderAuthenticated: true, ...flags }
}
function observationProjection(row: ObservationRow): ObservationProjection {
  return { id: row.id, sourceDigest: row.source_digest, captureId: row.capture_id, modality: row.modality, pixel: { x: row.pixel_x, y: row.pixel_y }, note: row.note, uncertaintyNote: row.uncertainty_note, actorId: row.actor_id, observedAt: row.observed_at_iso, createdSequence: row.created_sequence, ...flags }
}
function reviewProjection(row: ReviewRow, observation: ObservationRow): ReviewProjection {
  return { id: row.id, observationId: row.observation_id, sourceDigest: observation.source_digest, previousReviewId: row.previous_review_id, disposition: row.disposition, note: row.note, uncertaintyNote: observation.uncertainty_note, actorId: row.actor_id, reviewedAt: row.reviewed_at_iso, createdSequence: row.created_sequence, selfReview: row.actor_id === observation.actor_id, ...flags }
}
function page<T extends { createdSequence: number }>(rows: T[], after: number, limit: number): RecordPage<T> {
  const entries = rows.slice(0, limit)
  return { entries, cursor: entries.at(-1)?.createdSequence ?? after, hasMore: rows.length > limit }
}
async function scopedSource(handle: Reader, key: string, hash: string): Promise<SourceRow> {
  const row = asRow<SourceRow>(await handle.selectFrom('public_safety_sources').innerJoin('public_safety_incidents', 'public_safety_incidents.id', '=', 'public_safety_sources.incident_id').select(sourceFields.map(field => `public_safety_sources.${field}`)).where('public_safety_incidents.incident_key', '=', key).where('public_safety_sources.digest', '=', hash).executeTakeFirst())
  return row ?? unavailable()
}
async function scopedObservation(handle: Reader, key: string, id: number): Promise<ObservationRow> {
  const row = asRow<ObservationRow>(await handle.selectFrom('public_safety_observations').innerJoin('public_safety_sources', 'public_safety_sources.id', '=', 'public_safety_observations.source_id').innerJoin('public_safety_incidents', 'public_safety_incidents.id', '=', 'public_safety_sources.incident_id').select([...observationFields.map(field => `public_safety_observations.${field}`), 'public_safety_sources.digest as source_digest']).where('public_safety_incidents.incident_key', '=', key).where('public_safety_observations.id', '=', id).executeTakeFirst())
  return row ?? unavailable()
}
function verifyStoredSource(row: SourceRow): PublicSafetyRun {
  sourceProjection(row)
  if (typeof row.canonical_json !== 'string' || row.canonical_json.length > publicSafetyEvidenceLimits.recordingBytes || bytes(row.canonical_json) !== row.byte_length || digestOf(row.canonical_json) !== row.digest) inconsistent()
  try {
    const run = validatePublicSafetyRun(JSON.parse(row.canonical_json))
    if (publicSafetyRecordingData(run) !== row.canonical_json) inconsistent()
    return run
  }
  catch { return inconsistent() }
}
function matchConfig(run: PublicSafetyRun, incident: IncidentRow, incoming = false): void {
  const config = run.plan.config
  if (publicSafetyRecordingData(config) !== incident.config_json) {
    if (incoming) throw new PublicSafetyAccessError(422, 'Source does not match this incident scope')
    inconsistent()
  }
  if (config.id !== incident.incident_key || config.revision !== incident.revision || config.purpose !== incident.purpose || config.retention.expiresAt !== incident.retain_until) inconsistent()
}
async function recordReadAccess(key: string, tx: TransactionHandle) {
  const access = await requireIncidentAccess(key, 'view', tx)
  projection(access.incident, access.member)
  return access
}
async function unchangedSource(tx: TransactionHandle, key: string, staged: SourceRow, run: PublicSafetyRun, incident: IncidentRow): Promise<void> {
  const current = await scopedSource(tx, key, staged.digest)
  if (JSON.stringify(current) !== JSON.stringify(staged)) inconsistent()
  matchConfig(run, incident)
}

export async function registerPublicSafetySource(key: string, input: unknown): Promise<SourceRegistration> {
  const body = exactRecord(input, ['expectedVersion', 'recording']), expected = expectedVersion(body.expectedVersion)
  await authorizePublicSafetyIncident(key, 'source-register')
  let run: PublicSafetyRun, canonical: string
  try { run = validatePublicSafetyRun(body.recording); canonical = publicSafetyRecordingData(run) }
  catch { throw new PublicSafetyAccessError(422, 'Invalid owned incident recording') }
  const hash = digestOf(canonical), byteLength = bytes(canonical)
  return mutation(key, 'source-register', expected, async (tx, access) => {
    matchConfig(run, access.incident, true)
    if (await tx.selectFrom('public_safety_sources').select('id').where('incident_id', '=', access.incident.id).where('digest', '=', hash).executeTakeFirst()) throw new PublicSafetyAccessError(409, 'Incident source already exists')
    const incident = await advance(tx, access.incident), at = new Date().toISOString()
    await tx.insertInto('public_safety_sources').values({ incident_id: incident.id, digest: hash, byte_length: byteLength, canonical_json: canonical, replay_profile: run.replayProfile, evidence: run.evidence, uploader_id: access.principal.userId, uploaded_at_iso: at, created_sequence: incident.version, created_at: at, updated_at: at }).execute()
    const source = await scopedSource(tx, key, hash)
    await audit(tx, incident, access.principal.userId, 'source-registered', null, { sourceId: source.id, sourceDigest: hash })
    return { incident: projection(incident, access.member), source: sourceProjection(source) }
  })
}
export async function readPublicSafetySource(key: string, hash: string): Promise<SourceRead> {
  digest(hash)
  await authorizePublicSafetyIncident(key, 'view')
  const { row, incident } = await transaction(async tx => {
    const { incident } = await recordReadAccess(key, tx)
    return { row: await scopedSource(tx, key, hash), incident }
  })
  const run = verifyStoredSource(row)
  matchConfig(run, incident)
  return { source: sourceProjection(row), recording: JSON.parse(row.canonical_json) as RecordingData }
}
export async function listPublicSafetySources(key: string, options: RecordPageOptions = {}): Promise<RecordPage<SourceProjection>> {
  const { after, limit } = pagination(options)
  await authorizePublicSafetyIncident(key, 'view')
  return transaction(async tx => {
    const { incident } = await recordReadAccess(key, tx)
    // Metadata only: neither load nor serialize canonical source planes for a catalog.
    const fields = sourceFields.filter(field => field !== 'canonical_json')
    const rows = asRows<SourceRow>(await tx.selectFrom('public_safety_sources').select(fields).where('incident_id', '=', incident.id).where('created_sequence', '>', after).orderBy('created_sequence', 'asc').limit(limit + 1).execute())
    return page(rows.map(sourceProjection), after, limit)
  })
}
export async function appendPublicSafetyObservation(key: string, input: unknown): Promise<ObservationAppend> {
  const body = exactRecord(input, ['expectedVersion', 'sourceDigest', 'captureId', 'modality', 'pixel', 'note', 'uncertaintyNote']), expected = expectedVersion(body.expectedVersion)
  digest(body.sourceDigest)
  const hash = body.sourceDigest
  if (typeof body.captureId !== 'string' || body.captureId.match(/^[a-z][a-z0-9-]{0,63}$/)?.[0] !== body.captureId || body.modality !== 'visible' && body.modality !== 'thermal') throw new PublicSafetyAccessError(422, 'Invalid source capture or modality')
  const captureId = body.captureId, modality = body.modality
  const pixel = exactRecord(body.pixel, ['x', 'y'])
  if (!Number.isSafeInteger(pixel.x) || (pixel.x as number) < 0 || !Number.isSafeInteger(pixel.y) || (pixel.y as number) < 0) throw new PublicSafetyAccessError(422, 'Invalid source pixel')
  const x = pixel.x as number, y = pixel.y as number, note = privateNote(body.note, 2048), uncertaintyNote = privateNote(body.uncertaintyNote, 1024)
  await authorizePublicSafetyIncident(key, 'observation-create')
  const staged = await scopedSource(db.primary, key, hash), run = verifyStoredSource(staged)
  const index = run.survey.captures.findIndex(capture => capture.id === captureId)
  const visible = run.survey.captures[index], thermal = run.captures[index]
  if (!visible || !thermal || x >= visible.width || y >= visible.height || thermal.width !== visible.width || thermal.height !== visible.height || thermal.support.length !== visible.width * visible.height || thermal.thermalCentiKelvin.length !== thermal.support.length || thermal.support[y * visible.width + x] !== 1 || modality === 'thermal' && !thermal.thermalCentiKelvin[y * visible.width + x]) throw new PublicSafetyAccessError(422, 'Pixel is not available in a confirmed source capture')
  return mutation(key, 'observation-create', expected, async (tx, access) => {
    await unchangedSource(tx, key, staged, run, access.incident)
    const incident = await advance(tx, access.incident), at = new Date().toISOString()
    await tx.insertInto('public_safety_observations').values({ source_id: staged.id, capture_id: captureId, modality, pixel_x: x, pixel_y: y, note, uncertainty_note: uncertaintyNote, actor_id: access.principal.userId, observed_at_iso: at, created_sequence: incident.version, created_at: at, updated_at: at }).execute()
    const row = asRow<{ id: number }>(await tx.selectFrom('public_safety_observations').select('id').where('source_id', '=', staged.id).where('created_sequence', '=', incident.version).executeTakeFirst())!
    const observation = await scopedObservation(tx, key, row.id)
    await audit(tx, incident, access.principal.userId, 'observation-created', null, { sourceDigest: hash, observationId: row.id, captureId, modality })
    return { incident: projection(incident, access.member), observation: observationProjection(observation) }
  })
}
export async function readPublicSafetyObservation(key: string, id: number): Promise<ObservationProjection> {
  rowId(id)
  await authorizePublicSafetyIncident(key, 'view')
  return transaction(async tx => {
    await recordReadAccess(key, tx)
    return observationProjection(await scopedObservation(tx, key, id))
  })
}
export async function listPublicSafetyObservations(key: string, options: RecordPageOptions = {}): Promise<RecordPage<ObservationProjection>> {
  const { after, limit } = pagination(options)
  await authorizePublicSafetyIncident(key, 'view')
  return transaction(async tx => {
    const { incident } = await recordReadAccess(key, tx)
    const rows = asRows<ObservationRow>(await tx.selectFrom('public_safety_observations').innerJoin('public_safety_sources', 'public_safety_sources.id', '=', 'public_safety_observations.source_id').select([...observationFields.map(field => `public_safety_observations.${field}`), 'public_safety_sources.digest as source_digest']).where('public_safety_sources.incident_id', '=', incident.id).where('public_safety_observations.created_sequence', '>', after).orderBy('public_safety_observations.created_sequence', 'asc').limit(limit + 1).execute())
    return page(rows.map(observationProjection), after, limit)
  })
}
export async function appendPublicSafetyReview(key: string, observationId: number, input: unknown): Promise<ReviewAppend> {
  rowId(observationId)
  const body = exactRecord(input, ['expectedVersion', 'sourceDigest', 'previousReviewId', 'disposition', 'note']), expected = expectedVersion(body.expectedVersion)
  digest(body.sourceDigest)
  if (body.previousReviewId !== null) rowId(body.previousReviewId)
  if (!reviewDispositions.includes(body.disposition as ReviewDisposition)) throw new PublicSafetyAccessError(422, 'Invalid review disposition')
  const hash = body.sourceDigest, previousId = body.previousReviewId as number | null, disposition = body.disposition as ReviewDisposition, note = privateNote(body.note, 2048)
  await authorizePublicSafetyIncident(key, 'review-append')
  const stagedObservation = await scopedObservation(db.primary, key, observationId)
  if (stagedObservation.source_digest !== hash) unavailable()
  const stagedSource = await scopedSource(db.primary, key, hash), run = verifyStoredSource(stagedSource)
  return mutation(key, 'review-append', expected, async (tx, access) => {
    await unchangedSource(tx, key, stagedSource, run, access.incident)
    const observation = await scopedObservation(tx, key, observationId)
    if (JSON.stringify(observation) !== JSON.stringify(stagedObservation)) inconsistent()
    if (previousId !== null && !await tx.selectFrom('public_safety_reviews').select('id').where('id', '=', previousId).where('observation_id', '=', observation.id).executeTakeFirst()) unavailable()
    const last = asRow<ReviewRow>(await tx.selectFrom('public_safety_reviews').selectAll().where('observation_id', '=', observation.id).orderBy('created_sequence', 'desc').limit(1).executeTakeFirst())
    if ((last?.id ?? null) !== previousId) throw new PublicSafetyAccessError(409, 'The latest incident review has changed')
    const incident = await advance(tx, access.incident), at = new Date().toISOString()
    await tx.insertInto('public_safety_reviews').values({ observation_id: observation.id, previous_review_id: previousId, disposition, note, actor_id: access.principal.userId, reviewed_at_iso: at, created_sequence: incident.version, created_at: at, updated_at: at }).execute()
    const review = asRow<ReviewRow>(await tx.selectFrom('public_safety_reviews').selectAll().where('observation_id', '=', observation.id).where('created_sequence', '=', incident.version).executeTakeFirst())!
    await audit(tx, incident, access.principal.userId, 'review-appended', null, { sourceDigest: hash, observationId, reviewId: review.id, disposition })
    return { incident: projection(incident, access.member), review: reviewProjection(review, observation) }
  })
}
export async function listPublicSafetyReviews(key: string, observationId: number, options: RecordPageOptions = {}): Promise<RecordPage<ReviewProjection>> {
  rowId(observationId)
  const { after, limit } = pagination(options)
  await authorizePublicSafetyIncident(key, 'view')
  return transaction(async tx => {
    await recordReadAccess(key, tx)
    const observation = await scopedObservation(tx, key, observationId)
    const rows = asRows<ReviewRow>(await tx.selectFrom('public_safety_reviews').selectAll().where('observation_id', '=', observation.id).where('created_sequence', '>', after).orderBy('created_sequence', 'asc').limit(limit + 1).execute())
    return page(rows.map(row => reviewProjection(row, observation)), after, limit)
  })
}
