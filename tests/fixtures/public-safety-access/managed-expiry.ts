import { retainedPreview } from '../../helpers/public-safety-retained'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { database, actor, as, seed, managed, retention, status } from './managed-context'
try {
  const coordinator = await actor('managed-held-expiry')
  await as(coordinator.token.plainTextToken, async () => {
    const fixture = await seed('managed-held-expiry', 60000), key = fixture.config.id
    const created = await managed.createPublicSafetyManagedDataset(key, fixture.body)
    const file = (await managed.readPublicSafetyManagedArtifact(key, created.artifact.key)).files[0]!
    await retention.reviewPublicSafetyRetentionHold(key, { expectedRetentionVersion: 1, decision: 'retain', caseReference: 'fixture:preserve', reviewDueAt: new Date(Date.now() + 86400000).toISOString(), requestId: randomUUID() })
    assert.equal((await managed.readPublicSafetyManagedArtifactFile(key, created.artifact.key, file.id)).bytes.length, file.bytes)
    const remaining = Date.parse(fixture.config.retention.expiresAt) - Date.now() + 5
    if (remaining > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, remaining)
    for (const action of [
      () => managed.listPublicSafetyManagedArtifacts(key),
      () => managed.readPublicSafetyManagedArtifact(key, created.artifact.key),
      () => managed.readPublicSafetyManagedArtifactFile(key, created.artifact.key, file.id),
      () => managed.listPublicSafetyManagedArtifactEvents(key, created.artifact.key),
      () => managed.createPublicSafetyManagedDataset(key, fixture.body),
      () => managed.reconcilePublicSafetyManagedArtifact(key, created.artifact.key, { expectedVersion: created.artifact.incidentVersion + 1, expectedArtifactVersion: 3, requestId: randomUUID() }),
    ]) await assert.rejects(action, status(404))
    const preview = retainedPreview(await retention.previewPublicSafetyRetention(key)), scope = await retention.readPublicSafetyRetention(key)
    assert.equal(preview.expired, true); assert.equal(preview.managedArtifactCount, 1); assert.equal(preview.counts.sources, 1)
    assert(!('purged' in scope))
    assert.equal(scope.holdState, 'held'); assert.equal(scope.expired, true)
    const minimal = JSON.stringify({ preview, scope })
    for (const forbidden of [created.artifact.key, fixture.source.digest, file.filename, 'target_path', 'receipt_json', 'identity_json', 'sourceDigest', 'artifactKey']) assert(!minimal.includes(forbidden))
    assert.equal(preview.purgeImplemented, false); assert.equal(preview.contentDeletionPerformed, false)
  })
  console.log('PASS real wall-clock held expiry denies all managed content and retains minimized custody aggregate')
}
finally { await database.closeDatabaseConnection() }
