import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { actor, as, seed, database, managed } from './managed-context'
const purge = await import('../../../resources/functions/drone/public-safety/purge/service')
const { runPublicSafetyPurgeBatch } = await import('../../../resources/functions/drone/public-safety/purge/executor')
const { purgeAbilities, purgePolicy, purgeCoverage, purgeExclusions } = await import('../../../resources/functions/drone/public-safety/purge/types')
const { publicSafetyPurgeGate } = await import('../../../resources/functions/drone/public-safety/purge/policy')
const { Gate } = await import('@stacksjs/auth/gate')
for (const ability of purgeAbilities) Gate.define(`public-safety:purge-${ability}`, (user, key) => publicSafetyPurgeGate(user, key, ability))
assert.equal(process.platform, 'linux'); assert.equal(process.env.PUBLIC_SAFETY_PURGE_NAMESPACE_TEST, '1')
const coordinator = await actor('purge-budget-coordinator')
try {
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  await as(coordinator.token.plainTextToken, async () => {
    const key = 'purge-budget', fixture = await seed(key, 15000)
    let expectedVersion = 3
    const directories: string[] = [], plannedBytes = 20 * 1024 * 1024, plannedHash = createHash('sha256').update(new Uint8Array(plannedBytes).fill(7)).digest('hex')
    for (let count = 0; count < 2; count++) {
      const created = await managed.createPublicSafetyManagedDataset(key, { ...fixture.body, expectedVersion, requestId: randomUUID() }); expectedVersion = created.artifact.incidentVersion
      const row = (await database.db.primary.selectFrom('public_safety_managed_artifacts').selectAll().where('artifact_key', '=', created.artifact.key).executeTakeFirst())!
      const file = (await database.db.primary.selectFrom('public_safety_managed_artifact_files').selectAll().where('artifact_id', '=', row.id).where('role', '=', 'recording').executeTakeFirst())!
      const directory = join(process.env.PUBLIC_SAFETY_MANAGED_ROOT!, created.artifact.key); directories.push(directory)
      // Controlled reconstruction of an owned partial plan, not a public-renderer or crash-window claim.
      const receipt = JSON.parse(row.receipt_json as string), identity = JSON.parse(file.identity_json as string)
      identity.bytes = plannedBytes; identity.sha256 = plannedHash
      const planned = receipt.files.find((entry: { path: string }) => entry.path === identity.path); assert(planned)
      planned.bytes = plannedBytes; planned.sha256 = plannedHash
      truncateSync(identity.path, 0)
      await database.db.primary.updateTable('public_safety_managed_artifact_files').set({ planned_bytes: plannedBytes, sha256: plannedHash, identity_json: JSON.stringify(identity) }).where('id', '=', file.id).execute()
      await database.db.primary.updateTable('public_safety_managed_artifacts').set({ state: 'interrupted', receipt_json: JSON.stringify(receipt), total_planned_bytes: Number(row.total_planned_bytes) - Number(file.planned_bytes) + plannedBytes }).where('id', '=', row.id).execute()
    }
    const wait = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 20
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
    const preview = await purge.previewPublicSafetyPurge(key)
    assert(preview.counts.totalPlannedFileBytes > 33554432)
    const accepted = await purge.acceptPublicSafetyPurge(key, { expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, policyVersion: purgePolicy, coverage: purgeCoverage, inventoryDigest: preview.inventoryDigest, exclusions: purgeExclusions, receiptRetentionDays: 1, requestId: randomUUID() })
    let current = accepted.purge
    for (let n = 0; n < 30 && current.dbState !== 'complete'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey, maxItems: 1 }); current = await purge.readPublicSafetyPurge(key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
    assert.equal(current.dbState, 'complete'); assert.equal(current.completed.fileInodesVerifiedAbsent, 0)
    const purgeId = (await database.db.primary.selectFrom('public_safety_purges').select('id').where('purge_key', '=', current.purgeKey).executeTakeFirst())!.id
    const first = await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey })
    const items = await database.db.primary.selectFrom('public_safety_purge_items').select(['state', 'planned_bytes', 'arm_json']).where('purge_id', '=', purgeId).where('kind', '=', 'file').execute()
    const verified = items.filter(item => item.state === 'verified-absent'), remaining = items.filter(item => item.state === 'planned')
    const reserved = verified.reduce((sum, item) => sum + Number(item.planned_bytes), 0)
    assert(reserved >= plannedBytes && reserved <= 33554432, `Actual first-batch accepted planned-byte sum ${reserved}`)
    assert.equal(first.unitsCommitted, 6, 'First artifact fits but next20MiB recording must not start in same batch')
    assert.equal(remaining.length, 6); assert(remaining.every(item => item.arm_json === null)); assert(existsSync(join(directories[1]!, 'recording.json')))
    for (let n = 0; n < 30 && current.state !== 'complete'; n++) { await runPublicSafetyPurgeBatch({ purgeKey: current.purgeKey }); current = await purge.readPublicSafetyPurge(key, current.purgeKey); assert.notEqual(current.state, 'blocked') }
    assert.equal(current.state, 'complete'); assert.equal(current.completed.fileInodesVerifiedAbsent, 12)
    console.log('PASS controlled owned partial plans enforce cumulative32MiB reservation before next arm and resume in fresh batch')
  })
}
finally { await database.closeDatabaseConnection() }
