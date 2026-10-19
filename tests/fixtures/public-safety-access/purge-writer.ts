import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { actor, as, seed, database, managed, root, status } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
const mode = process.argv[2], savedPath = join(root, 'purge-writer.json'), pausedPath = join(root, 'purge-writer-paused.json')
function tree(directory: string) { return existsSync(directory) ? readdirSync(directory, { recursive: true }).map(name => { const stat = lstatSync(join(directory, String(name)), { bigint: true }); return [String(name), String(stat.ino), String(stat.size)] }) : [] }
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  if (mode === 'writer') {
    const coordinator = await actor('purge-writer-coordinator')
    await as(coordinator.token.plainTextToken, async () => {
      const key = 'purge-writer', fixture = await seed(key, 10000), originalNow = Date.now, admittedAt = Date.now()
      writeFileSync(savedPath, JSON.stringify({ key, token: coordinator.token.plainTextToken, expiresAt: fixture.config.retention.expiresAt }))
      let ownershipSeen = false, paused = false
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (sql.startsWith('insert into public_safety_managed_artifact_events') && event.params?.includes('ownership-recorded')) ownershipSeen = true
        if (!ownershipSeen || paused || !sql.startsWith('select distinct permissions')) return
        paused = true; writeFileSync(pausedPath, JSON.stringify({ pid: process.pid })); process.kill(process.pid, 'SIGSTOP')
        // Explicit controlled wall-clock rollback in this old writer process only. Freeze/CAS must still refuse publication.
        Date.now = () => admittedAt
      } })
      try { await assert.rejects(() => managed.createPublicSafetyManagedDataset(key, fixture.body), status(409)); assert(paused) }
      finally { unhook(); Date.now = originalNow }
      console.log('PASS actual stopped B live writer refuses payload after accepted freeze despite controlled clock rollback')
    })
  }
  else {
    const saved = JSON.parse(readFileSync(savedPath, 'utf8'))
    await as(saved.token, async () => {
      if (mode === 'accept') {
        const wait = Date.parse(saved.expiresAt) - Date.now() + 20
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
        const artifact = (await database.db.primary.selectFrom('public_safety_managed_artifacts').select(['target_path', 'state']).executeTakeFirst())!
        assert.equal(artifact.state, 'prepared')
        const before = tree(artifact.target_path as string); assert(before.length > 0); assert(before.filter(entry => entry[0] && !String(entry[0]).endsWith('images')).every(entry => entry[2] === '0'))
        const preview = await purge.previewPublicSafetyPurge(saved.key), accepted = await purge.acceptPublicSafetyPurge(saved.key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
        writeFileSync(join(root, 'purge-writer-accepted.json'), JSON.stringify({ purgeKey: accepted.purge.purgeKey, directory: artifact.target_path }))
        // The actual stopped process remains alive here; native visibility is used without a bypass.
        let current = accepted.purge
        for (let n = 0; n < 60 && current.state !== 'complete' && current.state !== 'blocked'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(saved.key, current.purgeKey) }
        assert.equal(current.dbState, 'complete')
        if (current.state === 'blocked') { assert.equal(current.outcomeCode, 'inspection-unavailable'); assert.deepEqual(tree(artifact.target_path as string), before) }
        else assert.equal(current.state, 'complete')
        writeFileSync(join(root, 'purge-writer-after-accept.json'), JSON.stringify(tree(artifact.target_path as string)))
        console.log('PASS actual purge acceptance freezes committed prepared B inventory while old writer is OS stopped')
      }
      else if (mode === 'finish') {
        const accepted = JSON.parse(readFileSync(join(root, 'purge-writer-accepted.json'), 'utf8'))
        assert.deepEqual(tree(accepted.directory), JSON.parse(readFileSync(join(root, 'purge-writer-after-accept.json'), 'utf8')), 'Resumed old live writer must not restore or alter accepted payload')
        let current = await purge.readPublicSafetyPurge(saved.key, accepted.purgeKey)
        if (current.state === 'blocked') { await purge.retryPublicSafetyPurge(saved.key, current.purgeKey, { expectedPurgeVersion: current.version, expectedRetentionVersion: current.retentionVersion, requestId: randomUUID() }); current = await purge.readPublicSafetyPurge(saved.key, current.purgeKey) }
        for (let n = 0; n < 60 && current.state !== 'complete'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(saved.key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
        assert.equal(current.state, 'complete'); assert.equal(current.completed.observedFileBytes, 0); assert.equal(current.completed.fileInodesVerifiedAbsent, 6); assert.equal(existsSync(accepted.directory), false)
        console.log('PASS actual accepted prepared B purge converges without resuming old payload writer')
      }
      else throw new Error('Unknown writer race fixture mode')
    })
  }
}
finally { await database.closeDatabaseConnection() }
