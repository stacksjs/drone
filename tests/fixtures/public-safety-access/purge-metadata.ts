import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, root, retention, records, managed, access, status } from './managed-context'
import type { PurgeStatus } from '../../../resources/functions/drone/public-safety/purge/types'
import { purgeAbilities, purgeCoverage, purgeExclusions, purgePolicy } from '../../../resources/functions/drone/public-safety/purge/types'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { inspectTemporaryWorkspace } from '../../../resources/functions/artifacts/native-storage/temporary-workspaces'
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
const { Gate } = await import('@stacksjs/auth/gate')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const requirePositive = process.argv.includes('--require-positive')
const coordinator = await actor('metadata-coordinator'), custodian = await actor('metadata-custodian')
const Incident = (await import(join(root, 'app/Models/PublicSafetyIncident.ts'))).default
const Purge = (await import(join(root, 'app/Models/PublicSafetyPurge.ts'))).default
async function integrity() {
  const foreign = await database.db.primary.unsafe('PRAGMA foreign_keys').execute()
  assert.deepEqual(foreign, [{ foreign_keys: 1 }])
  assert.deepEqual(await database.db.primary.unsafe('PRAGMA foreign_key_check').execute(), [])
  assert.deepEqual(await database.db.primary.unsafe('PRAGMA integrity_check').execute(), [{ integrity_check: 'ok' }])
}
async function waitDue(iso: string) { const delay = Date.parse(iso) - Date.now() + 10; if (delay > 0) await Bun.sleep(delay) }
async function accept(key: string, days = 1) {
  const preview = await purge.previewPublicSafetyPurge(key)
  assert.equal(preview.reason, 'eligible')
  const body = { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, inventoryDigest: preview.inventoryDigest, policyVersion: purgePolicy, coverage: purgeCoverage, exclusions: purgeExclusions, receiptRetentionDays: days, requestId: randomUUID() }
  return { body, receipt: await purge.acceptPublicSafetyPurge(key, body) }
}
async function progress(key: string, purgeKey: string) {
  let current = await purge.readPublicSafetyPurge(key, purgeKey)
  for (let index = 0; index < 80 && current.state !== 'complete' && current.state !== 'blocked'; index++) {
    await job.dispatchNow({ purgeKey })
    current = await purge.readPublicSafetyPurge(key, purgeKey)
    if (process.env.PUBLIC_SAFETY_PURGE_ENABLED === 'false') break
  }
  return current
}
try {
  await as(coordinator.token.plainTextToken, async () => {
    const key = 'purge-metadata-complete', blockedKey = 'purge-metadata-blocked'
    const setup = await seed(key, 20000)
    await access.changePublicSafetyMembership(key, { expectedVersion: 3, userId: custodian.user.id, role: 'evidence-custodian' })
    const capture = setup.run.survey.captures[0]!, pixel = setup.run.captures[0]!.support.findIndex(value => value === 1)
    assert(pixel >= 0)
    const note = 'metadata-private-observation-fragment', reviewNote = 'metadata-private-review-fragment'
    const observation = await records.appendPublicSafetyObservation(key, { expectedVersion: 4, sourceDigest: setup.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: pixel % capture.width, y: Math.floor(pixel / capture.width) }, note, uncertaintyNote: 'metadata-private-uncertainty-fragment' })
    const review = await records.appendPublicSafetyReview(key, observation.observation.id, { expectedVersion: 5, sourceDigest: setup.source.digest, previousReviewId: null, disposition: 'unresolved', note: reviewNote })
    const created = await managed.createPublicSafetyManagedDataset(key, { ...setup.body, expectedVersion: 6 })
    const tree = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key)
    const blockedSetup = await seed(blockedKey, Math.max(5000, Date.parse(setup.config.retention.expiresAt) - Date.now()))
    const blockedArtifact = await managed.createPublicSafetyManagedDataset(blockedKey, blockedSetup.body)
    const blockedTree = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, blockedArtifact.artifact.key)
    writeFileSync(join(blockedTree, 'unknown-sentinel.txt'), 'unknown-owned-fixture-entry-preserve', { mode: 0o600 })
    const offline = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, 'offline-export-sentinel.json')
    writeFileSync(offline, 'excluded-offline-content', { mode: 0o600 })
    await waitDue(blockedSetup.config.retention.expiresAt)
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
    const accepted = await accept(key, 2), blockedAccepted = await accept(blockedKey)
    const original = await Incident.where('incident_key', key).first()
    assert(original)
    const inspected = inspectTemporaryWorkspace(tree)
    console.log(`Actual metadata process inspection ${JSON.stringify(inspected)}`)
    let disabled = 0
    const stop = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase()
      if (disabled || !sql.startsWith('insert into public_safety_purge_events') || !event.params?.includes('result')) return
      disabled++
      process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'false'
    } })
    let current: PurgeStatus
    try { current = await progress(key, accepted.receipt.purge.purgeKey) }
    finally { stop() }
    if (current.state !== 'blocked') {
      assert.equal(disabled, 1); assert.equal(process.env.PUBLIC_SAFETY_PURGE_ENABLED, 'false')
      assert(current.completed.namesUnlinked > 0); assert.notEqual(current.state, 'complete')
      const paused = await database.db.primary.selectFrom('public_safety_purges').selectAll().where('purge_key', '=', current.purgeKey).executeTakeFirst()
      const names = readdirSync(tree, { recursive: true }).map(String).sort()
      await assert.rejects(() => job.dispatchNow({ purgeKey: current.purgeKey }), status(409))
      assert.deepEqual(await database.db.primary.selectFrom('public_safety_purges').selectAll().where('purge_key', '=', current.purgeKey).executeTakeFirst(), paused)
      assert.deepEqual(readdirSync(tree, { recursive: true }).map(String).sort(), names)
      console.log('PASS actual operator disable after committed file result pauses and preserves pending units')
      process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
      current = await progress(key, current.purgeKey)
    }
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
    let blocked = await progress(blockedKey, blockedAccepted.receipt.purge.purgeKey)
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.outcomeCode, 'unexpected-entry')
    assert.equal(blocked.dbState, 'complete'); assert.equal(blocked.completed.namesUnlinked, 0)
    assert.equal(blocked.completed.sourceRowsRemoved, 1); assert.equal(blocked.completed.incidentPayloadRowsCleared, 1)
    assert.equal(blocked.completedAt, null); assert.equal(blocked.receiptRetainUntil, null)
    const blockedRow = await Purge.where('purge_key', blocked.purgeKey).first()
    const interval = Date.parse(blocked.blockedReviewDueAt!) - Date.parse(blockedRow.blocked_at_iso)
    assert(interval >= 30 * 86400000 && interval <= 30 * 86400000 + 100)
    const plans = await database.db.primary.selectFrom('public_safety_purge_items').selectAll().where('purge_id', '=', blockedRow.id).orderBy('id').execute()
    assert(plans.length > 0); assert(plans.some(row => typeof row.planned_json === 'string' && row.planned_json.includes(blockedTree)))
    // Explicit historical review-date reconstruction, never a forged completed row or ownership plan.
    const oldBlock = new Date(Date.now() - 31 * 86400000).toISOString(), oldReview = new Date(Date.parse(oldBlock) + 30 * 86400000).toISOString()
    await blockedRow.update({ blocked_at_iso: oldBlock, review_due_at_iso: oldReview, next_eligible_at_iso: oldReview })
    blocked = await purge.readPublicSafetyPurge(blockedKey, blocked.purgeKey)
    assert.equal(blocked.reviewOverdue, true)
    await job.dispatchNow({ purgeKey: blocked.purgeKey })
    blocked = await purge.readPublicSafetyPurge(blockedKey, blocked.purgeKey)
    assert.equal(blocked.state, 'blocked'); assert.equal(blocked.blockedReviewDueAt, oldReview)
    assert.equal(blocked.completedAt, null); assert.equal(blocked.receiptRetainUntil, null)
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_purge_items').selectAll().where('purge_id', '=', blockedRow.id).orderBy('id').execute(), plans)
    assert.equal(readFileSync(join(blockedTree, 'unknown-sentinel.txt'), 'utf8'), 'unknown-owned-fixture-entry-preserve')
    assert(await Incident.where('incident_key', blockedKey).first())
    console.log('PASS actual blocked plan keeps original 30 day review deadline and private ownership metadata after reconstructed overdue review')
    if (current.state !== 'complete') {
      assert.equal(inspected.unused, false); assert.equal(current.state, 'blocked')
      assert.equal(current.outcomeCode, 'inspection-unavailable'); assert(existsSync(tree))
      assert.equal(current.completed.namesUnlinked, 0)
      console.log('UNAVAILABLE completed receipt metadata retirement: actual process inspection refused; registered namespace and plans preserved')
      assert.equal(requirePositive, false, 'Positive metadata qualification requires real process visibility and actual completion')
      return
    }
    assert.equal(inspected.unused, true)
    assert.equal(current.receiptRetentionDays, 2)
    assert.equal(Date.parse(current.receiptRetainUntil!) - Date.parse(current.completedAt!), 2 * 86400000)
    assert(Date.parse(current.completedAt!) >= Date.parse(current.acceptedAt)); assert.equal(existsSync(tree), false)
    for (const fragment of [note, reviewNote, tree, 'recording.json']) assert(!JSON.stringify(await Purge.where('purge_key', current.purgeKey).first()).includes(fragment))
    assert.equal((await database.db.primary.selectFrom('public_safety_purge_items').select('id').where('purge_id', '=', (await Purge.where('purge_key', current.purgeKey).first()).id).execute()).length, 0)
    await as(custodian.token.plainTextToken, async () => assert.equal((await purge.readPublicSafetyPurge(key, current.purgeKey)).state, 'complete'))
    const revoke = { expectedRetentionVersion: current.retentionVersion, userId: custodian.user.id, requestId: randomUUID() }
    const revoked = await retention.revokePublicSafetyCustodyMember(key, revoke)
    assert('purge' in revoked); assert.equal(revoked.event.action, 'member-revoked')
    await as(custodian.token.plainTextToken, async () => { await assert.rejects(() => purge.readPublicSafetyPurge(key, current.purgeKey), status(403)) })
    const future = examplePublicSafetyConfig(); future.id = key; future.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
    await assert.rejects(() => access.createPublicSafetyIncident({ config: future }), status(409))
    const completeRow = await Purge.where('purge_key', current.purgeKey).first()
    const completedAt = new Date(Date.now() - 3 * 86400000).toISOString(), receiptUntil = new Date(Date.parse(completedAt) + 2 * 86400000).toISOString()
    // Historical completed-receipt dates only. Actual namespace/DB removal and minimal receipt already completed above.
    await completeRow.update({ completed_at_iso: completedAt, receipt_retain_until_iso: receiptUntil, next_eligible_at_iso: receiptUntil })
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'false'
    for (const read of [() => purge.previewPublicSafetyPurge(key), () => purge.readPublicSafetyPurge(key, current.purgeKey), () => purge.listPublicSafetyPurgeEvents(key, current.purgeKey), () => retention.previewPublicSafetyRetention(key), () => retention.readPublicSafetyRetention(key), () => retention.listPublicSafetyRetentionEvents(key), () => purge.acceptPublicSafetyPurge(key, accepted.body), () => retention.revokePublicSafetyCustodyMember(key, revoke)]) await assert.rejects(read, status(404))
    await assert.rejects(() => job.dispatchNow({ purgeKey: current.purgeKey }), status(409))
    assert(await Incident.where('incident_key', key).first()); assert(await Purge.where('purge_key', current.purgeKey).first())
    await assert.rejects(() => access.createPublicSafetyIncident({ config: future }), status(409))
    console.log('PASS actual expired receipt denies current reads and replay while disabled metadata cleanup remains overdue and key reserved')
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
    const deletionOrder: string[] = []
    const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase(), table = /^delete from ([a-z_]+)/.exec(sql)?.[1]
      if (table) deletionOrder.push(table)
    } })
    let units = 0
    try {
      for (; units < 20; units++) {
        if (!await Incident.where('incident_key', key).first()) break
        await assert.rejects(() => access.createPublicSafetyIncident({ config: future }), status(409))
        await job.dispatchNow({ purgeKey: current.purgeKey })
        await integrity()
        assert.equal(readFileSync(join(blockedTree, 'unknown-sentinel.txt'), 'utf8'), 'unknown-owned-fixture-entry-preserve')
        assert.equal(readFileSync(offline, 'utf8'), 'excluded-offline-content')
      }
    }
    finally { unhook() }
    assert(units > 0 && units < 20)
    assert.equal(await Incident.where('incident_key', key).first(), undefined)
    assert.equal(await Purge.where('purge_key', current.purgeKey).first(), undefined)
    for (const table of ['public_safety_retention_scopes', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_managed_artifacts']) assert.equal((await database.db.primary.selectFrom(table).select('id').where('incident_id', '=', original.id).execute()).length, 0)
    assert.equal((await database.db.primary.selectFrom('public_safety_observations').select('id').where('id', '=', observation.observation.id).execute()).length, 0)
    assert.equal((await database.db.primary.selectFrom('public_safety_reviews').select('id').where('id', '=', review.review.id).execute()).length, 0)
    for (const table of ['public_safety_purge_events', 'public_safety_incident_members', 'public_safety_purges', 'public_safety_retention_scopes', 'public_safety_incidents']) assert(deletionOrder.includes(table), `Expected observed metadata DELETE from ${table}`)
    assert.equal((await database.db.primary.selectFrom('public_safety_purge_events').select('id').where('purge_id', '=', completeRow.id).execute()).length, 0)
    assert(deletionOrder.indexOf('public_safety_purge_events') < deletionOrder.indexOf('public_safety_purges'))
    assert(deletionOrder.indexOf('public_safety_incident_members') < deletionOrder.indexOf('public_safety_incidents'))
    assert(deletionOrder.indexOf('public_safety_purges') < deletionOrder.indexOf('public_safety_retention_scopes'))
    assert(deletionOrder.indexOf('public_safety_retention_scopes') < deletionOrder.indexOf('public_safety_incidents'))
    const reused = await access.createPublicSafetyIncident({ config: future })
    assert.equal(reused.version, 1); assert.equal(reused.key, key)
    const newRow = await Incident.where('incident_key', key).first()
    assert.notEqual(newRow.id, original.id)
    await assert.rejects(() => purge.readPublicSafetyPurge(key, current.purgeKey), status(404))
    await as(custodian.token.plainTextToken, async () => { await assert.rejects(() => access.readPublicSafetyIncident(key), status(403)) })
    assert(await Purge.where('purge_key', blocked.purgeKey).first())
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_purge_items').selectAll().where('purge_id', '=', blockedRow.id).orderBy('id').execute(), plans)
    assert.equal(readFileSync(join(blockedTree, 'unknown-sentinel.txt'), 'utf8'), 'unknown-owned-fixture-entry-preserve')
    await integrity()
    assert.equal(readFileSync(offline, 'utf8'), 'excluded-offline-content')
    console.log(`PASS actual awaited native metadata retirement removed receipt scope grants and tombstone in ${units} FK-safe units before public key reuse`)
    console.log('UNQUALIFIED actual host clock regression: no global clock mock or host clock change was performed')
  })
}
finally { await database.closeDatabaseConnection() }
