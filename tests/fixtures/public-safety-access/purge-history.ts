import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { actor, as, seed, database, records, managed } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const coordinator = await actor('purge-history-coordinator')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const key = 'purge-history', fixture = await seed(key, 60000)
    const capture = fixture.run.survey.captures[0]!, support = fixture.run.captures[0]!.support.findIndex(value => value === 1)
    const observation = await records.appendPublicSafetyObservation(key, { expectedVersion: 3, sourceDigest: fixture.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'private-history-observation-fragment', uncertaintyNote: 'private-history-uncertainty-fragment' })
    let version = 4, previousReviewId: number | null = null
    for (let count = 0; count < 137; count++) {
      const appended = await records.appendPublicSafetyReview(key, observation.observation.id, { expectedVersion: version, sourceDigest: fixture.source.digest, previousReviewId, disposition: 'unresolved', note: `private-history-review-fragment-${count}` })
      version = appended.incident.version; previousReviewId = appended.review.id
    }
    await managed.createPublicSafetyManagedDataset(key, { ...fixture.body, expectedVersion: version })
    const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    const preview = await purge.previewPublicSafetyPurge(key)
    assert.equal(preview.counts.reviews, 137); assert(preview.counts.audits > 100)
    const accepted = await purge.acceptPublicSafetyPurge(key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 2, requestId: randomUUID() })
    let current = accepted.purge
    for (let count = 0; count < 80 && current.state !== 'complete'; count++) {
      await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(key, current.purgeKey)
      if (current.state === 'blocked') break
    }
    assert.equal(current.dbState, 'complete'); assert.equal(current.completed.reviewRowsRemoved, 137)
    assert.equal(current.completed.auditRowsRemoved, preview.counts.audits)
    assert.equal(current.completed.observationRowsRemoved, 1); assert.equal(current.completed.sourceRowsRemoved, 1)
    assert.equal((await database.db.primary.selectFrom('public_safety_reviews').select('id').execute()).length, 0)
    assert.equal((await database.db.primary.selectFrom('public_safety_observations').select('id').execute()).length, 0)
    const source = await database.db.primary.selectFrom('public_safety_sources').select('id').execute(); assert.equal(source.length, 0)
    const events = await purge.listPublicSafetyPurgeEvents(key, current.purgeKey)
    const reviewBatches = events.entries.filter(event => event.delta.reviewRowsRemoved > 0)
    assert.deepEqual(reviewBatches.map(event => event.delta.reviewRowsRemoved), [100, 37])
    if (current.state === 'complete') {
      assert.equal(Date.parse(current.receiptRetainUntil!) - Date.parse(current.completedAt!), 2 * 86400000)
      assert.equal((await database.db.primary.selectFrom('public_safety_purge_items').select('id').execute()).length, 0)
    }
    else { assert.equal(current.outcomeCode, 'inspection-unavailable'); assert.notEqual(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST, '1') }
    assert.equal(current.allCopiesErased, false)
    console.log('PASS actual137review FK leaves and multi-page accepted history removed in bounded100and37row native batches')
  })
}
finally { await database.closeDatabaseConnection() }
