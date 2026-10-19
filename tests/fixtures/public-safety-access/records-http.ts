import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData, publicSafetyEvidenceLimits } from '../../../resources/functions/drone/public-safety/evidence'
import { createHash } from 'node:crypto'

// A fixture-only model generates the native session table; no application session API is installed.
const { root, database, User } = await setupIncidentDatabase({
  prepare: root => writeFile(join(root, 'app/Models/Session.ts'), `import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'
export default defineModel({name:'Session',table:'sessions',primaryKey:'id',autoIncrement:false,traits:{useApi:false,useTimestamps:false},attributes:{
id:{required:true,validation:{rule:schema.string()}},userId:{required:true,validation:{rule:schema.number().integer()}},
ipAddress:{validation:{rule:schema.string().optional()}},userAgent:{validation:{rule:schema.string().optional()}},
payload:{required:true,validation:{rule:schema.string()}},lastActivity:{required:true,validation:{rule:schema.number().integer()}},expiresAt:{required:true,validation:{rule:schema.string()}}
}})`),
})
const { generateMigrations } = await import('@stacksjs/database/migrations')
const generated = await generateMigrations()
assert(generated.isOk)
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
const observedBodies = new Map<string, boolean>()
route.use(async (request: Request, next: () => Response | null | Promise<Response | null>) => {
  try { return await next() }
  finally { const marker = request.headers.get('x-fixture-unread'); if (marker) observedBodies.set(marker, request.bodyUsed) }
})
// Deliberately mount the actual generic native Actions to exercise the app's forced-bundle bridge.
for (const [name, method, path] of [
  ['ModelsIndexAction', 'get', '/api/dashboard/models'],
  ['ModelShowAction', 'get', '/api/dashboard/models/{slug}'],
  ['ModelStoreAction', 'post', '/api/dashboard/models/{slug}'],
  ['ModelUpdateAction', 'patch', '/api/dashboard/models/{slug}/{id}'],
  ['ModelDestroyAction', 'delete', '/api/dashboard/models/{slug}/{id}'],
  ['GetUserCount', 'get', '/api/dashboard/user-count'],
] as const) {
  const action = (await import(join(source, `storage/framework/defaults/app/Actions/Dashboard/Models/${name}.ts`))).default
  route[method](path, action)
}
const Search = (await import(join(source, 'storage/framework/defaults/app/Actions/Dashboard/Search/GlobalSearchAction.ts'))).default
route.get('/api/dashboard/search', Search)
const records = await import('../../../resources/functions/drone/public-safety/access/records')
route.get('/record-canary/{incident}/{digest}/{observation}', async request => ({
  source: await records.readPublicSafetySource(request.params.incident, request.params.digest),
  observation: await records.readPublicSafetyObservation(request.params.incident, Number(request.params.observation)),
})).middleware('auth')
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents`
try {
  const password = 'temporary-fixture-password'
  const people = new Map<string, { id: number, email: string, token: string }>()
  for (const name of ['coordinator', 'pilot', 'observer', 'reviewer', 'custodian', 'outsider']) {
    const user = await User.create({ name, email: `${name}@example.invalid`, password })
    people.set(name, { id: user.id, email: user.email, token: (await createToken(user.id, 'wire fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken })
  }
  const coordinator = people.get('coordinator')!, pilot = people.get('pilot')!, observer = people.get('observer')!, reviewer = people.get('reviewer')!, custodian = people.get('custodian')!, outsider = people.get('outsider')!
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const user of people.values()) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const check = async (response: Response) => {
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim())
    assert(vary?.includes('authorization') && vary.includes('cookie'))
    const data = await response.json() as any
    if (response.status >= 400) { assert.deepEqual(Object.keys(data), ['error']); assert(!JSON.stringify(data).includes('SELECT')); assert(!JSON.stringify(data).includes(password)) }
    return { status: response.status, data }
  }
  const send = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body) }),
  }).then(check)
  const config = examplePublicSafetyConfig()
  config.id = 'wire-records'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const key = `/${config.id}`, token = coordinator.token
  assert.equal((await send('POST', '', token, { config })).status, 201)
  let version = 1
  for (const [user, role] of [[pilot, 'pilot'], [observer, 'observer'], [reviewer, 'reviewer'], [custodian, 'evidence-custodian']] as const) {
    assert.equal((await send('PUT', `${key}/members`, token, { expectedVersion: version++, userId: user.id, role })).status, 200)
  }
  const configB = structuredClone(config); configB.id = 'wire-records-other'
  assert.equal((await send('POST', '', token, { config: configB })).status, 201)
  const otherKey = `/${configB.id}`
  // Roles are checked before even malformed JSON can be consumed. Allowed roles reach the bounded reader.
  for (const [user, sourceAllowed, reviewAllowed] of [[coordinator, true, true], [pilot, true, false], [observer, false, false], [reviewer, false, true], [custodian, true, false]] as const) {
    for (const [path, allowed] of [['sources', sourceAllowed], ['observations', true], ['observations/1/reviews', reviewAllowed]] as const) {
      const marker = `${user.id}-${path}`
      assert.equal((await send('POST', `${key}/${path}`, user.token, '{', { 'x-fixture-unread': marker })).status, allowed ? 400 : 403)
      assert.equal(observedBodies.get(marker), allowed)
    }
  }
  const session = await sessionLogin(coordinator.email, password)
  assert.equal(await sessionCheck(session.sessionId), true)
  for (const [credential, cookie, code, marker] of [[null, '', 401, 'anonymous'], [outsider.token, '', 403, 'nonmember'], [null, `session_id=${session.sessionId}`, 401, 'session-only'], [null, `${authCookieName()}=${token}`, 403, 'cookie-csrf']] as const) {
    assert.equal((await send('POST', `${key}/sources`, credential, '{', { cookie: marker === 'session-only' ? `${cookie}; X-CSRF-Token=${'a'.repeat(64)}` : cookie, ...(marker === 'session-only' ? { 'x-csrf-token': 'a'.repeat(64) } : {}), 'x-fixture-unread': marker })).status, code, marker)
    assert.equal(observedBodies.get(marker), false)
  }
  const readOnly = await createToken(coordinator.id, 'read only', ['public-safety:read'], { withRefreshToken: false })
  assert.equal((await send('POST', `${key}/sources`, readOnly.plainTextToken, '{', { 'x-fixture-unread': 'read-only' })).status, 403)
  assert.equal(observedBodies.get('read-only'), false)
  assert.equal((await send('POST', `${key}/sources`, token, '{', { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await send('POST', `${key}/sources?actorId=1`, token, '{', { 'x-fixture-unread': 'query' })).status, 422)
  assert.equal(observedBodies.get('query'), false)
  const limit = publicSafetyEvidenceLimits.recordingBytes + 4096
  const envelope = '{}'.padEnd(limit, ' ')
  assert.equal((await send('POST', `${key}/sources`, token, envelope)).status, 422)
  assert.equal((await send('POST', `${key}/sources`, token, envelope + ' ')).status, 413)
  const stream = (length: number) => new ReadableStream<Uint8Array>({
    pull(controller) { if (!length) { controller.close(); return }; const size = Math.min(length, 65536); controller.enqueue(new Uint8Array(size).fill(32)); length -= size },
  })
  assert.equal((await send('POST', `${key}/sources`, token, stream(limit + 1))).status, 413)
  assert.equal((await send('POST', `${key}/sources`, observer.token, stream(limit + 1), { 'x-fixture-unread': 'large-forbidden' })).status, 403)
  assert.equal(observedBodies.get('large-forbidden'), false)
  const lying = new Request(`${base}${key}/sources`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': '1' }, body: stream(limit + 1) })
  const lyingResult = await route.handleRequest(lying as Parameters<typeof route.handleRequest>[0])
  assert(lyingResult)
  assert.equal((await check(lyingResult)).status, 413)
  // The large boundary cases above do no replay. One real recording drives the wire lifecycle.
  const recording = simulatePublicSafety({ config, seconds: 16 })
  const canonical = publicSafetyRecordingData(recording), plain = JSON.parse(canonical)
  const admitted = await send('POST', `${key}/sources`, pilot.token, { expectedVersion: version++, recording: plain })
  assert.equal(admitted.status, 201)
  const source = admitted.data.source
  assert.equal(source.createdSequence, version)
  assert.equal(source.uploaderId, pilot.id)
  assert.equal(source.uploaderAuthenticated, true)
  assert.equal(source.sourceIdentityAuthenticated, false)
  assert.equal(source.digest, createHash('sha256').update(canonical).digest('hex'))
  assert.equal(source.byteLength, Buffer.byteLength(canonical))
  const read = await send('GET', `${key}/sources/${source.digest}`, readOnly.plainTextToken)
  assert.equal(read.status, 200)
  assert.equal(publicSafetyRecordingData(read.data.recording), canonical)
  assert(Array.isArray(read.data.recording.captures[0].support))
  assert(Array.isArray(read.data.recording.captures[0].thermalCentiKelvin))
  assert(Array.isArray(read.data.recording.survey.captures[0].rgba))
  assert.equal(read.data.recording.identityAuthenticated, false)
  assert.equal(read.data.recording.physicalFlightEnabled, false)
  assert.equal(read.data.recording.physicalThermalVerified, false)
  assert.equal((await send('POST', `${key}/sources`, token, { expectedVersion: version, recording: plain })).status, 409)
  const sourceList = await send('GET', `${key}/sources?limit=1`, observer.token)
  assert.equal(sourceList.data.entries.length, 1)
  assert.equal(sourceList.data.cursor, source.createdSequence)
  assert.equal(sourceList.data.hasMore, false)
  assert(!('recording' in sourceList.data.entries[0]) && !('canonicalJson' in sourceList.data.entries[0]) && !('captures' in sourceList.data.entries[0]))
  assert.equal((await send('GET', `${otherKey}/sources/${source.digest}`, token)).status, 404)
  const capture = recording.survey.captures[0]!, thermal = recording.captures[0]!, index = thermal.support.findIndex(value => value === 1)
  assert(index >= 0)
  const input = { expectedVersion: version, sourceDigest: source.digest, captureId: capture.id, modality: 'visible', pixel: { x: index % capture.width, y: Math.floor(index / capture.width) }, note: ' Authored visible declaration é ', uncertaintyNote: 'Synthetic image only, physical meaning unqualified' }
  for (const changed of [{ actorId: coordinator.id }, { pixel: { x: '0', y: 0 } }, { note: 'é'.repeat(1025) }, { uncertaintyNote: ' ' }]) assert.equal((await send('POST', `${key}/observations`, observer.token, { ...input, ...changed })).status, 422)
  const observationJson = JSON.stringify(input)
  const boundaryBody = observationJson + ' '.repeat(8192 - Buffer.byteLength(observationJson))
  const visible = await send('POST', `${key}/observations`, observer.token, boundaryBody)
  assert.equal(visible.status, 201); version++
  assert.equal(visible.data.observation.actorId, observer.id)
  assert.equal(visible.data.observation.note, input.note)
  assert.deepEqual(visible.data.observation.pixel, input.pixel)
  assert.equal((await send('POST', `${key}/observations`, observer.token, boundaryBody + ' ')).status, 413)
  assert.equal((await send('POST', `${key}/observations`, observer.token, 'é'.repeat(4097))).status, 413)
  const csrf = 'a'.repeat(64), cookie = `${authCookieName()}=${reviewer.token}; X-CSRF-Token=${csrf}`
  const thermalObservation = await send('POST', `${key}/observations`, null, { ...input, expectedVersion: version++, modality: 'thermal', note: 'é'.repeat(1024), uncertaintyNote: 'é'.repeat(512) }, { cookie, 'x-csrf-token': csrf })
  assert.equal(thermalObservation.status, 201)
  assert.equal(thermalObservation.data.observation.note, 'é'.repeat(1024))
  assert.equal(thermalObservation.data.observation.uncertaintyNote, 'é'.repeat(512))
  assert.equal(Buffer.byteLength(thermalObservation.data.observation.uncertaintyNote), 1024)
  const observation = visible.data.observation
  assert.deepEqual((await send('GET', `${key}/observations/${observation.id}`, pilot.token)).data, observation)
  assert.equal((await send('GET', `${otherKey}/observations/${observation.id}`, token)).status, 404)
  assert.equal((await send('GET', `${otherKey}/observations`, token)).data.entries.length, 0)
  const observationPage = await send('GET', `${key}/observations?limit=1`, token)
  assert.equal(observationPage.data.hasMore, true)
  assert.equal(observationPage.data.entries[0].id, observation.id)
  const observationNext = await send('GET', `${key}/observations?after=${observationPage.data.cursor}`, token)
  assert.equal(observationNext.data.entries.length, 1)
  assert.equal(observationNext.data.entries[0].id, thermalObservation.data.observation.id)
  const reviewInput = { expectedVersion: version, sourceDigest: source.digest, previousReviewId: null, disposition: 'unresolved', note: ' Initial reviewer declaration é ' }
  const reviewPath = `${key}/observations/${observation.id}/reviews`
  for (const note of ['', ' \n\t ', 'é'.repeat(1025)]) assert.equal((await send('POST', reviewPath, reviewer.token, { ...reviewInput, note })).status, 422)
  const reviewJson = JSON.stringify(reviewInput)
  const reviewEnvelope = reviewJson + ' '.repeat(8192 - Buffer.byteLength(reviewJson))
  assert.equal(Buffer.byteLength(reviewEnvelope), 8192)
  // Both boundary requests have a current version and valid first-review pointer.
  assert.equal((await send('POST', reviewPath, reviewer.token, reviewEnvelope + ' ')).status, 413)
  const first = await send('POST', reviewPath, reviewer.token, reviewEnvelope)
  assert.equal(first.status, 201); version++
  assert.equal(first.data.review.selfReview, false)
  assert.equal(first.data.review.uncertaintyNote, input.uncertaintyNote)
  assert.equal((await send('POST', `${key}/observations/${observation.id}/reviews`, reviewer.token, { ...reviewInput, expectedVersion: version })).status, 409)
  assert.equal((await send('POST', `${key}/observations/${observation.id}/reviews`, reviewer.token, { ...reviewInput, expectedVersion: version, previousReviewId: first.data.review.id, sourceDigest: 'a'.repeat(64) })).status, 404)
  assert.equal((await send('POST', `${otherKey}/observations/${observation.id}/reviews`, token, { ...reviewInput, expectedVersion: 1 })).status, 404)
  const second = await send('POST', `${key}/observations/${observation.id}/reviews`, reviewer.token, { ...reviewInput, expectedVersion: version++, previousReviewId: first.data.review.id, disposition: 'supported-by-source', note: 'é'.repeat(1024) })
  assert.equal(second.status, 201)
  assert.equal(second.data.review.note, 'é'.repeat(1024))
  assert.equal(Buffer.byteLength(second.data.review.note), 2048)
  const self = await send('POST', `${key}/observations/${thermalObservation.data.observation.id}/reviews`, reviewer.token, { ...reviewInput, expectedVersion: version++ })
  assert.equal(self.status, 201); assert.equal(self.data.review.selfReview, true)
  const history = await send('GET', `${key}/observations/${observation.id}/reviews?limit=1`, observer.token)
  assert.equal(history.data.entries[0].note, reviewInput.note)
  assert.equal(history.data.hasMore, true)
  const nextReview = await send('GET', `${key}/observations/${observation.id}/reviews?after=${history.data.cursor}`, observer.token)
  assert.deepEqual(nextReview.data.entries.map((entry: any) => entry.disposition), ['supported-by-source'])
  assert.equal(nextReview.data.hasMore, false)
  assert.equal(nextReview.data.entries[0].note, 'é'.repeat(1024))
  assert.deepEqual((await send('GET', `${key}/observations/${observation.id}`, token)).data, observation)
  for (const path of ['/sources', '/observations', `/observations/${observation.id}/reviews`]) {
    for (const query of ['limit=101', 'after=-1', 'after=01', 'after=1%0A', 'limit=1&limit=2', 'afterSequence=1', 'actorId=1']) assert.equal((await send('GET', key + path + '?' + query, token)).status, 422)
  }
  for (const id of ['0', '01', '1e0', `${observation.id}%0A`, '9007199254740992']) assert.equal((await send('GET', `${key}/observations/${id}`, token)).status, 422)
  assert.equal((await send('GET', `${key}/sources/${source.digest}%0A`, token)).status, 422)
  assert.equal((await send('GET', `${key}/sources/${source.digest}?id=1`, token)).status, 422)
  assert.equal((await send('GET', `${key}/observations/${observation.id}?id=1`, token)).status, 422)
  await Rbac.revokePermission(coordinator.id, 'public-safety:access', 'web')
  assert.equal((await send('POST', `${key}/sources`, token, '{', { 'x-fixture-unread': 'platform-revoked' })).status, 403)
  assert.equal(observedBodies.get('platform-revoked'), false)
  await Rbac.givePermission(coordinator.id, 'public-safety:access', 'web')
  await revokeToken(readOnly.plainTextToken)
  assert.equal((await send('POST', `${key}/sources`, readOnly.plainTextToken, '{', { 'x-fixture-unread': 'token-revoked' })).status, 401)
  assert.equal(observedBodies.get('token-revoked'), false)
  assert.equal((await send('PUT', `${key}/members`, token, { expectedVersion: version++, userId: pilot.id, role: null })).status, 200)
  assert.equal((await send('POST', `${key}/sources`, pilot.token, '{', { 'x-fixture-unread': 'member-revoked' })).status, 403)
  assert.equal(observedBodies.get('member-revoked'), false)
  const canary = await (await fetch(`http://127.0.0.1:${server.port}/record-canary/${config.id}/${source.digest}/${observation.id}`, { headers: { authorization: `Bearer ${token}` } })).json() as any
  assert.equal(canary.observation.note, input.note)
  assert(Array.isArray(canary.source.recording.captures[0].thermalCentiKelvin))
  for (const [method, path] of [
    ['GET', '/api/dashboard/models'], ['GET', '/api/dashboard/user-count'], ['GET', '/api/dashboard/search?q=declaration'],
    ['GET', '/api/dashboard/models/public-safety-source'], ['GET', '/api/dashboard/models/public-safety-observation'], ['GET', '/api/dashboard/models/public-safety-review'],
    ['POST', '/api/dashboard/models/public-safety-source'], ['PATCH', `/api/dashboard/models/public-safety-observation/${observation.id}`], ['DELETE', `/api/dashboard/models/public-safety-review/${first.data.review.id}`],
  ]) {
    const denied = await check(await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' || method === 'PATCH' ? { body: '{"fields":{"note":"forged"}}' } : {}) }))
    assert.equal(denied.status, 404)
  }
  const audit = await send('GET', `${key}/audit`, token)
  assert.deepEqual(audit.data.entries.filter((entry: any) => ['source-registered', 'observation-created', 'review-appended'].includes(entry.action)).map((entry: any) => entry.sequence), [6, 7, 8, 9, 10, 11])
  assert.equal((await send('POST', `${key}/close`, token, { expectedVersion: version++ })).status, 200)
  assert.equal((await send('GET', `${key}/sources/${source.digest}`, token)).status, 200)
  for (const path of ['/sources', '/observations', `/observations/${observation.id}/reviews`]) assert.equal((await send('POST', key + path, token, '{')).status, 409)
  const Incident = (await import(join(root, 'app/Models/PublicSafetyIncident.ts'))).default
  await (await Incident.where('incident_key', config.id).first()).update({ retain_until: new Date(Date.now() - 1000).toISOString() })
  for (const path of ['/sources', `/sources/${source.digest}`, '/observations', `/observations/${observation.id}`, `/observations/${observation.id}/reviews`]) assert.equal((await send('GET', key + path, token)).status, 404)
  console.log(`PASS native source pixel review HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
