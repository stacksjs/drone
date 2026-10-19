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
const coordinator = await actor('purge-critical-coordinator')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures = []
    for (const fault of ['nonce', 'generation', 'phase', 'id'] as const) {
      const key = `purge-critical-${fault}`, seeded = await seed(key, 15000), created = await managed.createPublicSafetyManagedDataset(key, seeded.body)
      fixtures.push({ fault, key, expiresAt: seeded.config.retention.expiresAt, directory: join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key) })
    }
    const wait = Math.max(...fixtures.map(fixture => Date.parse(fixture.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const fixture of fixtures) {
      const preview = await purge.previewPublicSafetyPurge(fixture.key), accepted = await purge.acceptPublicSafetyPurge(fixture.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      const before = readFileSync(join(fixture.directory, 'recording.json'))
      const assignment = { nonce: "operation_nonce = '00000000-0000-4000-8000-000000000000'", generation: 'generation = generation + 1', phase: "state = 'blocked'", id: 'id = id + 100000' }[fixture.fault]
      await database.db.primary.unsafe(`CREATE TRIGGER controlled_purge_fence AFTER UPDATE OF operation_nonce ON public_safety_purge_items WHEN OLD.state = 'armed' AND NEW.state = 'armed' AND NEW.operation_nonce != OLD.operation_nonce AND NEW.version = OLD.version BEGIN UPDATE public_safety_purge_items SET ${assignment} WHERE id = NEW.id; END`).execute()
      let current = accepted.purge
      for (let count = 0; count < 40 && current.state !== 'blocked'; count++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey) }
      assert.equal(current.state, 'blocked'); assert.equal(current.fsState, 'blocked')
      assert.equal(current.completed.namesUnlinked, 0); assert.equal(current.completed.fileInodesVerifiedAbsent, 0)
      assert(existsSync(fixture.directory)); assert.deepEqual(readFileSync(join(fixture.directory, 'recording.json')), before)
      const armed = await database.db.primary.selectFrom('public_safety_purge_items').select(['state', 'generation']).where('purge_id', '=', (await database.db.primary.selectFrom('public_safety_purges').select('id').where('purge_key', '=', current.purgeKey).executeTakeFirst())!.id).where('state', '=', 'armed').execute()
      assert.equal(armed.length, 1); assert.equal(armed[0]!.generation, 2)
      await database.db.primary.unsafe('DROP TRIGGER controlled_purge_fence').execute()
      console.log(`PASS actual SQLite AFTER UPDATE ${fixture.fault} drift refuses exact synchronous purge effect`)
    }
  })
}
finally { await database.closeDatabaseConnection() }
