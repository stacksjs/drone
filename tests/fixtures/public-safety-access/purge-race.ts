import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { actor, as, seed, database, managed, root } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const mode = process.argv[2], stage = process.argv[3]
assert(stage === 'held-claim' || stage === 'stale-read')
const savedPath = join(root, 'purge-race.json'), pausedPath = join(root, 'purge-race-paused.json')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  if (mode === 'create') {
    const coordinator = await actor('purge-race-coordinator')
    await as(coordinator.token.plainTextToken, async () => {
      const key = 'purge-race', fixture = await seed(key, 10000), created = await managed.createPublicSafetyManagedDataset(key, fixture.body)
      const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      const preview = await purge.previewPublicSafetyPurge(key), accepted = await purge.acceptPublicSafetyPurge(key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
      let current = accepted.purge
      for (let n = 0; n < 30 && current.dbState !== 'complete'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(key, current.purgeKey) }
      assert.equal(current.dbState, 'complete'); assert.equal(current.completed.namesUnlinked, 0)
      writeFileSync(savedPath, JSON.stringify({ key, purgeKey: current.purgeKey, token: coordinator.token.plainTextToken, directory: join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key) }))
    })
  }
  else {
    const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
    if (mode === 'first') {
      let armSeen = false, paused = false
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (sql.startsWith('insert into public_safety_purge_events') && event.params?.includes('arm')) armSeen = true
        if (paused || !(stage === 'held-claim' ? armSeen && sql.startsWith('update public_safety_purge_items') : sql.startsWith('select') && sql.includes('from public_safety_purge_items') && event.params?.includes('file'))) return
        paused = true; writeFileSync(pausedPath, JSON.stringify({ pid: process.pid, stage })); process.kill(process.pid, 'SIGSTOP')
      } })
      try { try { await runPublicSafetyPurgeBatch({ purgeKey: saved.purgeKey, maxItems: 1 }) } catch (error) { assert(error instanceof Error && /locked|busy|conflict|changed/i.test(error.message), String(error)) } }
      finally { unhook() }
      assert(paused, 'Actual captured execution barrier must be reached')
      console.log(`PASS actual ${stage} executor resumes without reusing stale deletion authority`)
    }
    else if (mode === 'second') {
      try { await runPublicSafetyPurgeBatch({ purgeKey: saved.purgeKey, maxItems: 1 }) }
      catch (error) { assert(stage === 'held-claim' && error instanceof Error && /locked|busy|conflict|changed/i.test(error.message), String(error)) }
      const row = (await database.db.primary.selectFrom('public_safety_purges').select('progress_counts_json').where('purge_key', '=', saved.purgeKey).executeTakeFirst())!
      assert.equal(JSON.parse(row.progress_counts_json as string).namesUnlinked, stage === 'held-claim' ? 0 : 1)
      assert.equal(existsSync(join(saved.directory, 'recording.json')), stage === 'held-claim')
      console.log(`PASS actual competing ${stage} executor preserves exact claimed generation and deletion counts`)
    }
    else if (mode === 'finish') await as(saved.token, async () => {
      let current = await purge.readPublicSafetyPurge(saved.key, saved.purgeKey)
      if (current.state === 'blocked') { await purge.retryPublicSafetyPurge(saved.key, saved.purgeKey, { expectedPurgeVersion: current.version, expectedRetentionVersion: current.retentionVersion, requestId: randomUUID() }); current = await purge.readPublicSafetyPurge(saved.key, saved.purgeKey) }
      for (let n = 0; n < 60 && current.state !== 'complete'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: saved.purgeKey }); current = await purge.readPublicSafetyPurge(saved.key, saved.purgeKey); assert.notEqual(current.state, 'blocked') }
      assert.equal(current.state, 'complete'); assert.equal(current.completed.fileInodesVerifiedAbsent, 6); assert.equal(current.completed.namesUnlinked, 6); assert.equal(current.completed.namesInitiallyAbsent, 1); assert.equal(current.completed.namesAbsenceReconciled, 0)
      assert.equal(existsSync(saved.directory), false)
      console.log(`PASS actual competing ${stage} executors converge without duplicate deltas or invented completion`)
    })
    else throw new Error('Unknown race fixture mode')
  }
}
finally { await database.closeDatabaseConnection() }
