import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { actor, as, seed, database, managed, access, retention } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const coordinator = await actor('purge-membership-coordinator')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures = []
    for (const phase of ['before-build', 'after-ready'] as const) {
      const key = `purge-member-${phase}`, seeded = await seed(key, 20000), member = await actor(`purge-member-${phase}`)
      await access.changePublicSafetyMembership(key, { expectedVersion: 3, userId: member.user.id, role: 'observer' })
      await managed.createPublicSafetyManagedDataset(key, { ...seeded.body, expectedVersion: 4 })
      fixtures.push({ phase, key, member, expiresAt: seeded.config.retention.expiresAt })
    }
    const wait = Math.max(...fixtures.map(fixture => Date.parse(fixture.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const fixture of fixtures) {
      const preview = await purge.previewPublicSafetyPurge(fixture.key)
      assert.equal(preview.counts.nonCustodyMemberships, 1)
      const accepted = await purge.acceptPublicSafetyPurge(fixture.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      let current = accepted.purge
      if (fixture.phase === 'after-ready') {
        for (let n = 0; n < 20 && current.state !== 'ready'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
        assert.equal(current.state, 'ready'); assert.equal(current.completed.sourceRowsRemoved, 0)
      }
      const revoked = await retention.revokePublicSafetyCustodyMember(fixture.key, { expectedRetentionVersion: current.retentionVersion, userId: fixture.member.user.id, requestId: randomUUID() })
      assert('purge' in revoked); assert.equal(revoked.event.action, 'member-revoked')
      current = revoked.purge
      for (let n = 0; n < 60 && current.state !== 'complete'; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey); if (current.state === 'blocked') break }
      assert.equal(current.dbState, 'complete', JSON.stringify(current))
      assert.equal(current.completed.nonCustodyMembershipRowsRemoved, 1); assert.equal(current.completed.sourceRowsRemoved, 1); assert.equal(current.completed.incidentPayloadRowsCleared, 1)
      if (current.state === 'blocked') assert.equal(current.outcomeCode, 'inspection-unavailable')
      assert.equal((await database.db.primary.selectFrom('public_safety_incident_members').select('id').where('user_id', '=', fixture.member.user.id).execute()).length, 0)
      console.log(`PASS actual current coordinator revoke ${fixture.phase} preserves accepted system purge delegation`)
    }
  })
}
finally { await database.closeDatabaseConnection() }
