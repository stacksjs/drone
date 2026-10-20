import { Auth } from '@stacksjs/auth/authentication'
import { Gate } from '@stacksjs/auth/gate'
import { withRbac } from '@stacksjs/auth/rbac'
import { createBqbRbacStore } from '@stacksjs/auth/rbac-store-bqb'
import { requestToken } from '@stacksjs/auth/request-token'
import { DEFAULT_TOKENABLE_TYPE, findToken } from '@stacksjs/auth/tokens'
import { getCurrentRequest } from '@stacksjs/router'
import { databaseId, PatrolReviewError } from './contract'

type Operation = 'create' | 'read' | 'review' | 'approve' | 'consume'
type Captured = { credential: string, userId: number, tokenId: number }
/** Private application policy. A caller-supplied DTO never provides the captured principal. */
export async function requirePatrolPrincipal(operation: Operation, captured?: Captured) {
  const request = getCurrentRequest(), credential = captured?.credential ?? requestToken(request)
  if (!request || !credential || credential.length > 4096) throw new PatrolReviewError(401)
  const user = await Auth.user(), token = await findToken(credential)
  let userId: number, tokenId: number
  try {
    userId = databaseId(user?.id)
    tokenId = databaseId(token?.id)
  }
  catch { throw new PatrolReviewError(401) }
  if (!user || !token || token.subjectType !== DEFAULT_TOKENABLE_TYPE || token.subjectId !== userId || token.userId !== userId || captured && (captured.userId !== userId || captured.tokenId !== tokenId)) throw new PatrolReviewError(401)
  if (token.grantId != null || token.workspaceId != null || token.resources?.length || token.audiences?.length) throw new PatrolReviewError(403)
  const required = operation === 'approve' ? ['review', 'consume'] : [operation]
  if (!token.scopes.includes('*') && required.some(name => !token.scopes.includes(`patrol:${name}`))) throw new PatrolReviewError(403)
  const store = createBqbRbacStore()
  if (!store.getUserPermissions) throw new PatrolReviewError(500)
  const permissions = await store.getUserPermissions(userId)
  for (const name of ['patrol:access', ...required.map(name => `patrol:${name}`)]) if (!permissions.some(p => p.name === name && p.guard_name === 'web')) throw new PatrolReviewError(403)
  const gateUser = withRbac(user)
  return { credential, userId, tokenId, tokenDeadline: token.expiresAt?.getTime() ?? null, user: gateUser as typeof gateUser & Record<string, unknown> }
}
export async function patrolReviewGate(user: unknown, operation: Operation): Promise<boolean> {
  const current = await requirePatrolPrincipal(operation)
  return !!user && typeof user === 'object' && 'id' in user && user.id === current.userId
}
export async function authorizePatrol(operation: Operation, captured?: Captured) {
  const principal = await requirePatrolPrincipal(operation, captured)
  if (!await Gate.allows(`patrol:${operation}`, principal.user)) throw new PatrolReviewError(403)
  return principal
}
