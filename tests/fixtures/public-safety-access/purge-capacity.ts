import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, managed, status } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const coordinator = await actor('purge-capacity-coordinator')
const maximum = 2147483647
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures = []
    for (const kind of ['item-version', 'item-generation', 'purge-version', 'common-version'] as const) {
      const key = `p-cap-${kind}`, seeded = await seed(key, 15000), created = await managed.createPublicSafetyManagedDataset(key, seeded.body)
      fixtures.push({ kind, key, expiresAt: seeded.config.retention.expiresAt, directory: join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key) })
    }
    const wait = Math.max(...fixtures.map(fixture => Date.parse(fixture.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const fixture of fixtures) {
      const preview = await purge.previewPublicSafetyPurge(fixture.key), accepted = await purge.acceptPublicSafetyPurge(fixture.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      let current = accepted.purge
      for (let n = 0; n < 30 && current.dbState !== 'complete'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
      const row = (await database.db.primary.selectFrom('public_safety_purges').select(['id', 'incident_id']).where('purge_key', '=', current.purgeKey).executeTakeFirst())!
      const item = (await database.db.primary.selectFrom('public_safety_purge_items').select(['id']).where('purge_id', '=', row.id).where('kind', '=', 'file').orderBy('ordinal', 'asc').limit(1).executeTakeFirst())!
      // Explicit reconstruction of historical counter state, not billions of claimed lifecycle operations.
      if (fixture.kind === 'item-version') await database.db.primary.updateTable('public_safety_purge_items').set({ version: maximum - 2 }).where('id', '=', item.id).execute()
      if (fixture.kind === 'item-generation') await database.db.primary.updateTable('public_safety_purge_items').set({ generation: maximum - 2 }).where('id', '=', item.id).execute()
      if (fixture.kind === 'purge-version') await database.db.primary.updateTable('public_safety_purges').set({ version: maximum - 1 }).where('id', '=', row.id).execute()
      if (fixture.kind === 'common-version') await database.db.primary.updateTable('public_safety_incidents').set({ version: maximum - 1 }).where('id', '=', row.incident_id).execute()
      const before = readFileSync(join(fixture.directory, 'recording.json'))
      try { await job.dispatchNow({ purgeKey: current.purgeKey }) }
      catch (error) { assert(status(409)(error)) }
      assert.deepEqual(readFileSync(join(fixture.directory, 'recording.json')), before)
      const after = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey)
      assert.notEqual(after.state, 'complete'); assert.equal(after.completed.namesUnlinked, 0); assert.equal(after.completed.fileInodesVerifiedAbsent, 0)
      const armed = await database.db.primary.selectFrom('public_safety_purge_items').select(['state', 'arm_json']).where('id', '=', item.id).executeTakeFirst()
      assert.equal(armed!.state, 'armed', 'Counter reservation refuses after actual arm COMMIT, before any effect')
      assert(armed!.arm_json)
      console.log(`PASS controlled historical ${fixture.kind} reserves result counter capacity before any unlink`)
    }
  })
}
finally { await database.closeDatabaseConnection() }
