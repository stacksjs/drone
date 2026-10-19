import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { actor, as, seed, database, managed } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  const coordinator = await actor('purge-seal-coordinator')
  await as(coordinator.token.plainTextToken, async () => {
    const key = 'purge-seal', fixture = await seed(key, 10000)
    await managed.createPublicSafetyManagedDataset(key, fixture.body)
    const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    const preview = await purge.previewPublicSafetyPurge(key), accepted = await purge.acceptPublicSafetyPurge(key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
    let current = accepted.purge
    for (let n = 0; n < 60 && current.state !== 'minimizing'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
    assert.equal(current.state, 'minimizing')
    const row = (await database.db.primary.selectFrom('public_safety_purges').select(['id', 'incident_id', 'sealed_totals_json']).where('purge_key', '=', current.purgeKey).executeTakeFirst())!
    const before = await database.db.primary.selectFrom('public_safety_managed_artifacts').selectAll().where('incident_id', '=', row.incident_id).execute()
    assert.equal(before.length, 1)
    // Controlled invalid durable aggregate, not a claim about an unprivileged attacker editing SQLite.
    const seal = JSON.parse(row.sealed_totals_json as string); seal.completed.namesUnlinked++
    await database.db.primary.updateTable('public_safety_purges').set({ sealed_totals_json: JSON.stringify(seal) }).where('id', '=', row.id).execute()
    await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(key, current.purgeKey)
    assert.equal(current.state, 'blocked'); assert.equal(current.fsState, 'complete'); assert.equal(current.dbState, 'complete'); assert.equal(current.completedAt, null)
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_managed_artifacts').selectAll().where('incident_id', '=', row.incident_id).execute(), before)
    await database.db.primary.updateTable('public_safety_purges').set({ sealed_totals_json: row.sealed_totals_json }).where('id', '=', row.id).execute()
    await purge.retryPublicSafetyPurge(key, current.purgeKey, { expectedPurgeVersion: current.version, expectedRetentionVersion: current.retentionVersion, requestId: randomUUID() })
    for (let n = 0; n < 30 && current.state !== 'complete'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
    assert.equal(current.state, 'complete')
    console.log('PASS actual minimized seal mismatch blocks metadata retirement and completion before valid retry')
  })
}
finally { await database.closeDatabaseConnection() }
