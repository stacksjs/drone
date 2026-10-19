import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'

// A fixture-only model generates the native session table; no application session API is installed.
await mkdir(join(process.cwd(), 'app/Models'), { recursive: true })
await writeFile(join(process.cwd(), 'app/Models/Session.ts'), `import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'
export default defineModel({name:'Session',table:'sessions',primaryKey:'id',autoIncrement:false,traits:{useApi:false,useTimestamps:false},attributes:{
id:{required:true,validation:{rule:schema.string()}},userId:{required:true,validation:{rule:schema.number().integer()}},
ipAddress:{validation:{rule:schema.string().optional()}},userAgent:{validation:{rule:schema.string().optional()}},
payload:{required:true,validation:{rule:schema.string()}},lastActivity:{required:true,validation:{rule:schema.number().integer()}},expiresAt:{required:true,validation:{rule:schema.string()}}
}})`)
const { root, database, User } = await setupIncidentDatabase()
const { generateMigrations } = await import('@stacksjs/database/migrations')
const generated = await generateMigrations()
assert(generated.isOk, String(generated.error))
assert((await database.runDatabaseMigration()).isOk)
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken, revokeToken } = await import('@stacksjs/auth/tokens')
const { authCookieName } = await import('@stacksjs/auth/cookie')
const { sessionLogin, sessionCheck } = await import('@stacksjs/auth/session-auth')
const { route } = await import('@stacksjs/router')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
try {
  const password = 'temporary-fixture-password'
  const users = []
  for (const name of ['coordinator', 'observer', 'pilot', 'reviewer', 'custodian', 'outsider']) users.push(await User.create({ name, email: `${name}@example.invalid`, password }))
  const [coordinator, observer, pilot, reviewer, custodian, outsider] = users
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const user of users) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const tokens = new Map<number, string>()
  for (const user of users) tokens.set(user.id, (await createToken(user.id, 'fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken)
  const request = async (method: string, path: string, credential: string | null, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/public-safety/incidents${path}`, { method, headers: { accept: 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert(response.headers.get('vary')?.split(',').map(value => value.trim().toLowerCase()).includes('authorization'))
    assert(response.headers.get('vary')?.split(',').map(value => value.trim().toLowerCase()).includes('cookie'))
    const data = await response.json() as any
    if (response.status >= 400) { assert.deepEqual(Object.keys(data), ['error']); assert.equal(JSON.stringify(data).includes('SELECT'), false); assert.equal(JSON.stringify(data).includes('temporary'), false) }
    return { status: response.status, data }
  }
  const token = tokens.get(coordinator.id)!
  const config = examplePublicSafetyConfig()
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const key = `/${config.id}`
  assert.equal((await request('POST', '', null, '{')).status, 403) // Native cookie CSRF runs before the Action.
  assert.equal((await request('GET', key, null)).status, 401)
  assert.equal((await request('POST', '', tokens.get(observer.id)!, '{')).status, 403)
  assert.equal((await request('POST', '', token, '{')).status, 400)
  assert.equal((await request('POST', '', token, 'x'.repeat(256 * 1024 + 1))).status, 413)
  assert.equal((await request('POST', '', token, { config, actorId: outsider.id })).status, 422)
  const created = await request('POST', '', token, { config })
  assert.equal(created.status, 201)
  assert.equal(created.data.coordinatorId, coordinator.id)
  assert.equal(created.data.identityAuthenticated, true)
  assert.equal(created.data.physicalFlightEnabled, false)
  assert.equal((await request('GET', key, tokens.get(outsider.id)!)).status, 403)
  assert.equal((await request('GET', key, null, undefined, { cookie: `${authCookieName()}=${token}` })).status, 200)
  assert.equal((await request('POST', `${key}/close`, null, { expectedVersion: 1 }, { cookie: `${authCookieName()}=${token}` })).status, 403)
  const session = await sessionLogin(coordinator.email, password)
  assert.equal(await sessionCheck(session.sessionId), true)
  assert.equal((await request('GET', key, null, undefined, { cookie: `session_id=${session.sessionId}` })).status, 401)
  let version = 1
  for (const [user, role] of [[observer, 'observer'], [pilot, 'pilot'], [reviewer, 'reviewer'], [custodian, 'evidence-custodian']] as const) {
    const changed = await request('PUT', `${key}/members`, token, { expectedVersion: version++, userId: user.id, role })
    assert.equal(changed.status, 200)
    assert.equal(changed.data.incident.version, version)
    assert.equal((await request('GET', key, tokens.get(user.id)!)).status, 200)
    assert.equal((await request('GET', `${key}/audit`, tokens.get(user.id)!)).status, role === 'evidence-custodian' ? 200 : 403)
    assert.equal((await request('POST', `${key}/close`, tokens.get(user.id)!, { expectedVersion: version })).status, 403)
  }
  const readOnly = await createToken(coordinator.id, 'read', ['public-safety:read'], { withRefreshToken: false })
  assert.equal((await request('PUT', `${key}/members`, readOnly.plainTextToken, '{')).status, 403)
  assert.equal((await request('PUT', `${key}/members`, token, 'x'.repeat(8193))).status, 413)
  assert.equal((await request('PUT', `${key}/members`, token, { expectedVersion: version, userId: coordinator.id, role: null })).status, 409)
  assert.equal((await request('PUT', `${key}/members`, token, { expectedVersion: version, userId: outsider.id, role: 'coordinator' })).status, 422)
  assert.equal((await request('PUT', `${key}/members`, token, { expectedVersion: 1, userId: outsider.id, role: 'observer' })).status, 409)
  const page = await request('GET', `${key}/audit?limit=2`, token)
  assert.equal(page.status, 200)
  assert.deepEqual(page.data.entries.map((entry: any) => entry.sequence), [1, 2])
  assert.equal(page.data.cursor, 2)
  assert.equal(page.data.hasMore, true)
  const next = await request('GET', `${key}/audit?after=2&limit=100`, token)
  assert.deepEqual(next.data.entries.map((entry: any) => entry.sequence), [3, 4, 5])
  assert.equal(next.data.hasMore, false)
  for (const query of ['limit=101', 'after=-1', 'after=1.2', 'limit=1&limit=2', 'actor=1']) assert.equal((await request('GET', `${key}/audit?${query}`, token)).status, 422)
  const csrf = 'a'.repeat(64)
  assert.equal((await request('PUT', `${key}/members`, null, { expectedVersion: version++, userId: observer.id, role: null }, { cookie: `${authCookieName()}=${token}; X-CSRF-Token=${csrf}`, 'x-csrf-token': csrf })).status, 200)
  assert.equal((await request('GET', key, tokens.get(observer.id)!)).status, 403)
  await Rbac.revokePermission(coordinator.id, 'public-safety:access', 'web')
  assert.equal((await request('GET', key, token)).status, 403)
  await Rbac.givePermission(coordinator.id, 'public-safety:access', 'web')
  assert.equal((await request('POST', `${key}/close`, token, { expectedVersion: version })).status, 200)
  assert.equal((await request('GET', key, tokens.get(pilot.id)!)).data.status, 'closed')
  assert.equal((await request('PUT', `${key}/members`, token, { expectedVersion: version + 1, userId: outsider.id, role: 'observer' })).status, 409)
  const expired = await createToken(coordinator.id, 'expired', ['public-safety:read'], { withRefreshToken: false, expiresAt: new Date(Date.now() - 1000) })
  assert.equal((await request('GET', key, expired.plainTextToken)).status, 401)
  await revokeToken(readOnly.plainTextToken)
  assert.equal((await request('GET', key, readOnly.plainTextToken)).status, 401)
  // Retention applies to closed reads too, using the native model surface.
  const Incident = (await import(join(root, 'app/Models/PublicSafetyIncident.ts'))).default
  const incident = await Incident.where('incident_key', config.id).first()
  await incident.update({ retain_until: new Date(Date.now() - 1000).toISOString() })
  assert.equal((await request('GET', key, token)).status, 404)
  console.log(`PASS native incident HTTP lifecycle nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
