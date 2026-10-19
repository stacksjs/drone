import { retainedPreview } from '../../helpers/public-safety-retained'
import assert from 'node:assert/strict'
import { rename, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { database, actor, as, access, records, managed, retention, root } from './managed-context'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
try {
  const coordinator = await actor('managed-upgrade')
  await as(coordinator.token.plainTextToken, async () => {
    const config = examplePublicSafetyConfig(); config.id = 'managed-upgrade'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
    const run = simulatePublicSafety({ config, seconds: 10 })
    await access.createPublicSafetyIncident({ config })
    const source = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording: run })
    const tables = ['public_safety_incidents', 'public_safety_incident_members', 'public_safety_audits', 'public_safety_sources']
    const oldRows = await Promise.all(tables.map(table => database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute()))
    for (const name of await readdir(join(root, 'pending-managed-migrations'))) await rename(join(root, 'pending-managed-migrations', name), join(root, 'database/migrations', name))
    const result = await database.runDatabaseMigration(); if (result.isErr) throw result.error
    assert.deepEqual(await Promise.all(tables.map(table => database.db.primary.selectFrom(table).selectAll().orderBy('id', 'asc').execute())), oldRows)
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    const preview = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
    await retention.enrollPublicSafetyRetention(config.id, { expectedVersion: 2, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() })
    const created = await managed.createPublicSafetyManagedDataset(config.id, { expectedVersion: 3, expectedRetentionVersion: 1, sourceDigest: source.source.digest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() })
    assert.equal(created.artifact.state, 'complete')
    for (let pass = 0; pass < 2; pass++) { const generated = await database.generateMigrations(); if (generated.isErr) throw generated.error; assert.equal((await database.pendingMigrationOperations()).length, 0) }
  })
  console.log('PASS managed generated schema upgrade preserves actual old source, membership and audit rows and is twice a no-op')
}
finally { await database.closeDatabaseConnection() }
