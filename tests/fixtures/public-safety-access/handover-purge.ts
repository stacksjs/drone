import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { actor, as, seed, database, records, access } from './managed-context'

const handover = await import('../../../resources/functions/drone/public-safety/access/handover')
const { publicSafetyHandoverGate } = await import('../../../resources/functions/drone/public-safety/access/handover-policy')
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of ['read', 'write'] as const) Gate.define(`public-safety:handover-${ability}`, (user, key) => publicSafetyHandoverGate(user, key, ability))
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const tables = ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_retention_scopes', 'public_safety_retention_events', 'public_safety_purges', 'public_safety_purge_items', 'public_safety_purge_events']
try {
  const outgoing = await actor('handover-purge-outgoing'), incoming = await actor('handover-purge-incoming')
  const key = 'handover-purge', siblingKey = 'handover-purge-sibling', offerRequest = randomUUID(), terminalRequest = randomUUID()
  const setup = await as(outgoing.token.plainTextToken, async () => {
    const setup = await seed(key, 9000)
    await access.changePublicSafetyMembership(key, { expectedVersion: 3, userId: incoming.user.id, role: 'pilot' })
    const capture = setup.run.survey.captures[0]!, support = setup.run.captures[0]!.support.findIndex(value => value === 1)
    const point = await records.appendPublicSafetyObservation(key, { expectedVersion: 4, sourceDigest: setup.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'Handover purge private observation words', uncertaintyNote: 'Handover purge original uncertainty words' })
    await records.appendPublicSafetyReview(key, point.observation.id, { expectedVersion: 5, sourceDigest: setup.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Handover purge private review words' })
    await seed(siblingKey)
    return setup
  })
  const offered = await as(outgoing.token.plainTextToken, async () => {
    const desk = await handover.readIncidentHandoverDesk(key)
    return handover.offerIncidentCoordination(key, { requestId: offerRequest, assignment: desk.assignment, recipientUserId: incoming.user.id, recipientMembershipVersion: 1, sourceDigest: setup.source.digest, outgoingRole: 'observer', expiresInSeconds: 30 })
  })
  const accepted = await as(incoming.token.plainTextToken, async () => {
    const desk = await handover.readIncidentHandoverDesk(key, { offerKey: offered.offer.key })
    assert(desk.briefing)
    assert.equal(desk.briefing.entries.length, 2)
    const accepted = await handover.decideIncidentHandover(key, { requestId: terminalRequest, offerKey: offered.offer.key, decision: 'accept', acknowledgement: desk.briefing.acknowledgementRequired })
    assert.equal(accepted.offer.state, 'accepted')
    assert.equal(accepted.incident.coordinatorId, incoming.user.id)
    return accepted
  })
  const owned = (await database.db.primary.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', key).executeTakeFirst())!
  const sibling = (await database.db.primary.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', siblingKey).executeTakeFirst())!
  const protocol = await database.db.primary.selectFrom('public_safety_audits').selectAll().where('incident_id', '=', owned.id).where('handover_key', '=', offered.offer.key).orderBy('sequence', 'asc').execute()
  assert.equal(protocol.length, 2)
  assert.deepEqual(protocol.map(row => row.handover_step), ['offer', 'terminal'])
  assert.deepEqual(protocol.map(row => row.action), ['handover-offered', 'handover-accepted'])
  assert.deepEqual(protocol.map(row => row.request_id), [offerRequest, terminalRequest])
  const canaries = [setup.source.digest, offered.offer.key, offered.offer.digest, offerRequest, terminalRequest, ...protocol.map(row => String(row.request_digest)), 'Handover purge private observation words', 'Handover purge original uncertainty words', 'Handover purge private review words']
  for (const row of protocol) {
    assert.equal(row.handover_key, offered.offer.key)
    assert(Number(row.handover_assignment_version) >= 1)
    assert.equal(typeof row.request_digest, 'string')
    assert.equal(Buffer.byteLength(String(row.details_json), 'utf8') <= 2048, true)
  }
  const { id, ...duplicate } = protocol[0]!
  assert(id)
  await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values({ ...duplicate, sequence: 2147483640, request_id: randomUUID() }).execute(), /UNIQUE constraint failed/)
  await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values({ ...duplicate, sequence: 2147483640, handover_key: randomUUID() }).execute(), /UNIQUE constraint failed/)
  await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values({ ...duplicate, sequence: 2147483640, handover_key: randomUUID(), request_id: randomUUID(), handover_step: 'not-a-step' }).execute(), /CHECK constraint failed/)
  const siblingBefore = Object.fromEntries(await Promise.all(['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources', 'public_safety_retention_scopes'].map(async table => {
    const column = table === 'public_safety_incidents' ? 'id' : 'incident_id'
    return [table, await database.db.primary.selectFrom(table).selectAll().where(column, '=', sibling.id).orderBy('id', 'asc').execute()]
  })))
  const auditCount = (await database.db.primary.selectFrom('public_safety_audits').select('id').where('incident_id', '=', owned.id).execute()).length
  assert.equal(auditCount, 7, 'Real offer and terminal are ordinary accepted v1 audit inventory rows')
  assert.equal(accepted.event.sequence, 8)
  const wait = Date.parse(setup.config.retention.expiresAt) - Date.now() + 20
  if (wait > 0) await Bun.sleep(wait)
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(incoming.token.plainTextToken, async () => {
    const preview = await purge.previewPublicSafetyPurge(key)
    assert.equal(preview.counts.audits, auditCount)
    const accepted = await purge.acceptPublicSafetyPurge(key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
    let current = accepted.purge
    for (let pass = 0; pass < 60 && current.state !== 'complete'; pass++) {
      await job.dispatchNow({ purgeKey: current.purgeKey })
      current = await purge.readPublicSafetyPurge(key, current.purgeKey)
      assert.notEqual(current.state, 'blocked', JSON.stringify(current))
    }
    assert.equal(current.state, 'complete')
    assert.equal(current.completed.auditRowsRemoved, auditCount)
    assert.equal(current.completed.sourceRowsRemoved, 1)
    assert.equal(current.completed.observationRowsRemoved, 1)
    assert.equal(current.completed.reviewRowsRemoved, 1)
    assert.equal(current.completed.namesUnlinked, 0)
    const events = await purge.listPublicSafetyPurgeEvents(key, current.purgeKey)
    for (const canary of canaries) assert(!JSON.stringify({ current, events }).includes(canary), 'Purge public receipt/events must not copy handover/source/request identity')
  })
  for (const table of ['public_safety_audits', 'public_safety_sources']) assert.deepEqual(await database.db.primary.selectFrom(table).select('id').where('incident_id', '=', owned.id).execute(), [])
  for (const table of tables) {
    const rows = await database.db.primary.selectFrom(table).selectAll().execute()
    for (const canary of canaries) assert(!JSON.stringify(rows).includes(canary), `${table}: no per-offer payload/hash/request copy survives complete`)
  }
  for (const [table, before] of Object.entries(siblingBefore)) {
    const column = table === 'public_safety_incidents' ? 'id' : 'incident_id'
    assert.deepEqual(await database.db.primary.selectFrom(table).selectAll().where(column, '=', sibling.id).orderBy('id', 'asc').execute(), before, `${table}: unrelated sibling remains exact`)
  }
  assert.deepEqual(await database.db.unsafe('PRAGMA foreign_keys'), [{ foreign_keys: 1 }])
  assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
  assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
  console.log('PASS native offer and recipient acceptance enter fixed v1 audit inventory and awaited purge removes every handover payload while preserving sibling')
  console.log('PASS DB-only handover purge makes no positive registered-filesystem or media-erasure claim')
}
finally { await database.closeDatabaseConnection() }
