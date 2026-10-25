import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { actor, as, seed, database, records } from './managed-context'
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const coordinator = await actor('purge-relations-coordinator')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures = []
    for (const [index, kind] of (['foreign-parent', 'foreign-child', 'self-parent', 'review-owner', 'observation-owner'] as const).entries()) {
      const pairs = []
      for (const scope of ['owned', 'outside']) {
        const key = `pr-${index}-${scope === 'owned' ? 'o' : 'x'}`, fixture = await seed(key, 15000)
        const capture = fixture.run.survey.captures[0]!, support = fixture.run.captures[0]!.support.findIndex(value => value === 1)
        const observation = await records.appendPublicSafetyObservation(key, { expectedVersion: 3, sourceDigest: fixture.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: `private-${scope}-observation`, uncertaintyNote: 'private-uncertainty' })
        const reviewed = kind === 'observation-owner' && scope === 'owned' ? null : await records.appendPublicSafetyReview(key, observation.observation.id, { expectedVersion: 4, sourceDigest: fixture.source.digest, previousReviewId: null, disposition: 'unresolved', note: `private-${scope}-review` })
        const observationRow = (await database.db.primary.selectFrom('public_safety_observations').select('source_id').where('id', '=', observation.observation.id).executeTakeFirst())!
        pairs.push({ key, fixture, reviewId: reviewed?.review.id ?? null, observationId: observation.observation.id, sourceId: observationRow.source_id })
      }
      const owned = pairs[0]!, outside = pairs[1]!
      if (!kind.endsWith('owner')) await database.db.primary.updateTable('public_safety_reviews').set({ previous_review_id: kind === 'foreign-parent' ? outside.reviewId : owned.reviewId }).where('id', '=', kind === 'foreign-child' ? outside.reviewId : owned.reviewId).execute()
      fixtures.push({ kind, owned, outside })
    }
    const wait = Math.max(...fixtures.map(value => Date.parse(value.owned.fixture.config.retention.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const fixture of fixtures) {
      const outsideBefore = await database.db.primary.selectFrom('public_safety_reviews').selectAll().where('id', '=', fixture.outside.reviewId!).executeTakeFirst()
      const preview = await purge.previewPublicSafetyPurge(fixture.owned.key), accepted = await purge.acceptPublicSafetyPurge(fixture.owned.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      let current = accepted.purge
      if (fixture.kind.endsWith('owner')) {
        for (let n = 0; n < 20 && current.state !== 'ready'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(fixture.owned.key, current.purgeKey) }
        assert.equal(current.state, 'ready')
        // Actual post-ready relationship change, without changing any private C plan.
        const outsideSource = (await database.db.primary.selectFrom('public_safety_sources').select('incident_id').where('id', '=', fixture.outside.sourceId).executeTakeFirst())!
        const outsideIncidentId = outsideSource.incident_id
        assert(typeof outsideIncidentId === 'number' && Number.isSafeInteger(outsideIncidentId) && outsideIncidentId > 0)
        await database.db.primary.updateTable('public_safety_sources').set({ incident_id: outsideIncidentId }).where('id', '=', fixture.owned.sourceId).execute()
      }
      for (let n = 0; n < 30 && current.state !== 'blocked' && current.state !== 'complete'; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.owned.key, current.purgeKey) }
      assert.equal(current.state, 'blocked'); assert.equal(current.dbState, 'blocked'); assert.equal(current.outcomeCode, 'foreign-reference'); assert.equal(current.completed.reviewRowsRemoved, 0)
      if (fixture.owned.reviewId !== null) assert(await database.db.primary.selectFrom('public_safety_reviews').select('id').where('id', '=', fixture.owned.reviewId).executeTakeFirst())
      assert(await database.db.primary.selectFrom('public_safety_observations').select('id').where('id', '=', fixture.owned.observationId).executeTakeFirst())
      assert.equal(current.completed.observationRowsRemoved, 0)
      assert.deepEqual(await database.db.primary.selectFrom('public_safety_reviews').selectAll().where('id', '=', fixture.outside.reviewId!).executeTakeFirst(), outsideBefore)
      console.log(`PASS actual controlled ${fixture.kind} review relation blocks accepted DB deletion and preserves foreign row`)
    }
  })
}
finally { await database.closeDatabaseConnection() }
