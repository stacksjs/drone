import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { actor, as, seed, database, records, root } from './managed-context'

// Actual registered Actions and middleware in both native routing modes. Parallel requests
// observe current payload responses before a genuine shared wall deadline, then await it.
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { route } = await import('@stacksjs/router')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const observed = new Set<string>(), deadlines = new Map<string, number>()
route.use(async (request: Request, next: () => Promise<Response | null> | Response | null) => {
  const result = await next(), marker = request.headers.get('x-fixture-content-delay')
  if (marker) {
    const deadline = deadlines.get(marker)!
    assert.equal(result?.status, 200)
    assert(Date.now() < deadline, 'Middleware must observe an actual current content response')
    observed.add(marker)
    await Bun.sleep(Math.max(1, deadline - Date.now() + 10))
  }
  return result
})
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
try {
  const coordinator = await actor('content-wire-coordinator'), member = await actor('content-wire-member')
  const cases: { kind: string, method: string, path: string, body?: unknown }[] = []
  await as(coordinator.token.plainTextToken, async () => {
    const deadline = Date.now() + 15000
    for (const kind of ['incident', 'audit', 'source', 'sources', 'observation', 'observations', 'reviews', 'close', 'membership'] as const) {
      const key = `cw-${kind}`, seeded = await seed(key, deadline - Date.now())
      deadlines.set(kind, Date.parse(seeded.config.retention.expiresAt))
      const capture = seeded.run.survey.captures[0]!, support = seeded.run.captures[0]!.support.findIndex(value => value === 1)
      assert(support >= 0)
      const appended = await records.appendPublicSafetyObservation(key, { expectedVersion: 3, sourceDigest: seeded.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'private wire deadline observation', uncertaintyNote: 'explicit simulator declaration' })
      const reviewed = await records.appendPublicSafetyReview(key, appended.observation.id, { expectedVersion: 4, sourceDigest: seeded.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'private wire deadline review' })
      const suffix = { incident: '', audit: '/audit', source: `/sources/${seeded.source.digest}`, sources: '/sources', observation: `/observations/${appended.observation.id}`, observations: '/observations', reviews: `/observations/${appended.observation.id}/reviews`, close: '/close', membership: '/members' }[kind]
      cases.push({ kind, method: kind === 'close' ? 'POST' : kind === 'membership' ? 'PUT' : 'GET', path: `/${key}${suffix}`, ...(kind === 'close' ? { body: { expectedVersion: reviewed.incident.version } } : kind === 'membership' ? { body: { expectedVersion: reviewed.incident.version, userId: member.user.id, role: 'observer' } } : {}) })
    }
  })
  await Promise.all(cases.map(async item => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/public-safety/incidents${item.path}`, { method: item.method, headers: { authorization: `Bearer ${coordinator.token.plainTextToken}`, 'x-fixture-content-delay': item.kind, ...(item.body ? { 'content-type': 'application/json' } : {}) }, ...(item.body ? { body: JSON.stringify(item.body) } : {}) })
    assert(observed.has(item.kind), 'Actual middleware must have observed the pre-deadline response')
    assert.equal(response.status, 404, `${item.kind} must not release content after middleware crosses expiry`)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')!.toLowerCase().split(',').map(value => value.trim())
    assert(vary.includes('authorization') && vary.includes('cookie'))
    assert.deepEqual(Object.keys(await response.json() as object), ['error'])
  }))
  assert.equal(observed.size, 9)
  console.log(`PASS actual9 content HTTP middleware deadline crossings nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
