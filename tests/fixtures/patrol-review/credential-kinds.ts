import assert from 'node:assert/strict'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { openNativeFixture, intent } from './http-fixture'

// Genuine local native credential issuance. No external OAuth service or credential mocks.
async function main() {
  const context = await openNativeFixture({
    prepare: root => cp(join(import.meta.dir, 'session-model.ts'), join(root, 'app/Models/Session.ts')),
  })
  try {
    const { generateMigrations } = await import('@stacksjs/database/migrations')
    assert((await generateMigrations()).isOk)
    assert((await context.database.runDatabaseMigration()).isOk)
    const { token, userId } = await context.owner()
    const endpoint = '/api/patrol/reviews'
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, intent)).status, 201)
    const path = `${endpoint}/${intent.scheduleKey}`
    const baseline = (await context.call('GET', path, token.plainTextToken)).data
    const { sessionLogin, sessionCheck, sessionLogout } = await import('@stacksjs/auth/session-auth')
    const session = await sessionLogin('qualified-owner@example.invalid', 'temporary-fixture-password')
    try {
      assert.equal(await sessionCheck(session.sessionId), true)
      const refused = await context.call('GET', path, null, undefined, { cookie: `session_id=${session.sessionId}` })
      assert.equal(refused.status, 401)
      assert(!refused.text.includes(session.sessionId))
    }
    finally { await sessionLogout(session.sessionId) }

    const { resolveOAuthProviderConfig } = await import('@stacksjs/auth/oauth-provider')
    const { registerOAuthClient } = await import('@stacksjs/auth/oauth-client-registration')
    const { createOAuthGrant } = await import('@stacksjs/auth/oauth-grants')
    const { issueAuthorizationCode } = await import('@stacksjs/auth/oauth-authorization-codes')
    const { createS256CodeChallenge } = await import('@stacksjs/auth/oauth-pkce')
    const { exchangeOAuthAuthorizationCode } = await import('@stacksjs/auth/oauth-token-exchange')
    const scopes = ['patrol:create', 'patrol:read', 'patrol:review', 'patrol:consume']
    const provider = resolveOAuthProviderConfig({ enabled: true, issuer: 'https://patrol.invalid', scopes: Object.fromEntries(scopes.map(scope => [scope, { description: 'Patrol fixture scope' }])) })
    assert(provider)
    const redirectUri = 'https://fixture-client.invalid/callback'
    const { client } = await registerOAuthClient(provider, userId, { name: 'Patrol fixture', type: 'public', tokenEndpointAuthMethod: 'none', redirectUris: [redirectUri], grantTypes: ['authorization_code'], scopes, resources: [] })
    const grant = await createOAuthGrant({ clientId: client.id, subjectType: 'users', subjectId: userId, scopes, resources: [], audiences: [] })
    const codeVerifier = 'fixture-code-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const code = await issueAuthorizationCode({ grantId: grant.id, redirectUri, codeChallenge: await createS256CodeChallenge(codeVerifier), lifetimeMs: 60000 })
    const exchanged = await exchangeOAuthAuthorizationCode({ code, clientId: client.id, redirectUri, codeVerifier, accessTokenLifetimeMs: 60000, refreshTokenLifetimeMs: 60000 })
    assert(exchanged.ok)
    assert.equal((await context.tokens.findToken(exchanged.value.accessToken))?.grantId, grant.id)
    assert.equal((await context.call('GET', path, exchanged.value.accessToken)).status, 401)
    assert.equal((await context.call('POST', endpoint, exchanged.value.accessToken, '{')).status, 401)
    assert.deepEqual((await context.call('GET', path, token.plainTextToken)).data, baseline)
    // eslint-disable-next-line no-console
    console.log('PASS genuine native session and delegated OAuth credentials cannot adopt personal-token patrol authority')
  }
  finally { await context.close() }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
