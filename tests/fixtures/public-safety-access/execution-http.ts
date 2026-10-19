import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'

// The public route seam uses real native auth/Gates/SQLite and the actual file Worker.
// It does not qualify hardware, arbitrary bundled deployment or individual OS thread join.
const { root, database, User } = await setupIncidentDatabase()
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { route } = await import('@stacksjs/router')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents`
try {
  const owner = await User.create({ name: 'Execution owner', email: 'execution-owner@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) {
    await Rbac.createPermission(permission, 'web')
    await Rbac.givePermission(owner.id, permission, 'web')
  }
  const credential = (await createToken(owner.id, 'execution fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  const send = async (method: string, path: string, body?: unknown, token: string | null = credential) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')!.toLowerCase()
    assert(vary.includes('authorization') && vary.includes('cookie'))
    if (response.status >= 400 && method !== 'HEAD') {
      const value = await response.clone().json() as object
      assert.deepEqual(Object.keys(value), ['error'])
      for (const secret of [credential, root, 'SELECT', 'temporary-fixture-password']) assert(!JSON.stringify(value).includes(secret))
    }
    return response
  }
  const config = examplePublicSafetyConfig(); config.id = 'execution-wire'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  assert.equal((await send('POST', '', { config })).status, 201)
  const workspace = await send('GET', '/execution-wire/workspace')
  assert.equal(workspace.status, 200)
  const { scope } = await workspace.json() as { scope: string }
  const path = `/execution-wire/workspace/execution?scope=${scope}`
  const empty = await send('GET', path)
  assert.equal(empty.status, 200, 'Execution status route exists under real native authority')
  assert.equal(await empty.json(), null)
  const head = await send('HEAD', path)
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal(await (await send('GET', path)).json(), null, 'GET/HEAD do not start execution')
  console.log(`PASS native execution HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
