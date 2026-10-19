import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, managed } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const coordinator = await actor('purge-sql-coordinator')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const fixtures = []
    for (const kind of ['arm', 'result', 'db-source'] as const) {
      const key = `p-sql-${kind}`, seeded = await seed(key, 15000), created = await managed.createPublicSafetyManagedDataset(key, seeded.body)
      fixtures.push({ kind, key, expiresAt: seeded.config.retention.expiresAt, directory: join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key) })
    }
    const wait = Math.max(...fixtures.map(fixture => Date.parse(fixture.expiresAt))) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    for (const fixture of fixtures) {
      const preview = await purge.previewPublicSafetyPurge(fixture.key), accepted = await purge.acceptPublicSafetyPurge(fixture.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      const predicate = fixture.kind === 'arm' ? "NEW.step = 'arm'" : fixture.kind === 'result' ? "NEW.step = 'result' AND json_extract(NEW.counts_json, '$.namesUnlinked') > 0" : "NEW.step = 'db-batch' AND json_extract(NEW.counts_json, '$.sourceRowsRemoved') > 0"
      await database.db.primary.unsafe(`CREATE TRIGGER controlled_purge_event_rollback BEFORE INSERT ON public_safety_purge_events WHEN ${predicate} BEGIN SELECT RAISE(ABORT, 'controlled fixture rollback'); END`).execute()
      let current = accepted.purge
      for (let n = 0; n < 60; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey); if (current.state === 'blocked') break }
      assert.equal(current.state, 'blocked'); assert.notEqual(current.state, 'complete')
      const purgeRow = (await database.db.primary.selectFrom('public_safety_purges').select(['id', 'incident_id']).where('purge_key', '=', current.purgeKey).executeTakeFirst())!, purgeId = purgeRow.id
      if (fixture.kind === 'db-source') {
        assert.equal(current.dbState, 'blocked'); assert.notEqual(current.fsState, 'blocked'); assert.equal(current.completed.sourceRowsRemoved, 0)
        for (let n = 0; n < 60 && current.fsState !== 'complete'; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey) }
        assert.equal(current.fsState, 'complete'); assert.equal(current.dbState, 'blocked'); assert.equal(existsSync(fixture.directory), false)
        assert(current.completed.namesUnlinked > 0); assert.equal(current.completed.sourceRowsRemoved, 0)
        assert.equal((await database.db.primary.selectFrom('public_safety_sources').select('id').where('incident_id', '=', purgeRow.incident_id).execute()).length, 1)
        console.log('PASS actual DB source-result rollback preserves payload while independent accepted filesystem arm completes')
      }
      else {
        assert.equal(current.dbState, 'complete'); assert.equal(current.fsState, 'blocked'); assert.equal(current.completed.namesUnlinked, 0)
        assert.equal(current.completed.sourceRowsRemoved, 1)
        const armed = await database.db.primary.selectFrom('public_safety_purge_items').select('id').where('purge_id', '=', purgeId).where('state', '=', 'armed').execute()
        assert.equal(armed.length, fixture.kind === 'arm' ? 0 : 1)
        assert.equal(existsSync(join(fixture.directory, 'recording.json')), fixture.kind === 'arm')
        console.log(`PASS actual ${fixture.kind} event SQL rollback preserves committed deletion authority without fictional result`)
      }
      await database.db.primary.unsafe('DROP TRIGGER controlled_purge_event_rollback').execute()
      await purge.retryPublicSafetyPurge(fixture.key, current.purgeKey, { expectedPurgeVersion: current.version, expectedRetentionVersion: current.retentionVersion, requestId: randomUUID() })
      for (let n = 0; n < 60 && current.state !== 'complete'; n++) { await job.dispatchNow({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(fixture.key, current.purgeKey); assert.notEqual(current.state, 'blocked', JSON.stringify(current)) }
      assert.equal(current.state, 'complete'); assert.equal(existsSync(fixture.directory), false)
      assert.equal(current.completed.namesAbsenceReconciled, fixture.kind === 'result' ? 1 : 0)
      assert.equal(current.completed.sourceRowsRemoved, 1); assert.equal(current.completed.incidentPayloadRowsCleared, 1)
    }
  })
}
finally { await database.closeDatabaseConnection() }
