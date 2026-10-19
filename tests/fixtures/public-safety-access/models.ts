import assert from 'node:assert/strict'
import { setupIncidentDatabase } from './setup'
const { database, User } = await setupIncidentDatabase()
try {
  const password = 'temporary-fixture-password'
  const user = await User.create({ name: 'Incident Operator', email: 'operator@example.invalid', password })
  const { verifyHash } = await import('@stacksjs/security')
  const stored = await database.db.primary.selectFrom('users').selectAll().where('id', '=', user.id).executeTakeFirst()
  assert(stored && stored.password !== password)
  assert.equal(await verifyHash(password, String(stored.password)), true)
  assert.equal(JSON.stringify(user).includes(password), false)
  assert.equal(JSON.stringify(user).includes(String(stored.password)), false)
  const definition = User.getDefinition()
  assert.equal(definition.traits.useApi, false)
  assert.equal(definition.dashboard.enabled, false)
  assert.equal((await database.pendingMigrationOperations()).length, 0)
  console.log('PASS native incident schema and account security')
}
finally { await database.closeDatabaseConnection() }
