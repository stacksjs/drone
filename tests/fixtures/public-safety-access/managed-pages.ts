import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { database, actor, as, seed, managed, access, retention } from './managed-context'
try {
  const coordinator = await actor('managed-pages')
  await as(coordinator.token.plainTextToken, async () => {
    const fixture = await seed('managed-pages'), key = fixture.config.id
    const originalScope = await database.db.primary.selectFrom('public_safety_retention_scopes').selectAll().executeTakeFirst()
    const created = [], start = performance.now()
    for (let index = 0; index < 101; index++) {
      const result = await managed.createPublicSafetyManagedDataset(key, { ...fixture.body, expectedVersion: 3 + 3 * index, requestId: randomUUID() })
      created.push(result.artifact.key)
    }
    const first = await managed.listPublicSafetyManagedArtifacts(key, { limit: 100 })
    assert.equal(first.entries.length, 100); assert.equal(first.hasMore, true)
    const second = await managed.listPublicSafetyManagedArtifacts(key, { afterId: first.cursor, limit: 100 })
    assert.equal(second.entries.length, 1); assert.equal(second.hasMore, false)
    assert.deepEqual([...first.entries, ...second.entries].map(item => item.key), created)
    const artifactKey = created[0]!
    let version = 3, common = 306
    for (let index = 0; index < 51; index++) {
      const result = await managed.reconcilePublicSafetyManagedArtifact(key, artifactKey, { expectedVersion: common, expectedArtifactVersion: version, requestId: randomUUID() })
      version = result.artifact.version; common = result.artifact.incidentVersion
    }
    const events = await managed.listPublicSafetyManagedArtifactEvents(key, artifactKey, { limit: 100 })
    assert.equal(events.entries.length, 100); assert.equal(events.hasMore, true)
    const remainder = await managed.listPublicSafetyManagedArtifactEvents(key, artifactKey, { afterSequence: events.cursor, limit: 100 })
    assert.equal(remainder.entries.length, 5); assert.equal(remainder.hasMore, false)
    assert.deepEqual([...events.entries, ...remainder.entries].map(event => event.sequence), Array.from({ length: 105 }, (_, index) => index + 1))
    let sourceReads = 0
    const unhook = registerPersistentQueryHooks({ onQueryStart(event) { if (/canonical_json/i.test(event.sql)) sourceReads++ } })
    try { await managed.listPublicSafetyManagedArtifacts(key); await managed.readPublicSafetyManagedArtifact(key, artifactKey); await managed.listPublicSafetyManagedArtifactEvents(key, artifactKey) }
    finally { unhook() }
    assert.equal(sourceReads, 0, 'metadata discovery does not reload or replay canonical recording')
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_retention_scopes').selectAll().executeTakeFirst(), originalScope, 'artifact events never rewrite original custody acceptance or hold sequence')
    assert.equal((await retention.previewPublicSafetyRetention(key)).managedArtifactCount, 101)
    assert.equal((await access.readPublicSafetyIncident(key)).version, 408)
    console.log(`PASS actual101managed artifacts and105events paginate without source replay; publication+read-only history took ${(performance.now() - start).toFixed(1)}ms`)
  })
}
finally { await database.closeDatabaseConnection() }
