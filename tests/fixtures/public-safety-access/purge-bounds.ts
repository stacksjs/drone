import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, managed } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  const coordinator = await actor('purge-bounds-coordinator')
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures = []
    for (const kind of ['ordinary', 'artifact', 'arm'] as const) {
      const key = `p-bounds-${kind}`, fixture = await seed(key, 15000), created = await managed.createPublicSafetyManagedDataset(key, fixture.body)
      const row = (await database.db.primary.selectFrom('public_safety_managed_artifacts').select(['id', 'receipt_json']).where('artifact_key', '=', created.artifact.key).executeTakeFirst())!, receipt = JSON.parse(row.receipt_json as string)
      // Controlled oversized private metadata reconstruction, never payload adoption/truncation or a public renderer claim.
      if (kind === 'ordinary') receipt.root.padding = 'é'.repeat(9000)
      if (kind === 'artifact') receipt.padding = 'é'.repeat(2100000)
      if (kind !== 'arm') await database.db.primary.updateTable('public_safety_managed_artifacts').set({ receipt_json: JSON.stringify(receipt) }).where('id', '=', row.id).execute()
      fixtures.push({ kind, key, expiresAt: fixture.config.retention.expiresAt, directory: join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key) })
    }
    const wait = Math.max(...fixtures.map(value => Date.parse(value.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const fixture of fixtures) {
      const before = readFileSync(join(fixture.directory, 'recording.json')), preview = await purge.previewPublicSafetyPurge(fixture.key), accepted = await purge.acceptPublicSafetyPurge(fixture.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      if (fixture.kind === 'arm') await database.db.primary.unsafe("CREATE TRIGGER controlled_bounds_arm AFTER UPDATE OF operation_nonce ON public_safety_purge_items WHEN OLD.state='armed' AND NEW.state='armed' AND NEW.version=OLD.version BEGIN UPDATE public_safety_purge_items SET operation_nonce='00000000-0000-4000-8000-000000000000' WHERE id=NEW.id; END").execute()
      let current = accepted.purge
      for (let n = 0; n < 60 && current.state !== 'complete' && current.state !== 'blocked'; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey) }
      if (fixture.kind === 'arm') {
        assert.equal(current.state, 'blocked'); assert.equal(current.completed.namesUnlinked, 0)
        await database.db.primary.unsafe('DROP TRIGGER controlled_bounds_arm').execute()
        const armed = (await database.db.primary.selectFrom('public_safety_purge_items').select(['id', 'arm_json']).where('state', '=', 'armed').executeTakeFirst())!, arm = JSON.parse(armed.arm_json as string)
        arm.padding = 'é'.repeat(140000)
        await database.db.primary.updateTable('public_safety_purge_items').set({ arm_json: JSON.stringify(arm) }).where('id', '=', armed.id).execute()
        await purge.retryPublicSafetyPurge(fixture.key, current.purgeKey, { expectedPurgeVersion: current.version, expectedRetentionVersion: current.retentionVersion, requestId: randomUUID() })
        await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey)
      }
      assert.equal(current.state, 'blocked'); assert.equal(current.outcomeCode, 'capacity-exceeded'); assert.equal(current.completed.namesUnlinked, 0); assert.equal(current.completedAt, null)
      assert(existsSync(fixture.directory)); assert.deepEqual(readFileSync(join(fixture.directory, 'recording.json')), before)
      if (fixture.kind !== 'arm') {
        const id = (await database.db.primary.selectFrom('public_safety_purges').select('id').where('purge_key', '=', current.purgeKey).executeTakeFirst())!.id
        assert.equal((await database.db.primary.selectFrom('public_safety_purge_items').select('id').where('purge_id', '=', id).where('kind', 'in', ['artifact', 'file', 'directory']).execute()).length, 0, 'Oversized insertion unit must roll back without storing truncated or oversized items')
      }
      console.log(`PASS controlled UTF8 oversized ${fixture.kind} metadata refuses native purge insertion or update without filesystem effects`)
    }
  })
}
finally { await database.closeDatabaseConnection() }
