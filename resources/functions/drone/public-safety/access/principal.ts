import { Auth } from '@stacksjs/auth/authentication'
import { withRbac } from '@stacksjs/auth/rbac'
import { requestToken } from '@stacksjs/auth/request-token'
import { createBqbRbacStore } from '@stacksjs/auth/rbac-store-bqb'
import { DEFAULT_TOKENABLE_TYPE, findToken } from '@stacksjs/auth/tokens'
import { getCurrentRequest } from '@stacksjs/router'
import { PublicSafetyAccessError } from './errors'

/** Native token-cookie/bearer principal. Session-only identity cannot satisfy this token-scoped phase. */
export async function requirePublicSafetyPrincipal(scope: 'read' | 'coordinate', creating = false) {
  const request = getCurrentRequest()
  const credential = requestToken(request)
  if (!request || !credential || credential.length > 4096) throw new PublicSafetyAccessError(401, 'A valid incident access token is required')
  const user = await Auth.user()
  // findToken and the cache-free SQL store resolve the actual active native transaction connection.
  // Neither request-local Auth ability caches nor process-local Rbac caches authorize a mutation here.
  const token = await findToken(credential)
  const userId = Number(user?.id)
  if (!user || !Number.isSafeInteger(userId) || userId < 1 || !token || token.subjectType !== DEFAULT_TOKENABLE_TYPE || token.subjectId !== userId || token.userId !== userId) throw new PublicSafetyAccessError(401, 'A valid incident access token is required')
  if (token.grantId != null || token.workspaceId != null || token.resources?.length || token.audiences?.length) throw new PublicSafetyAccessError(403, 'Delegated credentials cannot access incidents')
  if (!token.scopes.includes('*') && !token.scopes.includes(`public-safety:${scope}`)) throw new PublicSafetyAccessError(403, 'The token does not permit this incident action')
  const store = createBqbRbacStore()
  if (!store.getUserPermissions) throw new Error('Native permission resolution is unavailable')
  const permissions = await store.getUserPermissions(userId)
  const has = (name: string) => permissions.some(permission => permission.guard_name === 'web' && permission.name === name)
  if (!has('public-safety:access') || creating && !has('public-safety:create')) throw new PublicSafetyAccessError(403, 'Incident platform permission is required')
  const gateUser = withRbac(user)
  // Native Gate's legacy user declaration has an open unknown-field index; retain the real authenticated instance.
  return { userId, tokenId: token.id, user: gateUser as typeof gateUser & Record<string, unknown> }
}
