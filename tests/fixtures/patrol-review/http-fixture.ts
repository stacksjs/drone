import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupPatrolDatabase } from './setup'

export const intent = {
  requestId: '11111111-1111-4111-8111-111111111111', scheduleKey: 'qualification',
  input: { profile: 'nominal', unsignedLocalReview: true, enableCharge: false, decisions: [
    { kind: 'flight', id: 'first', atMs: 2000, dueUtcMs: 1767225600000, decision: 'approve' },
    { kind: 'flight', id: 'second', atMs: 60000, dueUtcMs: 1767225660000, decision: 'approve' },
  ] },
  binding: { vehicleId: 'navigation-vehicle', padId: 'pad', planId: 'local-survey-demo', profile: 'nominal-contact-partial-charge-v1', sessionId: '123', bootId: '55', reference: '55:0,0,0,0,0', origin: '{"latitudeDeg":0,"longitudeDeg":0,"ellipsoidHeightM":100}' },
}
export const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
export async function openNativeFixture(options: Parameters<typeof setupPatrolDatabase>[0] = {}) {
  const context = await setupPatrolDatabase(options)
  const source = resolve(import.meta.dir, '../../..')
  await writeFile(join(context.root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
  const { initializeAuthorization } = await import('@stacksjs/auth/policy')
  await initializeAuthorization()
  const { Rbac } = await import('@stacksjs/auth/rbac')
  const tokens = await import('@stacksjs/auth/tokens')
  const { route } = await import('@stacksjs/router')
  await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
  const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: true })
  const permissions = ['patrol:access', 'patrol:create', 'patrol:read', 'patrol:review', 'patrol:consume']
  for (const permission of permissions) await Rbac.createPermission(permission, 'web')
  async function owner(id?: number) {
    const user = await context.User.create({ name: 'Qualified Owner', email: 'qualified-owner@example.invalid', password: 'temporary-fixture-password' })
    if (id !== undefined) await context.database.db.primary.updateTable('users').set({ id }).where('id', '=', user.id).execute()
    const userId = id ?? user.id
    for (const permission of permissions) await Rbac.givePermission(userId, permission, 'web')
    const token = await tokens.createToken(userId, 'qualification owner', ['patrol:create', 'patrol:read', 'patrol:review', 'patrol:consume'], { withRefreshToken: false })
    return { userId, token }
  }
  async function call(method: string, path: string, credential: string | null, body?: unknown, extras: Record<string, string> = {}) {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { accept: 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extras }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
    const text = await response.text()
    assert(!credential || !text.includes(credential))
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(text.endsWith('\n'), true)
    return { status: response.status, text, data: JSON.parse(text), headers: response.headers }
  }
  return { ...context, source, route, server, Rbac, tokens, permissions, owner, call, close: async () => {
    await server.stop(true)
    await context.database.closeDatabaseConnection()
  } }
}
