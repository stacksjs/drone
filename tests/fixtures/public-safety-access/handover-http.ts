import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'

// Guard runs before models, database or authorization can be loaded or written.
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
  const people = new Map<string, { id: number, token: string }>()
  for (const name of ['coordinator', 'recipient', 'outsider']) {
    const user = await User.create({ name, email: `${name}@example.invalid`, password: 'temporary-fixture-password' })
    people.set(name, { id: user.id, token: (await createToken(user.id, name, ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken })
  }
  const coordinator = people.get('coordinator')!, recipient = people.get('recipient')!
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const person of people.values()) await Rbac.givePermission(person.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const send = async (method: string, path: string, token: string | null, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')!.toLowerCase().split(',').map(value => value.trim())
    assert(vary.includes('authorization') && vary.includes('cookie'))
    const data = await response.json() as any
    if (response.status >= 400) assert.deepEqual(Object.keys(data), ['error'])
    return { status: response.status, data }
  }
  const config = examplePublicSafetyConfig()
  config.id = 'wire-handover'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const key = `/${config.id}`
  assert.equal((await send('POST', '', coordinator.token, { config })).status, 201)
  assert.equal((await send('PUT', `${key}/members`, coordinator.token, { expectedVersion: 1, userId: recipient.id, role: 'observer' })).status, 200)
  const recording = simulatePublicSafety({ config, seconds: 10 })
  const admitted = await send('POST', `${key}/sources`, coordinator.token, { expectedVersion: 2, recording: JSON.parse(publicSafetyRecordingData(recording)) })
  assert.equal(admitted.status, 201)
  const desk = await send('GET', `${key}/handover`, coordinator.token)
  assert.equal(desk.status, 200, 'The native handover desk route must exist')
  const offered = await send('POST', `${key}/handover/offer`, coordinator.token, { requestId: randomUUID(), assignment: desk.data.assignment, recipientUserId: recipient.id, recipientMembershipVersion: 1, sourceDigest: admitted.data.source.digest, outgoingRole: 'observer', expiresInSeconds: 300 })
  assert.equal(offered.status, 201)
  const incoming = await send('GET', `${key}/handover?offer=${offered.data.offer.key}`, recipient.token)
  assert.equal(incoming.status, 200)
  const accepted = await send('POST', `${key}/handover/decision`, recipient.token, { requestId: randomUUID(), offerKey: offered.data.offer.key, decision: 'accept', acknowledgement: { offerDigest: offered.data.offer.digest, assignment: 'incident-coordination', sourceDigest: admitted.data.source.digest, contextThroughSequence: offered.data.offer.contextThroughSequence, uncertaintyAcknowledged: true } })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.data.incident.coordinatorId, recipient.id)
  assert.equal(accepted.data.offer.state, 'accepted')
  assert.equal(accepted.data.replayed, false)
  console.log(`PASS native incident handover HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
