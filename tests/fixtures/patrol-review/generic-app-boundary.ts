import assert from 'node:assert/strict'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupPatrolDatabase } from './setup'
import { intent } from './http-fixture'

async function main() {
  const { root, database, User } = await setupPatrolDatabase({ prepare: async directory => {
    for (const file of await readdir(join(directory, 'app/Models'))) {
      if (file !== 'User.ts' && !file.startsWith('PatrolReview')) await rm(join(directory, 'app/Models', file), { recursive: true, force: true })
    }
    await writeFile(join(directory, 'app/Models/QualificationPublicModel.ts'), "import { defineModel } from '@stacksjs/orm'; export default defineModel({name:'QualificationPublicModel',table:'users',traits:{useApi:false,useTimestamps:false,useSeeder:false},dashboard:{enabled:true,highlight:false},attributes:{name:{fillable:false}}})")
  } })
  const source = resolve(import.meta.dir, '../../..')
  await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
  const { initializeAuthorization } = await import('@stacksjs/auth/policy')
  await initializeAuthorization()
  const { Rbac } = await import('@stacksjs/auth/rbac')
  const user = await User.create({ name: 'Catalog Control', email: 'catalog@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['patrol:access', 'patrol:create', 'patrol:read']) {
    await Rbac.createPermission(permission, 'web')
    await Rbac.givePermission(user.id, permission, 'web')
  }
  const { createToken } = await import('@stacksjs/auth/tokens')
  const token = await createToken(user.id, 'catalog fixture', ['patrol:create', 'patrol:read'], { withRefreshToken: false })
  const headers = { authorization: `Bearer ${token.plainTextToken}`, accept: 'application/json', 'content-type': 'application/json' }
  const { route } = await import('@stacksjs/router')
  const GetModels = (await import('@stacksjs/defaults/app/Actions/Dashboard/Models/GetModels.ts')).default
  const ModelShow = (await import('@stacksjs/defaults/app/Actions/Dashboard/Models/ModelShowAction.ts')).default
  const ModelStore = (await import('@stacksjs/defaults/app/Actions/Dashboard/Models/ModelStoreAction.ts')).default
  route.get('/api/dashboard/models', GetModels).middleware('PatrolAuth')
  route.get('/api/dashboard/models/{slug}', ModelShow).middleware('PatrolAuth')
  route.post('/api/dashboard/models/{slug}', ModelStore).middleware('PatrolAuth')
  const registered = () => route.routes.filter(r => r.path.startsWith('/api/dashboard/models')).map(r => `${r.method} ${r.path}`).sort()
  assert.equal(registered().length, 3)
  let server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: true })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/dashboard/models`, { headers })
    const rows = await response.json()
    assert.equal(response.status, 200)
    assert(Array.isArray(rows))
    assert(rows.some((row: { model: string }) => row.model === 'QualificationPublicModel'))
    // Diagnostic only. Independent flag filtering is not the accepted privacy contract.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ label: 'actual-reserved-native-catalog-before-app-boundary', status: response.status, rows }))
    await server.stop(true)
    await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
    assert.equal(registered().length, 3)
    // Rebuild after global middleware registration; do not reuse captured native dispatch.
    server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: true })
    for (const [method, path] of [['GET', '/api/dashboard/models'], ['GET', '/api/dashboard/models/patrol-review-schedule'], ['POST', '/api/dashboard/models/patrol-review-schedule']] as const) {
      const hidden = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify({ fields: { scheduleKey: 'unauthorized' } }) } : {}) })
      assert.equal(hidden.status, 404)
      assert.equal(hidden.headers.get('cache-control'), 'private, no-store')
      assert.equal(hidden.headers.get('x-content-type-options'), 'nosniff')
      assert.deepEqual(await hidden.json(), { error: 'Not Found' })
    }
    const created = await fetch(`http://127.0.0.1:${server.port}/api/patrol/reviews`, { method: 'POST', headers, body: JSON.stringify(intent) })
    assert.equal(created.status, 201)
    const read = await fetch(`http://127.0.0.1:${server.port}/api/patrol/reviews/${intent.scheduleKey}`, { headers })
    assert.equal(read.status, 200)
    assert.equal((await read.json()).scheduleVersion, 1)
    const generic = route.routes.filter(r => /(?:dashboard|models)/i.test(r.path)).map(r => r.path)
    assert(generic.every(path => ['/api/dashboard', '/models', '/dashboard'].some(prefix => path === prefix || path.startsWith(`${prefix}/`))))
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ label: 'actual-native-generic-registry-after-app-boundary', registered: registered(), unreservedGenericAliases: [] }))
    // eslint-disable-next-line no-console
    console.log('PASS registered native discovery read write are blocked by unchanged application boundary while owner patrol create and GET succeed')
  }
  finally {
    await server.stop(true)
    await database.closeDatabaseConnection()
  }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
