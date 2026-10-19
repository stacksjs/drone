import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { incidentDataExposureBoundary } from '../../../resources/functions/drone/public-safety/access/exposure'

const { database, User } = await setupIncidentDatabase()
try {
  await User.create({ name: 'Private Operator', email: 'private-operator@example.invalid', password: 'temporary-native-password' })
  const { createStacksRouter } = await import('@stacksjs/router')
  const source = resolve(import.meta.dir, '../../..')
  const ModelShow = (await import(join(source, 'storage/framework/defaults/app/Actions/Dashboard/Models/ModelShowAction.ts'))).default
  const ModelsIndex = (await import(join(source, 'storage/framework/defaults/app/Actions/Dashboard/Models/ModelsIndexAction.ts'))).default
  const router = createStacksRouter({ autoDiscoverRoutes: false })
  router.use(incidentDataExposureBoundary)
  // Real generic Actions remain registered, modeling explicit bundle enablement.
  router.get('/api/dashboard/models', ModelsIndex)
  router.get('/api/dashboard/models/{slug}', ModelShow)
  router.get('/canary/{slug}', ModelShow)
  router.get('/api/public-safety/fixture-health', () => Response.json({ ok: true }))
  for (const nativeRoutes of [false, true]) {
    const server = await router.serve({ port: 0, hostname: '127.0.0.1', nativeRoutes })
    try {
      const base = `http://127.0.0.1:${server.port}`
      const canary = await fetch(`${base}/canary/user`)
      assert.equal(canary.status, 200)
      assert((await canary.text()).includes('private-operator@example.invalid'))
      for (const path of ['/api/dashboard/models', '/api/dashboard/models/user', '/api/dashboard/models/public-safety-incident', '/models/user-count', '/api/dashboard/search', '/api/%64ashboard/models/user']) {
        const response = await fetch(`${base}${path}`)
        assert.equal(response.status, 404)
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.equal((await response.text()).includes('private-operator'), false)
      }
      assert.deepEqual(await (await fetch(`${base}/api/public-safety/fixture-health`)).json(), { ok: true })
    }
    finally { await server.stop(true) }
  }
  console.log('PASS native generic model routes cannot bypass incident-scoped data boundaries')
}
finally { await database.closeDatabaseConnection() }
