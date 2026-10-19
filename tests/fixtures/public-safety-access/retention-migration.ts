import { retainedPreview } from '../../helpers/public-safety-retained'
import assert from 'node:assert/strict'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
const { database, User, root } = await setupIncidentDatabase({
  async prepareMigrations(directory) {
    await mkdir(join(directory, 'pending-custody-migrations'))
    for (const name of await readdir(join(directory, 'database/migrations'))) if (/^178948669857[01]-/.test(name)) await rename(join(directory, 'database/migrations', name), join(directory, 'pending-custody-migrations', name))
  },
})
const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const records = await import('../../../resources/functions/drone/public-safety/access/records')
const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
try {
  const user = await User.create({ name: 'Custody Upgrade', email: 'custody-upgrade@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(user.id, permission, 'web') }
  const token = (await createToken(user.id, 'custody upgrade', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  await runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), async () => {
    const config = examplePublicSafetyConfig(); config.id = 'custody-upgrade'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
    await access.createPublicSafetyIncident({ config })
    const source = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording: simulatePublicSafety({ config, seconds: 10 }) })
    const point = await records.appendPublicSafetyObservation(config.id, { expectedVersion: 2, sourceDigest: source.source.digest, captureId: 'photo-0001', modality: 'visible', pixel: { x: 0, y: 71 }, note: 'Upgrade private observation retained', uncertaintyNote: 'Upgrade uncertainty retained' })
    const review = await records.appendPublicSafetyReview(config.id, point.observation.id, { expectedVersion: 3, sourceDigest: source.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Upgrade private review retained' })
    const before = { incident: await access.readPublicSafetyIncident(config.id), source: await records.readPublicSafetySource(config.id, source.source.digest), observation: await records.readPublicSafetyObservation(config.id, point.observation.id), reviews: await records.listPublicSafetyReviews(config.id, point.observation.id), audit: await access.readPublicSafetyAudit(config.id) }
    const oldRows = await database.db.primary.selectFrom('public_safety_audits').selectAll().orderBy('id', 'asc').execute()
    for (const name of await readdir(join(root, 'pending-custody-migrations'))) await rename(join(root, 'pending-custody-migrations', name), join(root, 'database/migrations', name))
    const migrated = await database.runDatabaseMigration(); if (migrated.isErr) throw migrated.error
    assert.deepEqual({ incident: await access.readPublicSafetyIncident(config.id), source: await records.readPublicSafetySource(config.id, source.source.digest), observation: await records.readPublicSafetyObservation(config.id, point.observation.id), reviews: await records.listPublicSafetyReviews(config.id, point.observation.id), audit: await access.readPublicSafetyAudit(config.id) }, before)
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_audits').selectAll().orderBy('id', 'asc').execute(), oldRows)
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_retention_scopes').selectAll().execute(), [])
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_retention_events').selectAll().execute(), [])
    const preview = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
    assert.deepEqual(preview.counts, { sources: 1, observations: 1, reviews: 1 })
    const enrollment = await retention.enrollPublicSafetyRetention(config.id, { expectedVersion: 4, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: crypto.randomUUID() })
    assert.equal(enrollment.scope.contentDeletionPerformed, false)
    assert.equal((await records.readPublicSafetySource(config.id, source.source.digest)).source.digest, source.source.digest)
    assert.deepEqual(await records.readPublicSafetyObservation(config.id, point.observation.id), before.observation)
    assert.deepEqual((await records.listPublicSafetyReviews(config.id, point.observation.id)).entries, [review.review])
    const event = (await database.db.primary.selectFrom('public_safety_retention_events').selectAll().execute())[0]!
    const { id, ...duplicate } = event
    assert(id)
    await assert.rejects(() => database.db.primary.insertInto('public_safety_retention_events').values(duplicate).execute(), /UNIQUE constraint failed/)
    await assert.rejects(() => database.db.primary.insertInto('public_safety_retention_events').values({ ...duplicate, scope_id: 2147483647 }).execute(), /FOREIGN KEY constraint failed/)
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    for (let pass = 0; pass < 2; pass++) {
      const generated = await database.generateMigrations(); if (generated.isErr) throw generated.error
      assert.equal((await database.pendingMigrationOperations()).length, 0)
    }
  })
  console.log('PASS native custody upgrade preserves old content without automatic enrollment')
}
finally { await database.closeDatabaseConnection() }
