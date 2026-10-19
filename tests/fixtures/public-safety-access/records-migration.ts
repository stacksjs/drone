import assert from 'node:assert/strict'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
const added = ['1789486698566-create-public_safety_observations-table.sql', '1789486698567-create-public_safety_reviews-table.sql', '1789486698568-create-public_safety_sources-table.sql', '1789486698569-auto-misc.sql']
const { database, User, root } = await setupIncidentDatabase({
  async prepareMigrations(directory) {
    await mkdir(join(directory, 'pending-owned-migrations'))
    for (const name of added) await rename(join(directory, 'database/migrations', name), join(directory, 'pending-owned-migrations', name))
  },
})
const { createPublicSafetyIncident, changePublicSafetyMembership, readPublicSafetyIncident, readPublicSafetyAudit } = await import('../../../resources/functions/drone/public-safety/access/service')
const { registerPublicSafetySource } = await import('../../../resources/functions/drone/public-safety/access/records')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
try {
  const coordinator = await User.create({ name: 'Migration Coordinator', email: 'migration-coordinator@example.invalid', password: 'temporary-fixture-password' })
  const member = await User.create({ name: 'Existing Member', email: 'existing-member@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(coordinator.id, permission, 'web') }
  const credential = await createToken(coordinator.id, 'upgrade fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  const config = examplePublicSafetyConfig()
  config.id = 'upgrade-records'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${credential.plainTextToken}` } }) as Parameters<typeof enhanceRequest>[0]), async () => {
    await createPublicSafetyIncident({ config })
    await changePublicSafetyMembership(config.id, { expectedVersion: 1, userId: member.id, role: 'pilot' })
    const before = await readPublicSafetyIncident(config.id), audit = await readPublicSafetyAudit(config.id)
    // The migration runner is the seam here. Check actual IDs, bytes, constraints and integrity too.
    const oldRows = await database.db.primary.selectFrom('public_safety_audits').selectAll().orderBy('id', 'asc').execute()
    for (const name of await readdir(join(root, 'pending-owned-migrations'))) await rename(join(root, 'pending-owned-migrations', name), join(root, 'database/migrations', name))
    const migrated = await database.runDatabaseMigration()
    if (migrated.isErr) throw migrated.error
    assert.deepEqual(await readPublicSafetyIncident(config.id), before)
    assert.deepEqual(await readPublicSafetyAudit(config.id), audit)
    assert.deepEqual(await database.db.primary.selectFrom('public_safety_audits').selectAll().orderBy('id', 'asc').execute(), oldRows)
    assert.deepEqual(await database.db.unsafe('PRAGMA foreign_key_check'), [])
    assert.deepEqual(await database.db.unsafe('PRAGMA integrity_check'), [{ integrity_check: 'ok' }])
    const old = oldRows[0]!
    const duplicate = { incident_id: old.incident_id, sequence: old.sequence, actor_id: old.actor_id, action: old.action, target_user_id: old.target_user_id, at_iso: old.at_iso, details_json: old.details_json, created_at: old.created_at, updated_at: old.updated_at }
    await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values(duplicate).execute(), /UNIQUE constraint failed/)
    await assert.rejects(() => database.db.primary.insertInto('public_safety_audits').values({ ...duplicate, incident_id: 2147483647 }).execute(), /FOREIGN KEY constraint failed/)
    const registered = await registerPublicSafetySource(config.id, { expectedVersion: 2, recording: simulatePublicSafety({ config, seconds: 16 }) })
    assert.equal(registered.incident.version, 3)
    assert.equal((await readPublicSafetyAudit(config.id)).entries.at(-1)?.action, 'source-registered')
    for (let pass = 0; pass < 2; pass++) {
      const generated = await database.generateMigrations()
      if (generated.isErr) throw generated.error
      assert.equal((await database.pendingMigrationOperations()).length, 0)
    }
  })
  console.log('PASS native access data survives generated observation schema upgrade')
}
finally { await database.closeDatabaseConnection() }
