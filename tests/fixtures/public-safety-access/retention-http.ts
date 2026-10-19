import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import { randomUUID } from 'node:crypto'

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
const { Gate } = await import('@stacksjs/auth/gate')
for (const [name, method, path] of [
  ['ModelsIndexAction', 'get', '/api/dashboard/models'],
  ['ModelShowAction', 'get', '/api/dashboard/models/{slug}'],
  ['ModelStoreAction', 'post', '/api/dashboard/models/{slug}'],
  ['ModelUpdateAction', 'patch', '/api/dashboard/models/{slug}/{id}'],
  ['ModelDestroyAction', 'delete', '/api/dashboard/models/{slug}/{id}'],
] as const) route[method](path, (await import(join(source, `storage/framework/defaults/app/Actions/Dashboard/Models/${name}.ts`))).default)
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents`
try {
  const people = new Map<string, { id: number, token: string }>()
  for (const name of ['coordinator', 'custodian', 'pilot', 'observer', 'reviewer', 'outsider']) {
    const user = await User.create({ name, email: `${name}@example.invalid`, password: 'temporary-fixture-password' })
    people.set(name, { id: user.id, token: (await createToken(user.id, 'custody wire fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken })
  }
  const coordinator = people.get('coordinator')!, custodian = people.get('custodian')!, pilot = people.get('pilot')!, observer = people.get('observer')!, reviewer = people.get('reviewer')!, outsider = people.get('outsider')!
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const user of people.values()) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const check = async (response: Response) => {
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim())
    assert(vary?.includes('authorization') && vary.includes('cookie'))
    const data = await response.json() as any
    if (response.status >= 400) { assert.deepEqual(Object.keys(data), ['error']); assert(!JSON.stringify(data).includes('SELECT')); assert(!JSON.stringify(data).includes('temporary-fixture-password')) }
    return { status: response.status, data }
  }
  const send = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }).then(check)
  const config = examplePublicSafetyConfig()
  config.id = 'retention-wire'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  config.retention.hold = 'declared-review-required'
  const key = `/${config.id}`, custody = `${key}/retention`, token = coordinator.token
  assert.equal((await send('POST', '', token, { config })).status, 201)
  let incidentVersion = 1
  for (const [user, role] of [[custodian, 'evidence-custodian'], [pilot, 'pilot'], [observer, 'observer'], [reviewer, 'reviewer']] as const) assert.equal((await send('PUT', `${key}/members`, token, { expectedVersion: incidentVersion++, userId: user.id, role })).status, 200)
  // Real private records make projection minimization observable, rather than checking empty data.
  const recording = JSON.parse(publicSafetyRecordingData(simulatePublicSafety({ config, seconds: 16 })))
  const admitted = await send('POST', `${key}/sources`, pilot.token, { expectedVersion: incidentVersion++, recording })
  assert.equal(admitted.status, 201)
  const sourceDigest = admitted.data.source.digest
  const capture = recording.survey.captures[0], thermal = recording.captures[0]
  const index = thermal.support.findIndex((value: number) => value === 1)
  assert(index >= 0)
  const privateNote = 'Private retained observation declaration canary', privateUncertainty = 'Private retained uncertainty canary', privateReview = 'Private retained review declaration canary'
  const observation = await send('POST', `${key}/observations`, observer.token, { expectedVersion: incidentVersion++, sourceDigest, captureId: capture.id, modality: 'visible', pixel: { x: index % capture.width, y: Math.floor(index / capture.width) }, note: privateNote, uncertaintyNote: privateUncertainty })
  assert.equal(observation.status, 201)
  const review = await send('POST', `${key}/observations/${observation.data.observation.id}/reviews`, reviewer.token, { expectedVersion: incidentVersion++, sourceDigest, previousReviewId: null, disposition: 'unresolved', note: privateReview })
  assert.equal(review.status, 201)
  const forbiddenFields = ['config', 'geometry', 'purpose', 'purposeAuthority', 'revision', 'recording', 'sourceDigest', 'digest', 'sourceId', 'observationId', 'reviewId', 'captureId', 'note', 'uncertaintyNote']
  const minimal = (input: unknown) => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      for (const [field, nested] of Object.entries(value)) { assert(!forbiddenFields.includes(field), `custody exposed ${field}`); visit(nested) }
    }
    visit(input)
    const text = JSON.stringify(input)
    for (const canary of [privateNote, privateUncertainty, privateReview, sourceDigest]) assert(!text.includes(canary))
  }
  const scopeFlags = (scope: any) => {
    minimal(scope)
    assert.equal(scope.purgeImplemented, false)
    assert.equal(scope.contentDeletionPerformed, false)
    assert.equal(scope.legacyOfflineExportsManaged, false)
  }
  assert.equal((await send('GET', custody, token)).status, 404)
  assert.equal((await send('GET', `${custody}/events`, token)).status, 404)
  const priorPreview = await send('GET', `${custody}/preview`, token)
  assert.equal(priorPreview.status, 200)
  assert.deepEqual(priorPreview.data.counts, { sources: 1, observations: 1, reviews: 1 })
  scopeFlags(priorPreview.data)
  const previewKeys = ['key', 'incidentVersion', 'retainUntil', 'expired', 'originalHold', 'counts', 'managedArtifactCount', 'inventoryDigest', 'purgeImplemented', 'contentDeletionPerformed', 'legacyOfflineExportsManaged']
  assert.deepEqual(Object.keys(priorPreview.data).sort(), previewKeys.sort())
  for (const [name, canRead, canManage, canRevoke] of [['coordinator', true, true, true], ['custodian', true, true, false], ['pilot', false, false, false], ['observer', false, false, false], ['reviewer', false, false, false], ['outsider', false, false, false]] as const) {
    const user = people.get(name)!
    assert.equal((await send('GET', `${custody}/preview`, user.token)).status, canRead ? 200 : 403)
    for (const [path, allowed] of [['enrollment', canManage], ['hold', canManage], ['revoke-member', canRevoke]] as const) {
      const marker = `${name}-${path}`
      assert.equal((await send('POST', `${custody}/${path}`, user.token, '{', { 'x-fixture-unread': marker })).status, allowed ? 400 : 403)
      assert.equal(observedBodies.get(marker), allowed)
    }
  }
  const readOnly = await createToken(coordinator.id, 'custody read only', ['public-safety:read'], { withRefreshToken: false })
  for (const path of ['enrollment', 'hold', 'revoke-member']) {
    const marker = `read-only-${path}`
    assert.equal((await send('POST', `${custody}/${path}`, readOnly.plainTextToken, '{', { 'x-fixture-unread': marker })).status, 403)
    assert.equal(observedBodies.get(marker), false)
    assert.equal((await send('POST', `${custody}/${path}`, token, '{}'.padEnd(8193, ' '))).status, 413)
  }
  assert.equal((await send('POST', `${custody}/enrollment`, null, '{', { 'x-fixture-unread': 'unauthenticated' })).status, 401)
  assert.equal(observedBodies.get('unauthenticated'), false)
  const csrf = 'a'.repeat(64), cookie = `${authCookieName()}=${custodian.token}; X-CSRF-Token=${csrf}`
  assert.equal((await send('POST', `${custody}/enrollment`, null, '{', { cookie: `${authCookieName()}=${custodian.token}`, 'x-fixture-unread': 'csrf' })).status, 403)
  assert.equal(observedBodies.get('csrf'), false)
  const session = await sessionLogin('coordinator@example.invalid', 'temporary-fixture-password')
  assert.equal(await sessionCheck(session.sessionId), true)
  assert.equal((await send('GET', `${custody}/preview`, null, undefined, { cookie: `session_id=${session.sessionId}` })).status, 401)
  assert.equal((await send('POST', `${custody}/enrollment`, token, '{', { 'content-type': 'text/plain' })).status, 415)
  const legacy = structuredClone(config); legacy.id = 'retention-unenrolled'; legacy.retention.hold = 'none'
  assert.equal((await send('POST', '', token, { config: legacy })).status, 201)
  assert.equal((await send('GET', `/${legacy.id}/retention`, token)).status, 404)
  assert.equal((await send('POST', `${key}/close`, token, { expectedVersion: incidentVersion++ })).status, 200)
  assert.equal((await send('GET', key, token)).data.status, 'closed')
  // A consistent persisted past-due incident models an existing expired record, without changing the clock.
  const expiredConfig = structuredClone(config)
  expiredConfig.retention.expiresAt = new Date(Date.now() - 86400000).toISOString()
  const Incident = (await import(join(root, 'app/Models/PublicSafetyIncident.ts'))).default
  const incident = await Incident.where('incident_key', config.id).first()
  await incident.update({ config_json: publicSafetyRecordingData(expiredConfig), retain_until: expiredConfig.retention.expiresAt })
  for (const path of ['', `/sources/${sourceDigest}`, '/sources', `/observations/${observation.data.observation.id}`, '/observations', `/observations/${observation.data.observation.id}/reviews`, '/audit']) assert.equal((await send('GET', key + path, token)).status, 404)
  const preview = await send('GET', `${custody}/preview`, custodian.token)
  assert.equal(preview.status, 200); scopeFlags(preview.data)
  assert.equal(preview.data.expired, true)
  assert.equal(preview.data.originalHold, 'declared-review-required')
  assert.equal(preview.data.incidentVersion, incidentVersion)
  const enrollBody = { expectedVersion: incidentVersion, policyVersion: 'local-managed-v1', inventoryDigest: preview.data.inventoryDigest, requestId: randomUUID() }
  assert.equal((await send('POST', `${custody}/enrollment`, token, { ...enrollBody, inventoryDigest: priorPreview.data.inventoryDigest })).status, 409)
  assert.equal((await send('GET', custody, token)).status, 404)
  const enrollment = await send('POST', `${custody}/enrollment`, null, enrollBody, { cookie, 'x-csrf-token': csrf })
  assert.equal(enrollment.status, 200); incidentVersion++
  let retentionVersion = 1
  scopeFlags(enrollment.data.scope); minimal(enrollment.data.event)
  assert.equal(enrollment.data.scope.expired, true)
  assert.equal(enrollment.data.scope.holdState, 'pending-review')
  assert.equal(enrollment.data.scope.reviewRequired, true)
  assert.equal(enrollment.data.scope.reviewOverdue, false)
  assert.equal(enrollment.data.scope.reviewDueAt, null)
  assert.equal(enrollment.data.event.actorUserId, custodian.id)
  assert.equal(enrollment.data.replayed, false)
  const enrollmentAgain = await send('POST', `${custody}/enrollment`, token, enrollBody)
  assert.equal(enrollmentAgain.data.replayed, true)
  assert.deepEqual(enrollmentAgain.data.event, enrollment.data.event)
  assert.equal((await send('POST', `${custody}/enrollment`, token, { ...enrollBody, inventoryDigest: 'a'.repeat(64) })).status, 409)
  const full = await send('GET', custody, token), custodyRead = await send('GET', custody, custodian.token), readScope = await send('GET', custody, readOnly.plainTextToken)
  assert.deepEqual(full.data.capabilities, { canManageHold: true, canRevokeMembers: true })
  assert.deepEqual(custodyRead.data.capabilities, { canManageHold: true, canRevokeMembers: false })
  assert.deepEqual(readScope.data.capabilities, { canManageHold: false, canRevokeMembers: false })
  for (const receipt of [full.data, custodyRead.data, readScope.data]) scopeFlags(receipt)
  const holdBody = { expectedRetentionVersion: retentionVersion, decision: 'retain', caseReference: 'fixture:case-1', reviewDueAt: new Date(Date.now() + 86400000).toISOString(), requestId: randomUUID() }
  assert.equal((await send('POST', `${custody}/hold`, token, { ...holdBody, requestId: enrollBody.requestId })).status, 409)
  for (const changed of [{ expectedRetentionVersion: '1' }, { actorUserId: coordinator.id }, { note: privateNote }, { caseReference: 'narrative not permitted' }, { requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { reviewDueAt: new Date(Date.now() + 31 * 86400000).toISOString() }]) assert.equal((await send('POST', `${custody}/hold`, token, { ...holdBody, ...changed })).status, 422)
  const holdJson = JSON.stringify(holdBody), exactHold = holdJson + ' '.repeat(8192 - Buffer.byteLength(holdJson))
  assert.equal((await send('POST', `${custody}/hold`, token, exactHold + ' ')).status, 413)
  const held = await send('POST', `${custody}/hold`, custodian.token, exactHold)
  assert.equal(held.status, 200); retentionVersion++; incidentVersion++
  assert.equal(held.data.scope.holdState, 'held'); scopeFlags(held.data.scope); minimal(held.data.event)
  assert.equal(held.data.scope.retainUntil, expiredConfig.retention.expiresAt)
  assert.equal((await send('GET', `${key}/sources/${sourceDigest}`, token)).status, 404)
  const releaseBody = { expectedRetentionVersion: retentionVersion, decision: 'release', caseReference: 'fixture:case-2', reviewDueAt: null, requestId: randomUUID() }
  const released = await send('POST', `${custody}/hold`, token, releaseBody)
  assert.equal(released.status, 200); retentionVersion++; incidentVersion++
  assert.equal(released.data.scope.holdState, 'released')
  const originalReceipt = await send('POST', `${custody}/hold`, custodian.token, holdBody)
  assert.equal(originalReceipt.data.replayed, true)
  assert.deepEqual(originalReceipt.data.event, held.data.event)
  assert.equal(originalReceipt.data.scope.version, retentionVersion)
  assert.equal(originalReceipt.data.scope.holdState, 'released')
  assert.equal((await send('POST', `${custody}/hold`, token, { ...holdBody, caseReference: 'fixture:changed' })).status, 409)
  assert.equal((await send('GET', key, token)).status, 404)
  // Real revocation after an allowed native Gate must also block an identical receipt replay.
  for (const state of ['token', 'permission', 'membership'] as const) {
    const before = { scope: (await send('GET', custody, token)).data, events: (await send('GET', `${custody}/events`, token)).data }
    const fresh = await createToken(custodian.id, 'late custody revocation', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
    let armed = true, passed = 0
    Gate.after(async (user, ability, allowed, args) => {
      if (!armed || ability !== 'public-safety:retention-manage' || args[0] !== config.id || user?.id !== custodian.id) return
      assert.equal(allowed, true); armed = false; passed++
      if (state === 'token') await revokeToken(fresh.plainTextToken)
      if (state === 'permission') await Rbac.revokePermission(custodian.id, 'public-safety:access', 'web')
      if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('incident_id', '=', incident.id).where('user_id', '=', custodian.id).execute()
    })
    try { assert.equal((await send('POST', `${custody}/hold`, fresh.plainTextToken, holdBody)).status, state === 'token' ? 401 : 403); assert.equal(passed, 1) }
    finally {
      armed = false
      if (state === 'permission') await Rbac.givePermission(custodian.id, 'public-safety:access', 'web')
      if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: true }).where('incident_id', '=', incident.id).where('user_id', '=', custodian.id).execute()
    }
    assert.deepEqual({ scope: (await send('GET', custody, token)).data, events: (await send('GET', `${custody}/events`, token)).data }, before)
  }
  assert.equal((await send('POST', `${custody}/revoke-member`, token, { expectedRetentionVersion: retentionVersion, userId: coordinator.id, requestId: randomUUID() })).status, 409)
  assert.equal((await send('POST', `${custody}/revoke-member`, token, { expectedRetentionVersion: retentionVersion, userId: String(custodian.id), requestId: randomUUID() })).status, 422)
  const revokeBody = { expectedRetentionVersion: retentionVersion, userId: custodian.id, requestId: randomUUID() }
  const revoked = await send('POST', `${custody}/revoke-member`, token, revokeBody)
  assert.equal(revoked.status, 200); retentionVersion++; incidentVersion++
  assert.equal(revoked.data.event.targetUserId, custodian.id)
  const revokedAgain = await send('POST', `${custody}/revoke-member`, token, revokeBody)
  assert.equal(revokedAgain.data.replayed, true)
  assert.deepEqual(revokedAgain.data.event, revoked.data.event)
  assert.equal((await send('POST', `${custody}/revoke-member`, token, { ...revokeBody, userId: pilot.id })).status, 409)
  for (const path of ['', '/preview', '/events']) assert.equal((await send('GET', custody + path, custodian.token)).status, 403)
  assert.equal((await send('POST', `${custody}/hold`, custodian.token, holdBody, { 'x-fixture-unread': 'revoked-custodian' })).status, 403)
  assert.equal(observedBodies.get('revoked-custodian'), false)
  const eventPage = await send('GET', `${custody}/events?limit=1`, token)
  assert.equal(eventPage.data.entries[0].sequence, 1); assert.equal(eventPage.data.hasMore, true)
  const middle = await send('GET', `${custody}/events?after=1&limit=2`, token)
  assert.deepEqual(middle.data.entries.map((event: any) => event.sequence), [2, 3]); assert.equal(middle.data.hasMore, true)
  const last = await send('GET', `${custody}/events?after=3`, token)
  assert.deepEqual(last.data.entries.map((event: any) => event.sequence), [4]); assert.equal(last.data.hasMore, false)
  const events = await send('GET', `${custody}/events`, token)
  minimal(events.data)
  assert.deepEqual(events.data.entries.map((event: any) => event.action), ['enrolled', 'hold-reviewed', 'hold-reviewed', 'member-revoked'])
  assert.deepEqual(events.data.entries.map((event: any) => event.incidentVersion), [10, 11, 12, 13])
  assert.equal((await send('GET', custody, token)).data.version, retentionVersion)
  for (const query of ['limit=101', 'after=-1', 'after=01', 'after=1%0A', 'limit=1&limit=2', 'afterSequence=1', 'userId=1']) assert.equal((await send('GET', `${custody}/events?${query}`, token)).status, 422)
  for (const path of ['', '/preview']) assert.equal((await send('GET', `${custody}${path}?id=1`, token)).status, 422)
  assert.equal((await send('POST', `${custody}/hold?userId=1`, token, '{', { 'x-fixture-unread': 'query-denied' })).status, 422)
  assert.equal(observedBodies.get('query-denied'), false)
  assert.equal((await send('GET', `/${legacy.id}/retention/events`, token)).status, 404)
  for (const slug of ['public-safety-retention-scope', 'public-safety-retention-event']) {
    for (const [method, suffix] of [['GET', ''], ['POST', ''], ['PATCH', '/1'], ['DELETE', '/1']] as const) {
      const denied = await check(await fetch(`http://127.0.0.1:${server.port}/api/dashboard/models/${slug}${suffix}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' || method === 'PATCH' ? { body: '{"fields":{"holdState":"released"}}' } : {}) }))
      assert.equal(denied.status, 404)
    }
  }
  assert.equal((await check(await fetch(`http://127.0.0.1:${server.port}/api/dashboard/models`))).status, 404)
  console.log(`PASS native retention custody HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
