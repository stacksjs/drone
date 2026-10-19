import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { actor, as, seed, database, managed, records, retention, access, status } from './managed-context'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
function consent(preview: Awaited<ReturnType<typeof purge.previewPublicSafetyPurge>>) { return { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() } }
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  const coordinator = await actor('purge-mixed-coordinator'), observer = await actor('purge-mixed-observer')
  await as(coordinator.token.plainTextToken, async () => {
    const key = 'purge-mixed', fixture = await seed(key, 20000), admittedAt = Date.now(), original = await purge.previewPublicSafetyPurge(key)
    const source = await records.registerPublicSafetySource(key, { expectedVersion: 3, recording: simulatePublicSafety({ config: fixture.config, seconds: 11 }) })
    assert.equal(source.incident.version, 4)
    const capture = fixture.run.survey.captures[0]!, support = fixture.run.captures[0]!.support.findIndex(value => value === 1)
    const observationBody = { expectedVersion: 4, sourceDigest: fixture.source.digest, captureId: capture.id, modality: 'visible' as const, pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'private-mixed-observation', uncertaintyNote: 'private-mixed-uncertainty' }
    const observation = await records.appendPublicSafetyObservation(key, observationBody)
    const reviewed = await records.appendPublicSafetyReview(key, observation.observation.id, { expectedVersion: 5, sourceDigest: fixture.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'private-mixed-review' })
    await access.changePublicSafetyMembership(key, { expectedVersion: 6, userId: observer.user.id, role: 'observer' })
    await managed.createPublicSafetyManagedDataset(key, { ...fixture.body, expectedVersion: 7 })
    await retention.reviewPublicSafetyRetentionHold(key, { expectedRetentionVersion: 1, decision: 'retain', caseReference: 'controlled-mixed-hold', reviewDueAt: new Date(Date.now() + 86400000).toISOString(), requestId: randomUUID() })
    const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    await assert.rejects(() => purge.acceptPublicSafetyPurge(key, consent(original)), status(409))
    const held = await purge.previewPublicSafetyPurge(key); assert.equal(held.eligibility, 'ineligible')
    await assert.rejects(() => purge.acceptPublicSafetyPurge(key, consent(held)), status(409))
    await retention.reviewPublicSafetyRetentionHold(key, { expectedRetentionVersion: 2, decision: 'release', caseReference: 'controlled-mixed-release', reviewDueAt: null, requestId: randomUUID() })
    const fresh = await purge.previewPublicSafetyPurge(key); assert.equal(fresh.eligibility, 'eligible'); assert.notEqual(fresh.inventoryDigest, original.inventoryDigest)
    assert.equal(fresh.counts.sources, 2); assert.equal(fresh.counts.observations, 1); assert.equal(fresh.counts.reviews, 1); assert.equal(fresh.counts.nonCustodyMemberships, 1); assert.equal(fresh.counts.managedArtifacts, 1)
    const distinctRecording = simulatePublicSafety({ config: fixture.config, seconds: 12 }), distinctDigest = createHash('sha256').update(publicSafetyRecordingData(distinctRecording)).digest('hex')
    assert(![fixture.source.digest, source.source.digest].includes(distinctDigest))
    const accepted = await purge.acceptPublicSafetyPurge(key, consent(fresh)), tables = ['public_safety_sources', 'public_safety_observations', 'public_safety_reviews', 'public_safety_incident_members', 'public_safety_managed_artifacts', 'public_safety_retention_scopes']
    const before = await Promise.all(tables.map(table => database.db.primary.selectFrom(table).selectAll().execute())), originalNow = Date.now
    try {
      // Isolate accepted freeze from content expiry with an explicitly controlled local wall-clock rollback.
      Date.now = () => admittedAt
      const expectedVersion = accepted.purge.incidentVersion
      await assert.rejects(() => records.registerPublicSafetySource(key, { expectedVersion, recording: distinctRecording }), status(409))
      await assert.rejects(() => records.appendPublicSafetyObservation(key, { ...observationBody, expectedVersion }), status(409))
      await assert.rejects(() => records.appendPublicSafetyReview(key, observation.observation.id, { expectedVersion, sourceDigest: fixture.source.digest, previousReviewId: reviewed.review.id, disposition: 'unresolved', note: 'blocked-after-freeze' }), status(409))
      await assert.rejects(() => access.changePublicSafetyMembership(key, { expectedVersion, userId: observer.user.id, role: 'pilot' }), status(409))
      await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, { ...fixture.body, expectedVersion, expectedRetentionVersion: accepted.purge.retentionVersion, requestId: randomUUID() }), status(409))
      await assert.rejects(() => retention.reviewPublicSafetyRetentionHold(key, { expectedRetentionVersion: accepted.purge.retentionVersion, decision: 'retain', caseReference: 'blocked-after-freeze', reviewDueAt: new Date(Date.now() + 86400000).toISOString(), requestId: randomUUID() }), status(409))
    }
    finally { Date.now = originalNow }
    assert.deepEqual(await Promise.all(tables.map(table => database.db.primary.selectFrom(table).selectAll().execute())), before)
    const retryBody = { expectedPurgeVersion: accepted.purge.version, expectedRetentionVersion: accepted.purge.retentionVersion, requestId: randomUUID() }, retried = await purge.retryPublicSafetyPurge(key, accepted.purge.purgeKey, retryBody)
    const replay = await purge.retryPublicSafetyPurge(key, accepted.purge.purgeKey, Object.fromEntries(Object.entries(retryBody).reverse()))
    assert.equal(retried.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(replay.event, retried.event); assert.equal(replay.purge.version, retried.purge.version)
    await assert.rejects(() => purge.retryPublicSafetyPurge(key, accepted.purge.purgeKey, { ...retryBody, requestId: randomUUID() }), status(409))
    let current = replay.purge
    for (let n = 0; n < 60 && current.state !== 'complete'; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
    assert.equal(current.state, 'complete'); assert.equal(current.completed.sourceRowsRemoved, 2); assert.equal(current.completed.observationRowsRemoved, 1); assert.equal(current.completed.reviewRowsRemoved, 1); assert.equal(current.completed.nonCustodyMembershipRowsRemoved, 1)
    console.log('PASS actual mixed public source records member hold managed changes require fresh purge consent and freeze defeats controlled clock rollback')
    console.log('PASS actual canonical reordered duplicate retry replays one committed human event and stale new operation refuses')
  })
}
finally { await database.closeDatabaseConnection() }
