import assert from 'node:assert/strict'
import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'

const { root, database, User } = await setupIncidentDatabase()
const source = resolve(import.meta.dir, '../../..')
try {
  const account = await User.create({ name: 'Provision Operator', email: 'provision@example.invalid', password: 'native-fixture-password' })
  await mkdir(join(root, 'app/Commands'), { recursive: true })
  await cp(join(source, 'app/Commands/PublicSafetyAccess.ts'), join(root, 'app/Commands/PublicSafetyAccess.ts'))
  await cp(join(source, 'resources/functions/drone/public-safety/access/provision.ts'), join(root, 'resources/functions/drone/public-safety/access/provision.ts'))
  const run = async (args: string[], userId = account.id) => {
    const child = Bun.spawn([join(source, 'buddy'), 'public-safety:access', String(userId), ...args], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, stdout, stderr }
  }
  const output = join(root, 'private-credential')
  const result = await run(['--mode', 'coordinate', '--create-incidents', '--minutes', '1', '--output', output])
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
  const credential = JSON.parse(await readFile(join(output, 'token.json'), 'utf8'))
  assert.equal(result.stdout.includes(credential.token), false)
  assert.equal(result.stderr.includes(credential.token), false)
  assert.equal((await stat(output)).mode & 0o777, 0o700)
  assert.equal((await stat(join(output, 'token.json'))).mode & 0o777, 0o600)
  const { findToken } = await import('@stacksjs/auth/tokens')
  const token = await findToken(credential.token)
  assert(token)
  assert.deepEqual(token.scopes, ['public-safety:read', 'public-safety:coordinate'])
  assert.equal(token.subjectId, account.id)
  const { createBqbRbacStore } = await import('@stacksjs/auth/rbac-store-bqb')
  const permissions = await createBqbRbacStore().getUserPermissions!(account.id)
  assert(permissions.some(permission => permission.name === 'public-safety:access' && permission.guard_name === 'web'))
  assert(permissions.some(permission => permission.name === 'public-safety:create' && permission.guard_name === 'web'))
  assert.equal(credential.expiresInSeconds, 60)
  const count = (await database.db.primary.selectFrom('oauth_access_tokens').selectAll().execute()).length
  assert.equal((await run(['--mode', 'coordinate', '--output', output])).code, 1)
  assert.equal((await database.db.primary.selectFrom('oauth_access_tokens').selectAll().execute()).length, count)
  for (const options of [['--minutes', '0'], ['--minutes', '61'], ['--minutes', 'NaN'], ['--mode', 'pilot'], ['--create-incidents']]) {
    const rejectedPath = join(root, 'invalid-credential')
    assert.equal((await run([...options, '--output', rejectedPath])).code, 1)
    assert.equal(await stat(rejectedPath).catch(() => null), null)
    assert.equal((await database.db.primary.selectFrom('oauth_access_tokens').selectAll().execute()).length, count)
  }
  assert.equal(result.stdout.includes('native-fixture-password'), false)
  const original = await readFile(join(output, 'token.json'), 'utf8')
  assert.equal((await run(['--output', output])).code, 1)
  assert.equal(await readFile(join(output, 'token.json'), 'utf8'), original)
  const missingOutput = join(root, 'missing-account')
  assert.equal((await run(['--output', missingOutput], 2147483647)).code, 1)
  assert.equal(await stat(missingOutput).catch(() => null), null)
  const other = await User.create({ name: 'Read Only Operator', email: 'read@example.invalid', password: 'another-native-password' })
  const readOutput = join(root, 'read-credential')
  assert.equal((await run(['--output', readOutput], other.id)).code, 0)
  const readCredential = JSON.parse(await readFile(join(readOutput, 'token.json'), 'utf8'))
  assert.deepEqual((await findToken(readCredential.token))?.scopes, ['public-safety:read'])
  const effective = await createBqbRbacStore().getUserPermissions!(other.id)
  assert.deepEqual(effective.filter(permission => permission.guard_name === 'web').map(permission => permission.name), ['public-safety:access'])
  // A real native-token storage failure must roll back the newly assigned platform grant.
  const failed = await User.create({ name: 'Failure Operator', email: 'failure@example.invalid', password: 'third-native-password' })
  await database.db.unsafe("CREATE TRIGGER reject_fixture_token BEFORE INSERT ON oauth_access_tokens BEGIN SELECT RAISE(ABORT, 'fixture-token-storage-failure'); END")
  const failedOutput = join(root, 'failed-credential')
  assert.equal((await run(['--mode', 'coordinate', '--create-incidents', '--output', failedOutput], failed.id)).code, 1)
  assert.equal(await stat(failedOutput).catch(() => null), null)
  assert.equal((await createBqbRbacStore().getUserPermissions!(failed.id)).length, 0)
  await database.db.unsafe('DROP TRIGGER reject_fixture_token')
  console.log('PASS native Buddy incident provisioning with private credentials and persisted scoped grants')
}
finally { await database.closeDatabaseConnection() }
