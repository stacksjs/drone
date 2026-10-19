import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'

const { database, User, root } = await setupIncidentDatabase({
  async prepare(directory) {
    // A separate native authenticatable owner, inheriting User's credential contract.
    await writeFile(join(directory, 'app/Models/IncidentOperator.ts'), "import { extendModel } from '@stacksjs/orm'\nimport User from './User'\nexport default extendModel(User, { name: 'IncidentOperator', table: 'incident_operators' })\n")
  },
})
const { Auth } = await import('@stacksjs/auth/authentication')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken, findToken } = await import('@stacksjs/auth/tokens')
const { resolveOAuthProviderConfig } = await import('@stacksjs/auth/oauth-provider')
const { registerOAuthClient } = await import('@stacksjs/auth/oauth-client-registration')
const { createOAuthGrant } = await import('@stacksjs/auth/oauth-grants')
const { issueAuthorizationCode } = await import('@stacksjs/auth/oauth-authorization-codes')
const { createS256CodeChallenge } = await import('@stacksjs/auth/oauth-pkce')
const { exchangeOAuthAuthorizationCode } = await import('@stacksjs/auth/oauth-token-exchange')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
const { createPublicSafetyIncident, readPublicSafetyIncident, readPublicSafetyAudit, closePublicSafetyIncident, PublicSafetyAccessError } = await import('../../../resources/functions/drone/public-safety/access/service')
const managed = await import('../../../resources/functions/drone/public-safety/managed/service')
const { publicSafetyManagedGate } = await import('../../../resources/functions/drone/public-safety/managed/policy')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of ['read', 'create', 'events', 'reconcile'] as const) Gate.define(`public-safety:managed-${ability}`, (user, key) => publicSafetyManagedGate(user, key, ability))
for (const ability of ['view', 'audit', 'manage-members', 'close'] as const) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
const as = <T>(credential: string, action: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${credential}` } }) as Parameters<typeof enhanceRequest>[0]), action)
const denied = (error: unknown) => error instanceof PublicSafetyAccessError && error.status === 401

try {
  const generated = await database.generateMigrations()
  if (generated.isErr) throw generated.error
  const migrated = await database.runDatabaseMigration()
  if (migrated.isErr) throw migrated.error
  assert.equal((await database.pendingMigrationOperations()).length, 0)
  const coordinator = await User.create({ name: 'Credential Coordinator', email: 'credential-coordinator@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) {
    await Rbac.createPermission(permission, 'web')
    await Rbac.givePermission(coordinator.id, permission, 'web')
  }
  const scopes = ['public-safety:read', 'public-safety:coordinate']
  const personal = await createToken(coordinator.id, 'ordinary coordinator', scopes, { withRefreshToken: false })
  const config = examplePublicSafetyConfig()
  config.id = 'native-credential-boundaries'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const before = await as(personal.plainTextToken, () => createPublicSafetyIncident({ config }))
  const beforeAudit = await as(personal.plainTextToken, () => readPublicSafetyAudit(config.id))

  const Operator = (await import(join(root, 'app/Models/IncidentOperator.ts'))).default
  const operator = await Operator.create({ name: 'Non-user Operator', email: 'operator@example.invalid', password: 'temporary-fixture-password' })
  assert.equal(operator.id, coordinator.id, 'matching numeric ids must not let a non-user owner impersonate the authorized user')
  const nonUser = await createToken(operator.id, 'non-user personal credential', scopes, { tokenableType: 'incident_operators', withRefreshToken: false })
  const foundNonUser = await findToken(nonUser.plainTextToken)
  assert(foundNonUser)
  assert.equal(foundNonUser.subjectType, 'incident_operators')
  assert.equal(foundNonUser.subjectId, operator.id)
  assert.deepEqual(foundNonUser.scopes, scopes)
  assert.equal((await Operator.find(operator.id)).email, 'operator@example.invalid')

  const provider = resolveOAuthProviderConfig({ enabled: true, issuer: 'https://incident.invalid', scopes: { 'public-safety:read': { description: 'Read incident scope' }, 'public-safety:coordinate': { description: 'Coordinate incident scope' } } })
  assert(provider)
  const redirectUri = 'https://fixture-client.invalid/callback'
  const { client } = await registerOAuthClient(provider, coordinator.id, { name: 'Native delegated fixture', type: 'public', tokenEndpointAuthMethod: 'none', redirectUris: [redirectUri], grantTypes: ['authorization_code'], scopes, resources: [] })
  // Published native APIs persist approved consent, issue a PKCE-bound code and exchange it.
  const grant = await createOAuthGrant({ clientId: client.id, subjectType: 'users', subjectId: coordinator.id, scopes, resources: [], audiences: [] })
  const codeVerifier = 'fixture-code-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const code = await issueAuthorizationCode({ grantId: grant.id, redirectUri, codeChallenge: await createS256CodeChallenge(codeVerifier), lifetimeMs: 60000 })
  const exchanged = await exchangeOAuthAuthorizationCode({ code, clientId: client.id, redirectUri, codeVerifier, accessTokenLifetimeMs: 60000, refreshTokenLifetimeMs: 60000 })
  assert(exchanged.ok)
  const delegated = exchanged.value.accessToken
  const foundDelegated = await findToken(delegated)
  assert(foundDelegated)
  assert.equal(foundDelegated.grantId, grant.id)
  assert.equal(foundDelegated.subjectType, 'users')
  assert.equal(foundDelegated.subjectId, coordinator.id)
  assert.deepEqual(foundDelegated.scopes, scopes)

  for (const credential of [nonUser.plainTextToken, delegated]) {
    await as(credential, async () => {
      // Native ordinary Auth intentionally refuses both otherwise-valid credential classes.
      assert.equal(await Auth.user(), undefined)
      await assert.rejects(() => readPublicSafetyIncident(config.id), denied)
      await assert.rejects(() => readPublicSafetyAudit(config.id), denied)
      await assert.rejects(() => closePublicSafetyIncident(config.id, { expectedVersion: before.version }), denied)
      await assert.rejects(() => createPublicSafetyIncident({ config: { ...config, id: 'credential-forged-create' } }), denied)
      const artifact = '00000000-0000-4000-8000-000000000001', requestId = '00000000-0000-4000-8000-000000000002'
      for (const action of [
        () => managed.listPublicSafetyManagedArtifacts(config.id),
        () => managed.readPublicSafetyManagedArtifact(config.id, artifact),
        () => managed.readPublicSafetyManagedArtifactFile(config.id, artifact, 1),
        () => managed.listPublicSafetyManagedArtifactEvents(config.id, artifact),
        () => managed.createPublicSafetyManagedDataset(config.id, { expectedVersion: 1, expectedRetentionVersion: 1, sourceDigest: 'a'.repeat(64), datasetProfile: 'owned-public-safety-dataset-v1', requestId }),
        () => managed.reconcilePublicSafetyManagedArtifact(config.id, artifact, { expectedVersion: 1, expectedArtifactVersion: 1, requestId }),
      ]) await assert.rejects(action, denied)
    })
    assert.deepEqual(await as(personal.plainTextToken, () => readPublicSafetyIncident(config.id)), before)
    assert.deepEqual(await as(personal.plainTextToken, () => readPublicSafetyAudit(config.id)), beforeAudit)
  }
  console.log('PASS valid native non-user personal and delegated credentials cannot access incidents')
}
finally { await database.closeDatabaseConnection() }
