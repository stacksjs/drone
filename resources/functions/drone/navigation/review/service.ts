import type { TransactionHandle } from '@stacksjs/orm'
import { asRow, asRows, lockRow, mutationCount } from '@stacksjs/database/runtime'
import { isUniqueViolation, transaction } from '@stacksjs/orm'
import { anchorUtcMs, canonicalVersion, isPatrolDatabaseBusy, createRequestDigest, databaseId, digests, iso, json, key, normalizeBinding, normalizeCreate, normalizeInput, PatrolReviewError, recurrenceProfile, requestId, safety, scopeDigest, normalizeDecision, normalizeConsume, transitionDigest, utcMs, version } from './contract'
import { authorizePatrol, requirePatrolPrincipal } from './policy'

interface ScheduleRow {
  id: number, owner_user_id: number, schedule_key: string, revision: number, version: number, profile: string, recurrence_profile: string, anchor_utc_ms: number, horizon_ms: number, input_json: string, binding_json: string, input_digest: string, binding_digest: string, created_at_iso: string
}
interface OccurrenceRow {
  id: number, schedule_id: number, due_utc_ms: number, scope_digest: string, state: string, decision: string | null, reviewer_id: number | null, reviewer_token_id: number | null, reviewed_at_iso: string | null, expires_at_iso: string | null, review_request_id: string | null, consumed_at_iso: string | null, consume_request_id: string | null
}
interface AuditRow {
  id: number, schedule_id: number, sequence: number, actor_id: number, token_id: number, action: string, request_id: string, request_digest: string, at_iso: string, details_json: string
}
function release<T>(value: T, maxBytes: number): T {
  json(value, maxBytes - 1)
  return value
}
function createdDetails(inputDigest: string, bindingDigest: string) {
  return { dueUtcMs: null, scopeDigest: null, inputDigest, bindingDigest, previousVersion: 0, resultVersion: 1, stateAfter: null, expiresAt: null }
}

/** Fold the complete bounded historical ledger before releasing any receipt or projection. */
async function ledger(tx: TransactionHandle, row: ScheduleRow) {
  try {
    databaseId(row.id)
    databaseId(row.owner_user_id)
    key(row.schedule_key)
    iso(row.created_at_iso)
    version(row.version)
    if (row.revision !== 1 || row.profile !== 'nominal' || row.recurrence_profile !== recurrenceProfile || row.anchor_utc_ms !== anchorUtcMs || row.horizon_ms !== 180000) throw new TypeError('Corrupt patrol metadata')
    for (const text of [row.input_json, row.binding_json]) if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024) throw new TypeError('Oversized stored patrol intent')
    const input = normalizeInput(JSON.parse(row.input_json)), binding = normalizeBinding(JSON.parse(row.binding_json))
    if (json(input, 1024) !== row.input_json || json(binding, 1024) !== row.binding_json) throw new TypeError('Noncanonical stored patrol intent')
    const hashes = digests(input, binding)
    if (row.input_digest !== hashes.inputDigest || row.binding_digest !== hashes.bindingDigest) throw new TypeError('Corrupt patrol digests')
    const occurrences = asRows<OccurrenceRow>(await tx.selectFrom('patrol_review_occurrences').selectAll().where('schedule_id', '=', row.id).orderBy('due_utc_ms', 'asc').limit(3).execute())
    const audits = asRows<AuditRow>(await tx.selectFrom('patrol_review_audits').selectAll().where('schedule_id', '=', row.id).orderBy('sequence', 'asc').limit(6).execute())
    if (occurrences.length !== input.decisions.length || audits.length !== row.version) throw new TypeError('Corrupt patrol history')
    const folded = new Map<number, OccurrenceRow>()
    for (const [index, o] of occurrences.entries()) {
      databaseId(o.id)
      if (o.schedule_id !== row.id || o.due_utc_ms !== input.decisions[index]!.dueUtcMs || o.scope_digest !== scopeDigest(row.owner_user_id, row.schedule_key, o.due_utc_ms, row.input_digest, row.binding_digest)) throw new TypeError('Corrupt patrol occurrence')
      folded.set(o.due_utc_ms, { ...o, state: 'awaiting-review', decision: null, reviewer_id: null, reviewer_token_id: null, reviewed_at_iso: null, expires_at_iso: null, review_request_id: null, consumed_at_iso: null, consume_request_id: null })
    }
    const ids = new Set<string>()
    let lastAt = row.created_at_iso
    for (const [index, audit] of audits.entries()) {
      databaseId(audit.id)
      databaseId(audit.token_id)
      requestId(audit.request_id)
      iso(audit.at_iso)
      if (audit.schedule_id !== row.id || audit.sequence !== index + 1 || audit.actor_id !== row.owner_user_id || ids.has(audit.request_id) || audit.at_iso < lastAt || typeof audit.details_json !== 'string' || Buffer.byteLength(audit.details_json, 'utf8') > 512) throw new TypeError('Corrupt patrol audit')
      ids.add(audit.request_id)
      lastAt = audit.at_iso
      const details = JSON.parse(audit.details_json)
      if (index === 0) {
        const body = { requestId: audit.request_id, scheduleKey: row.schedule_key, input, binding }
        if (audit.action !== 'created' || audit.at_iso !== row.created_at_iso || audit.details_json !== json(createdDetails(row.input_digest, row.binding_digest), 512) || audit.request_digest !== createRequestDigest(row.owner_user_id, body)) throw new TypeError('Corrupt created audit')
        continue
      }
      const o = folded.get(details.dueUtcMs)
      if (!o || !['approved', 'denied', 'consumed'].includes(audit.action)) throw new TypeError('Corrupt patrol transition')
      let expected: ReturnType<typeof createdDetails> | { dueUtcMs: number, scopeDigest: string, inputDigest: string, bindingDigest: string, previousVersion: number, resultVersion: number, stateAfter: string, expiresAt: string | null }
      expected = { dueUtcMs: o.due_utc_ms, scopeDigest: o.scope_digest, inputDigest: row.input_digest, bindingDigest: row.binding_digest, previousVersion: index, resultVersion: index + 1, stateAfter: audit.action, expiresAt: details.expiresAt }
      const core = { expectedVersion: index, requestId: audit.request_id, scopeDigest: o.scope_digest }
      if (audit.action === 'approved' || audit.action === 'denied') {
        const decision = audit.action === 'approved' ? 'approve' : 'deny'
        const expires = audit.action === 'approved' ? iso(details.expiresAt) : null
        if (o.state !== 'awaiting-review' || audit.action === 'denied' && details.expiresAt !== null || expires !== null && (expires <= audit.at_iso || Date.parse(expires) - Date.parse(audit.at_iso) > 120000)) throw new TypeError('Corrupt review history')
        if (audit.request_digest !== transitionDigest(row.owner_user_id, row.schedule_key, o.due_utc_ms, decision, { ...core, decision })) throw new TypeError('Corrupt review digest')
        Object.assign(o, { state: audit.action, decision, reviewer_id: audit.actor_id, reviewer_token_id: audit.token_id, reviewed_at_iso: audit.at_iso, expires_at_iso: expires, review_request_id: audit.request_id })
      }
      else {
        if (o.state !== 'approved' || audit.token_id !== o.reviewer_token_id || audit.at_iso < o.reviewed_at_iso! || audit.at_iso >= o.expires_at_iso! || details.expiresAt !== o.expires_at_iso || audit.request_digest !== transitionDigest(row.owner_user_id, row.schedule_key, o.due_utc_ms, 'consume', core)) throw new TypeError('Corrupt consumption history')
        Object.assign(o, { state: 'consumed', consumed_at_iso: audit.at_iso, consume_request_id: audit.request_id })
      }
      if (audit.details_json !== json(expected, 512)) throw new TypeError('Noncanonical patrol audit')
    }
    for (const o of occurrences) if (json(o, 4096) !== json(folded.get(o.due_utc_ms), 4096)) throw new TypeError('Patrol state disagrees with history')
    return { input, binding, occurrences, audits }
  }
  catch (error) {
    if (error instanceof PatrolReviewError) throw error
    if (isPatrolDatabaseBusy(error)) throw new PatrolReviewError(503)
    throw new PatrolReviewError(500)
  }
}
function receipt(row: ScheduleRow, audit: AuditRow, replayed: boolean, consumedNow = false) {
  const details = JSON.parse(audit.details_json)
  return release({ version: 1, canonicalVersion, scheduleKey: row.schedule_key, revision: 1, receipt: { requestId: audit.request_id, action: audit.action, dueUtcMs: details.dueUtcMs, scopeDigest: details.scopeDigest, at: audit.at_iso, resultVersion: audit.sequence, stateAfter: details.stateAfter }, currentVersion: row.version, replayed, consumedNow, ...safety }, 2048)
}

export async function createPatrolReviewSchedule(value: unknown) {
  const captured = await authorizePatrol('create')
  let body: ReturnType<typeof normalizeCreate>
  try { body = normalizeCreate(value) }
  catch { throw new PatrolReviewError(422) }
  try {
    return await transaction(async tx => {
      await requirePatrolPrincipal('create', captured)
      if (!await lockRow(tx, 'users', { id: captured.userId })) throw new PatrolReviewError(401)
      await requirePatrolPrincipal('create', captured)
      const existing = asRow<ScheduleRow>(await lockRow(tx, 'patrol_review_schedules', { owner_user_id: captured.userId, schedule_key: body.scheduleKey }))
      if (existing) {
        const stored = await ledger(tx, existing)
        const audit = stored.audits[0]!
        if (audit.request_id !== body.requestId || audit.request_digest !== createRequestDigest(captured.userId, body)) throw new PatrolReviewError(409)
        if (audit.token_id !== captured.tokenId || audit.actor_id !== captured.userId) throw new PatrolReviewError(403)
        return receipt(existing, audit, true)
      }
      const owned = asRows(await tx.selectFrom('patrol_review_schedules').select('id').where('owner_user_id', '=', captured.userId).limit(17).execute())
      if (owned.length >= 16) throw new PatrolReviewError(409)
      await requirePatrolPrincipal('create', captured)
      const at = iso(new Date(Date.now()).toISOString()), hashes = digests(body.input, body.binding)
      await tx.insertInto('patrol_review_schedules').values({ owner_user_id: captured.userId, schedule_key: body.scheduleKey, revision: 1, version: 1, profile: 'nominal', recurrence_profile: recurrenceProfile, anchor_utc_ms: anchorUtcMs, horizon_ms: 180000, input_json: json(body.input, 1024), binding_json: json(body.binding, 1024), input_digest: hashes.inputDigest, binding_digest: hashes.bindingDigest, created_at_iso: at }).execute()
      const row = asRow<ScheduleRow>(await tx.selectFrom('patrol_review_schedules').selectAll().where('owner_user_id', '=', captured.userId).where('schedule_key', '=', body.scheduleKey).executeTakeFirst())
      if (!row) throw new PatrolReviewError(500)
      for (const decision of body.input.decisions) await tx.insertInto('patrol_review_occurrences').values({ schedule_id: row.id, due_utc_ms: decision.dueUtcMs, scope_digest: scopeDigest(captured.userId, body.scheduleKey, decision.dueUtcMs, hashes.inputDigest, hashes.bindingDigest), state: 'awaiting-review', decision: null, reviewer_id: null, reviewer_token_id: null, reviewed_at_iso: null, expires_at_iso: null, review_request_id: null, consumed_at_iso: null, consume_request_id: null }).execute()
      await tx.insertInto('patrol_review_audits').values({ schedule_id: row.id, sequence: 1, actor_id: captured.userId, token_id: captured.tokenId, action: 'created', request_id: body.requestId, request_digest: createRequestDigest(captured.userId, body), at_iso: at, details_json: json(createdDetails(hashes.inputDigest, hashes.bindingDigest), 512) }).execute()
      const stored = await ledger(tx, row)
      return receipt(row, stored.audits[0]!, false)
    }, { retries: 0 })
  }
  catch (error) {
    if (isUniqueViolation(error)) throw new PatrolReviewError(409)
    throw error
  }
}

export async function readPatrolReviewSchedule(value: string) {
  const captured = await authorizePatrol('read')
  let scheduleKey: string
  try { scheduleKey = key(value) }
  catch { throw new PatrolReviewError(422) }
  return transaction(async tx => {
    await requirePatrolPrincipal('read', captured)
    const row = asRow<ScheduleRow>(await tx.selectFrom('patrol_review_schedules').selectAll().where('owner_user_id', '=', captured.userId).where('schedule_key', '=', scheduleKey).executeTakeFirst())
    if (!row) throw new PatrolReviewError(404)
    const stored = await ledger(tx, row)
    return release({ version: 1, canonicalVersion, ownerUserId: row.owner_user_id, scheduleKey: row.schedule_key, revision: 1, scheduleVersion: row.version, createdAt: row.created_at_iso, profile: 'nominal', recurrenceProfile, anchorUtcMs, horizonMs: 180000, inputDigest: row.input_digest, bindingDigest: row.binding_digest, input: stored.input, binding: stored.binding, occurrences: stored.occurrences.map(o => ({ dueUtcMs: o.due_utc_ms, scopeDigest: o.scope_digest, state: o.state, decision: o.decision, reviewerUserId: o.reviewer_id, reviewedAt: o.reviewed_at_iso, expiresAt: o.expires_at_iso, reviewRequestId: o.review_request_id, consumedAt: o.consumed_at_iso, consumeRequestId: o.consume_request_id })), audit: stored.audits.map(a => ({ sequence: a.sequence, action: a.action, actorUserId: a.actor_id, requestId: a.request_id, requestDigest: a.request_digest, at: a.at_iso, details: JSON.parse(a.details_json) })), ...safety }, 16384)
  }, { retries: 0 })
}

async function mutateReview(schedule: string, dueValue: number, value: unknown, consuming: boolean) {
  const entry = await authorizePatrol(consuming ? 'consume' : 'review')
  let scheduleKey: string, due: number, body: ReturnType<typeof normalizeDecision> | ReturnType<typeof normalizeConsume>
  let decision: 'approve' | 'deny' | null = null
  try {
    scheduleKey = key(schedule)
    due = utcMs(dueValue)
    if (consuming) body = normalizeConsume(value)
    else {
      const normalized = normalizeDecision(value)
      body = normalized
      decision = normalized.decision
    }
  }
  catch { throw new PatrolReviewError(422) }
  const operation = consuming ? 'consume' : decision === 'approve' ? 'approve' : 'review'
  const captured = await authorizePatrol(operation, entry)
  try {
    return await transaction(async tx => {
      const row = asRow<ScheduleRow>(await lockRow(tx, 'patrol_review_schedules', { owner_user_id: captured.userId, schedule_key: scheduleKey }))
      await requirePatrolPrincipal(operation, captured)
      if (!row) throw new PatrolReviewError(404)
      const stored = await ledger(tx, row), requestDigest = transitionDigest(captured.userId, scheduleKey, due, consuming ? 'consume' : decision!, body)
      const committed = stored.audits.find(a => a.request_id === body.requestId)
      if (committed) {
        if (committed.request_digest !== requestDigest) throw new PatrolReviewError(409)
        if (committed.token_id !== captured.tokenId || committed.actor_id !== captured.userId) throw new PatrolReviewError(403)
        return receipt(row, committed, true)
      }
      const o = stored.occurrences.find(o => o.due_utc_ms === due)
      if (!o) throw new PatrolReviewError(404)
      const current = await requirePatrolPrincipal(operation, captured)
      let now: number
      try { now = utcMs(Date.now()) }
      catch { throw new PatrolReviewError(409) }
      const at = iso(new Date(now).toISOString())
      if (row.version !== body.expectedVersion || row.version >= 5 || o.scope_digest !== body.scopeDigest || at < stored.audits.at(-1)!.at_iso) throw new PatrolReviewError(409)
      if (consuming) {
        if (o.reviewer_token_id !== captured.tokenId && o.state === 'approved') throw new PatrolReviewError(403)
        if (o.state !== 'approved' || at < o.reviewed_at_iso! || at >= o.expires_at_iso!) throw new PatrolReviewError(409)
      }
      else if (o.state !== 'awaiting-review') throw new PatrolReviewError(409)
      const expiryMs = Math.min(now + 120000, current.tokenDeadline ?? now + 120000)
      if (!consuming && decision === 'approve' && (!Number.isSafeInteger(expiryMs) || expiryMs > 253402300799999 || expiryMs <= now)) throw new PatrolReviewError(409)
      const expiresAt = consuming ? o.expires_at_iso : decision === 'approve' ? iso(new Date(expiryMs).toISOString()) : null
      if (!consuming && expiresAt !== null && expiresAt <= at) throw new PatrolReviewError(409)
      const state = consuming ? 'consumed' : decision === 'approve' ? 'approved' : 'denied'
      if (mutationCount(await tx.updateTable('patrol_review_schedules').set({ version: row.version + 1 }).where('id', '=', row.id).where('version', '=', row.version).executeTakeFirst()) !== 1) throw new PatrolReviewError(409)
      const changes = consuming ? { state, consumed_at_iso: at, consume_request_id: body.requestId } : { state, decision, reviewer_id: captured.userId, reviewer_token_id: captured.tokenId, reviewed_at_iso: at, expires_at_iso: expiresAt, review_request_id: body.requestId }
      if (mutationCount(await tx.updateTable('patrol_review_occurrences').set(changes).where('id', '=', o.id).where('state', '=', consuming ? 'approved' : 'awaiting-review').executeTakeFirst()) !== 1) throw new PatrolReviewError(409)
      const details = { dueUtcMs: due, scopeDigest: o.scope_digest, inputDigest: row.input_digest, bindingDigest: row.binding_digest, previousVersion: row.version, resultVersion: row.version + 1, stateAfter: state, expiresAt }
      await tx.insertInto('patrol_review_audits').values({ schedule_id: row.id, sequence: row.version + 1, actor_id: captured.userId, token_id: captured.tokenId, action: state, request_id: body.requestId, request_digest: requestDigest, at_iso: at, details_json: json(details, 512) }).execute()
      const next = { ...row, version: row.version + 1 }, checked = await ledger(tx, next)
      return receipt(next, checked.audits.at(-1)!, false, consuming)
    }, { retries: 0 })
  }
  catch (error) {
    if (isUniqueViolation(error)) throw new PatrolReviewError(409)
    throw error
  }
}
export function decidePatrolReview(schedule: string, due: number, value: unknown) {
  return mutateReview(schedule, due, value, false)
}
export function consumePatrolReview(schedule: string, due: number, value: unknown) {
  return mutateReview(schedule, due, value, true)
}
