import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'

// Guard runs before models, database or authorization can be loaded or written.
const { root, database, User } = await setupIncidentDatabase({
  prepare: root => writeFile(join(root, 'app/Models/Session.ts'), `import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'
export default defineModel({name:'Session',table:'sessions',primaryKey:'id',autoIncrement:false,traits:{useApi:false,useTimestamps:false},attributes:{
id:{required:true,validation:{rule:schema.string()}},userId:{required:true,validation:{rule:schema.number().integer()}},
ipAddress:{validation:{rule:schema.string().optional()}},userAgent:{validation:{rule:schema.string().optional()}},
payload:{required:true,validation:{rule:schema.string()}},lastActivity:{required:true,validation:{rule:schema.number().integer()}},expiresAt:{required:true,validation:{rule:schema.string()}}
}})`),
})
assert((await database.generateMigrations()).isOk)
assert((await database.runDatabaseMigration()).isOk)
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken, revokeToken, findToken } = await import('@stacksjs/auth/tokens')
const { authCookieName } = await import('@stacksjs/auth/cookie')
const { sessionLogin, sessionCheck } = await import('@stacksjs/auth/session-auth')
const { Gate } = await import('@stacksjs/auth/gate')
const { route } = await import('@stacksjs/router')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const observedBodies = new Map<string, boolean>()
route.use(async (request: Request, next: () => Response | null | Promise<Response | null>) => {
  try { return await next() }
  finally { const marker = request.headers.get('x-fixture-unread'); if (marker) observedBodies.set(marker, request.bodyUsed) }
})
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents`
try {
  const people = new Map<string, { id: number, token: string }>()
  for (const name of ['coordinator', 'recipient', 'other', 'outsider']) {
    const user = await User.create({ name, email: `${name}@example.invalid`, password: 'temporary-fixture-password' })
    people.set(name, { id: user.id, token: (await createToken(user.id, name, ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken })
  }
  const coordinator = people.get('coordinator')!, recipient = people.get('recipient')!, other = people.get('other')!, outsider = people.get('outsider')!
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const person of people.values()) await Rbac.givePermission(person.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const send = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof ReadableStream ? body : body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) }) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')!.toLowerCase().split(',').map(value => value.trim())
    assert(vary.includes('authorization') && vary.includes('cookie'))
    const data = await response.json() as any
    if (response.status >= 400) { assert.deepEqual(Object.keys(data), ['error']); for (const privateValue of ['SELECT', root, 'temporary-fixture-password']) assert(!JSON.stringify(data).includes(privateValue)) }
    return { status: response.status, data }
  }
  const config = examplePublicSafetyConfig()
  config.id = 'wire-handover'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const key = `/${config.id}`
  assert.equal((await send('POST', '', coordinator.token, { config })).status, 201)
  assert.equal((await send('PUT', `${key}/members`, coordinator.token, { expectedVersion: 1, userId: recipient.id, role: 'observer' })).status, 200)
  assert.equal((await send('PUT', `${key}/members`, coordinator.token, { expectedVersion: 2, userId: other.id, role: 'observer' })).status, 200)
  const recording = simulatePublicSafety({ config, seconds: 10 })
  const admitted = await send('POST', `${key}/sources`, coordinator.token, { expectedVersion: 3, recording: JSON.parse(publicSafetyRecordingData(recording)) })
  assert.equal(admitted.status, 201)
  const version = async () => (await send('GET', key, coordinator.token)).data.version
  const capture = recording.survey.captures[0]!, support = recording.captures[0]!.support.findIndex(value => value === 1)
  assert(support >= 0)
  const observationInput = { sourceDigest: admitted.data.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'Wire handover observation é', uncertaintyNote: 'Explicit synthetic uncertainty é' }
  const observation = await send('POST', `${key}/observations`, coordinator.token, { ...observationInput, expectedVersion: await version() })
  assert.equal(observation.status, 201)
  const reviewInput = { sourceDigest: admitted.data.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Wire handover source review é' }
  const review = await send('POST', `${key}/observations/${observation.data.observation.id}/reviews`, coordinator.token, { ...reviewInput, expectedVersion: await version() })
  assert.equal(review.status, 201)
  const desk = await send('GET', `${key}/handover`, coordinator.token)
  assert.equal(desk.status, 200, 'The native handover desk route must exist')
  const readOnly = (await createToken(recipient.id, 'handover read only', ['public-safety:read'], { withRefreshToken: false })).plainTextToken
  const coordinateOnly = (await createToken(coordinator.id, 'handover coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  const incomingCoordinate = (await createToken(recipient.id, 'incoming coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  assert.equal((await send('GET', `${key}/handover`, coordinateOnly)).status, 403)
  assert.equal((await send('GET', `${key}/handover`, readOnly)).status, 200)
  const session = await sessionLogin('coordinator@example.invalid', 'temporary-fixture-password')
  assert.equal(await sessionCheck(session.sessionId), true)
  const stream = (size: number) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(size).fill(32)); controller.close() } })
  for (const path of ['offer', 'decision']) {
    for (const [credential, headers, status, marker] of [
      [null, {}, 401, `anonymous-${path}`],
      [outsider.token, {}, 403, `outsider-${path}`],
      [readOnly, {}, 403, `read-only-${path}`],
      [null, { cookie: `session_id=${session.sessionId}; X-CSRF-Token=${'a'.repeat(64)}`, 'x-csrf-token': 'a'.repeat(64) }, 401, `session-${path}`],
      [null, { cookie: `${authCookieName()}=${coordinator.token}` }, 403, `csrf-${path}`],
    ] as const) {
      assert.equal((await send('POST', `${key}/handover/${path}`, credential, stream(8193), { ...headers, 'x-fixture-unread': marker })).status, status, marker)
      assert.equal(observedBodies.get(marker), false, marker)
    }
  }
  const offerInput = { requestId: randomUUID(), assignment: desk.data.assignment, recipientUserId: recipient.id, recipientMembershipVersion: 1, sourceDigest: admitted.data.source.digest, outgoingRole: 'observer', expiresInSeconds: 300 }
  const offerJson = JSON.stringify(offerInput)
  assert.equal((await send('POST', `${key}/handover/offer`, coordinator.token, offerJson.replace('"requestId":', '"requestId":"00000000-0000-4000-8000-000000000001","requestId":'))).status, 400, 'Duplicate request identity must not be collapsed')
  assert.equal((await send('POST', `${key}/handover/offer`, coordinator.token, offerJson.replace('"coordinatorId":', String.raw`"coordinator\u0049d":0,"coordinatorId":`))).status, 400, 'Escaped nested duplicate keys must be refused')
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, '{', { 'content-type': 'text/plain', 'x-fixture-unread': 'media' })).status, 415)
  assert.equal(observedBodies.get('media'), false)
  assert.equal((await send('POST', `${key}/handover/offer?actorId=1`, coordinateOnly, '{', { 'x-fixture-unread': 'write-query' })).status, 422)
  assert.equal(observedBodies.get('write-query'), false)
  for (const body of [{ ...offerInput, actorId: coordinator.id }, { ...offerInput, assignment: { ...offerInput.assignment, actorId: coordinator.id } }, { ...offerInput, requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }]) assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, body)).status, 422)
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, stream(8193))).status, 413)
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, 'é'.repeat(4097))).status, 413)
  const lying = new Request(`${base}${key}/handover/offer`, { method: 'POST', headers: { authorization: `Bearer ${coordinateOnly}`, 'content-type': 'application/json', 'content-length': '1' }, body: stream(8193) })
  const lyingResult = await route.handleRequest(lying as Parameters<typeof route.handleRequest>[0])
  assert(lyingResult)
  assert.equal(lyingResult.status, 413)
  assert.equal(lyingResult.headers.get('cache-control'), 'private, no-store')
  assert.deepEqual(Object.keys(await lyingResult.json() as object), ['error'])
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, new Uint8Array([0xff]))).status, 400)
  const exact = offerJson.padEnd(8192, ' ')
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, exact + ' ')).status, 413)
  const beforeFailedOffer = await version()
  const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
  writer.exec("CREATE TRIGGER handover_http_private_failure BEFORE INSERT ON public_safety_audits WHEN NEW.action = 'handover-offered' BEGIN SELECT RAISE(ABORT, 'private-handover-driver-canary'); END")
  try {
    const failed = await send('POST', `${key}/handover/offer`, coordinateOnly, exact)
    assert.equal(failed.status, 500)
    assert(!JSON.stringify(failed.data).includes('private-handover-driver-canary'))
  }
  finally { writer.exec('DROP TRIGGER handover_http_private_failure'); writer.close() }
  assert.equal(await version(), beforeFailedOffer, 'A native audit insert failure must roll back the offered common sequence')
  const offered = await send('POST', `${key}/handover/offer`, coordinateOnly, exact)
  assert.equal(offered.status, 201)
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, exact)).status, 200)
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, { ...offerInput, outgoingRole: 'pilot' })).status, 409)
  for (const query of ['offer=x', 'offer=00000000-0000-4000-8000-000000000001&offer=00000000-0000-4000-8000-000000000001', 'after=0&after=0', 'limit=1&limit=2', 'after=01', 'after=1%0A', 'after=-1', 'limit=0', 'limit=101', 'actorId=1', 'offerKey=x']) assert.equal((await send('GET', `${key}/handover?${query}`, recipient.token)).status, 422, query)
  const hidden = await send('GET', `${key}/handover`, other.token)
  assert.equal(hidden.data.offer, null)
  assert.equal(hidden.data.briefing, null)
  assert.equal((await send('GET', `${key}/handover?offer=${offered.data.offer.key}`, other.token)).status, 404)
  assert.equal((await send('POST', `${key}/handover/decision`, other.token, { requestId: randomUUID(), offerKey: offered.data.offer.key, decision: 'decline' })).status, 404)
  assert.equal((await send('POST', `${key}/handover/decision`, coordinator.token, { requestId: randomUUID(), offerKey: offered.data.offer.key, decision: 'decline' })).status, 403)
  const incoming = await send('GET', `${key}/handover?offer=${offered.data.offer.key}&limit=1`, recipient.token)
  assert.equal(incoming.status, 200)
  assert.equal(incoming.data.briefing.entries[0].id, observation.data.observation.id)
  assert.equal(incoming.data.briefing.entries[0].uncertaintyNote, observationInput.uncertaintyNote)
  assert.equal(incoming.data.briefing.hasMore, true)
  const secondPage = await send('GET', `${key}/handover?offer=${offered.data.offer.key}&after=${incoming.data.briefing.cursor}&limit=1`, recipient.token)
  assert.equal(secondPage.data.briefing.entries[0].id, review.data.review.id)
  assert.equal(secondPage.data.briefing.entries[0].uncertaintyNote, observationInput.uncertaintyNote)
  assert.equal(secondPage.data.briefing.entries[0].selfReview, true)
  assert.equal(secondPage.data.briefing.hasMore, false)
  for (const packet of [incoming.data, secondPage.data]) {
    const encoded = JSON.stringify(packet)
    for (const field of ['canonicalJson', 'canonical_json', 'thermalCentiKelvin', 'rgba', 'support']) assert(!encoded.includes(`"${field}"`), field)
    for (const value of [packet.offer.source, packet.briefing, ...packet.briefing.entries]) {
      assert.equal(value.sourceIdentityAuthenticated, false)
      assert.equal(value.physicalThermalVerified, false)
      assert.equal(value.physicalFlightEnabled, false)
    }
  }
  const later = await send('POST', `${key}/observations`, recipient.token, { ...observationInput, note: 'Later observation excluded from acknowledged snapshot', expectedVersion: await version() })
  assert.equal(later.status, 201)
  assert.equal((await send('POST', `${key}/observations/${later.data.observation.id}/reviews`, coordinator.token, { ...reviewInput, expectedVersion: await version() })).status, 201)
  const current = await send('GET', `${key}/handover?offer=${offered.data.offer.key}`, recipient.token)
  assert.equal(current.data.briefing.entries.length, 2)
  assert.deepEqual(current.data.briefing.newerContext, { throughSequence: await version(), observations: 1, reviews: 1 })
  const accept = { requestId: randomUUID(), offerKey: offered.data.offer.key, decision: 'accept', acknowledgement: current.data.briefing.acknowledgementRequired }
  for (const body of [{ ...accept, actorId: recipient.id }, { ...accept, acknowledgement: { ...accept.acknowledgement, uncertaintyAcknowledged: false } }, { ...accept, acknowledgement: { ...accept.acknowledgement, actorId: recipient.id } }]) assert.equal((await send('POST', `${key}/handover/decision`, recipient.token, body)).status, 422)
  assert.equal((await send('POST', `${key}/handover/decision`, recipient.token, JSON.stringify(accept).replace('"decision":', '"decision":"cancel","decision":'))).status, 400)
  const csrf = 'a'.repeat(64), cookie = `${authCookieName()}=${incomingCoordinate}; X-CSRF-Token=${csrf}`
  const accepted = await send('POST', `${key}/handover/decision`, null, accept, { cookie, 'x-csrf-token': csrf })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.data.incident.coordinatorId, recipient.id)
  assert.equal(accepted.data.offer.state, 'accepted')
  assert.equal(accepted.data.replayed, false)
  assert.deepEqual(accepted.data.event.acknowledgement, current.data.briefing.acknowledgementRequired)
  assert.deepEqual(accepted.data.event.newerContext, current.data.briefing.newerContext)
  const historical = await send('GET', `${key}/handover?offer=${offered.data.offer.key}`, recipient.token)
  assert.equal(historical.data.briefing, null)
  assert.equal(historical.data.actionability.canAccept, false)
  const replayed = await send('POST', `${key}/handover/decision`, incomingCoordinate, accept)
  assert.equal(replayed.status, 200)
  assert.equal(replayed.data.replayed, true)
  assert.equal(replayed.data.event.sequence, accepted.data.event.sequence)
  assert.equal((await send('POST', `${key}/handover/decision`, incomingCoordinate, { ...accept, acknowledgement: { ...accept.acknowledgement, contextThroughSequence: accept.acknowledgement.contextThroughSequence + 1 } })).status, 409)
  assert.equal((await send('POST', `${key}/handover/offer`, coordinateOnly, offerInput)).data.replayed, true)
  // Issue a genuine delegated native OAuth credential; ordinary auth must refuse it.
  const { resolveOAuthProviderConfig } = await import('@stacksjs/auth/oauth-provider')
  const { registerOAuthClient } = await import('@stacksjs/auth/oauth-client-registration')
  const { createOAuthGrant } = await import('@stacksjs/auth/oauth-grants')
  const { issueAuthorizationCode } = await import('@stacksjs/auth/oauth-authorization-codes')
  const { createS256CodeChallenge } = await import('@stacksjs/auth/oauth-pkce')
  const { exchangeOAuthAuthorizationCode } = await import('@stacksjs/auth/oauth-token-exchange')
  const scopes = ['public-safety:read', 'public-safety:coordinate']
  const provider = resolveOAuthProviderConfig({ enabled: true, issuer: 'https://incident.invalid', scopes: { 'public-safety:read': { description: 'Read incident' }, 'public-safety:coordinate': { description: 'Coordinate incident' } } })
  assert(provider)
  const redirectUri = 'https://fixture-client.invalid/callback'
  const { client } = await registerOAuthClient(provider, recipient.id, { name: 'Handover delegated fixture', type: 'public', tokenEndpointAuthMethod: 'none', redirectUris: [redirectUri], grantTypes: ['authorization_code'], scopes, resources: [] })
  const grant = await createOAuthGrant({ clientId: client.id, subjectType: 'users', subjectId: recipient.id, scopes, resources: [], audiences: [] })
  const codeVerifier = 'fixture-code-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const code = await issueAuthorizationCode({ grantId: grant.id, redirectUri, codeChallenge: await createS256CodeChallenge(codeVerifier), lifetimeMs: 60000 })
  const exchanged = await exchangeOAuthAuthorizationCode({ code, clientId: client.id, redirectUri, codeVerifier, accessTokenLifetimeMs: 60000, refreshTokenLifetimeMs: 60000 })
  assert(exchanged.ok)
  assert.equal((await findToken(exchanged.value.accessToken))?.grantId, grant.id)
  for (const path of ['offer', 'decision']) {
    const marker = `delegated-${path}`
    assert.equal((await send('POST', `${key}/handover/${path}`, exchanged.value.accessToken, stream(8193), { 'x-fixture-unread': marker })).status, 401)
    assert.equal(observedBodies.get(marker), false)
  }
  // The real Gate permits the fresh actor, then its after callback revokes native state.
  // Parsing may run, but the domain's actual transaction must recheck current authority.
  for (const state of ['token', 'permission', 'membership'] as const) {
    const fresh = await createToken(recipient.id, 'handover late revocation', scopes, { withRefreshToken: false })
    let armed = true, passed = 0
    Gate.after(async (user, ability, allowed, args) => {
      if (!armed || ability !== 'public-safety:handover-write' || args[0] !== config.id || user?.id !== recipient.id) return
      assert.equal(allowed, true); armed = false; passed++
      if (state === 'token') await revokeToken(fresh.plainTextToken)
      if (state === 'permission') await Rbac.revokePermission(recipient.id, 'public-safety:access', 'web')
      if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('user_id', '=', recipient.id).execute()
    })
    try {
      const marker = `gate-revoked-${state}`
      assert.equal((await send('POST', `${key}/handover/decision`, fresh.plainTextToken, accept, { 'x-fixture-unread': marker })).status, state === 'token' ? 401 : 403)
      assert.equal(passed, 1)
      assert.equal(observedBodies.get(marker), true)
    }
    finally {
      armed = false
      if (state === 'permission') await Rbac.givePermission(recipient.id, 'public-safety:access', 'web')
      if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: true }).where('user_id', '=', recipient.id).execute()
    }
    assert.equal(await version(), accepted.data.incident.version)
  }
  assert.equal((await send('PUT', `${key}/members`, recipient.token, { expectedVersion: await version(), userId: coordinator.id, role: 'coordinator' })).status, 422)
  assert.equal((await send('POST', `${key}/close`, recipient.token, { expectedVersion: await version() })).status, 200)
  const closed = await send('GET', `${key}/handover?offer=${offered.data.offer.key}`, recipient.token)
  assert.equal(closed.status, 200)
  assert.equal(closed.data.offer.state, 'accepted')
  assert.equal(closed.data.briefing, null)
  assert.deepEqual(closed.data.actionability, { canOffer: false, canAccept: false, canDecline: false, canCancel: false })
  assert.equal((await send('POST', `${key}/handover/decision`, recipient.token, accept)).status, 409)
  assert.equal((await send('POST', `${key}/handover/offer`, coordinator.token, offerInput)).status, 409)
  const foreignConfig = structuredClone(config); foreignConfig.id = 'wire-handover-foreign'
  const foreignKey = `/${foreignConfig.id}`
  assert.equal((await send('POST', '', coordinator.token, { config: foreignConfig })).status, 201)
  assert.equal((await send('GET', `${foreignKey}/handover?offer=${offered.data.offer.key}`, coordinator.token)).status, 404)
  assert.equal((await send('POST', `${foreignKey}/handover/decision`, coordinator.token, accept)).status, 404)
  assert.equal((await send('PUT', `${foreignKey}/members`, coordinator.token, { expectedVersion: 1, userId: recipient.id, role: 'observer' })).status, 200)
  const foreignSource = await send('POST', `${foreignKey}/sources`, coordinator.token, { expectedVersion: 2, recording: JSON.parse(publicSafetyRecordingData(simulatePublicSafety({ config: foreignConfig, seconds: 10 }))) })
  assert.equal(foreignSource.status, 201)
  let foreignOffer = await send('POST', `${foreignKey}/handover/offer`, coordinator.token, { ...offerInput, requestId: randomUUID(), assignment: { kind: 'incident-coordination', coordinatorId: coordinator.id, coordinatorMembershipVersion: 1 }, sourceDigest: foreignSource.data.source.digest })
  assert.equal(foreignOffer.status, 201)
  const decline = { requestId: randomUUID(), offerKey: foreignOffer.data.offer.key, decision: 'decline' }
  const declined = await send('POST', `${foreignKey}/handover/decision`, recipient.token, decline)
  assert.equal(declined.status, 200)
  assert.equal(declined.data.offer.state, 'declined')
  assert.equal(declined.data.incident.coordinatorId, coordinator.id)
  assert.equal(declined.data.event.acknowledgement, null)
  assert.equal((await send('POST', `${foreignKey}/handover/decision`, recipient.token, decline)).data.replayed, true)
  const replacementInput = { ...offerInput, requestId: randomUUID(), assignment: { kind: 'incident-coordination', coordinatorId: coordinator.id, coordinatorMembershipVersion: 1 }, sourceDigest: foreignSource.data.source.digest }
  foreignOffer = await send('POST', `${foreignKey}/handover/offer`, coordinator.token, replacementInput)
  assert.equal(foreignOffer.status, 201)
  const canceled = await send('POST', `${foreignKey}/handover/decision`, coordinator.token, { requestId: randomUUID(), offerKey: foreignOffer.data.offer.key, decision: 'cancel' })
  assert.equal(canceled.status, 200)
  assert.equal(canceled.data.offer.state, 'canceled')
  assert.equal(canceled.data.incident.coordinatorId, coordinator.id)
  assert.equal(canceled.data.event.acknowledgement, null)
  foreignOffer = await send('POST', `${foreignKey}/handover/offer`, coordinator.token, { ...replacementInput, requestId: randomUUID() })
  assert.equal(foreignOffer.status, 201)
  const retained = (await send('GET', `${foreignKey}/retention/preview`, coordinator.token)).data
  assert.equal((await send('POST', `${foreignKey}/retention/enrollment`, coordinator.token, { expectedVersion: foreignOffer.data.incident.version, policyVersion: 'local-managed-v1', inventoryDigest: retained.inventoryDigest, requestId: randomUUID() })).status, 200)
  assert.equal((await send('POST', `${foreignKey}/close`, coordinator.token, { expectedVersion: foreignOffer.data.incident.version + 1 })).status, 200)
  const pendingClosed = await send('GET', `${foreignKey}/handover?offer=${foreignOffer.data.offer.key}`, recipient.token)
  assert.equal(pendingClosed.status, 200)
  assert.equal(pendingClosed.data.offer.state, 'invalidated')
  assert.equal(pendingClosed.data.briefing, null)
  assert.deepEqual(pendingClosed.data.actionability, { canOffer: false, canAccept: false, canDecline: false, canCancel: false })
  // Persisted-state fault qualification of the native freeze refusal, separate from accepted purge qualification.
  await database.db.primary.updateTable('public_safety_retention_scopes').set({ freeze_state: 'frozen' }).where('incident_id', '=', (await database.db.primary.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', foreignConfig.id).executeTakeFirst())!.id).execute()
  assert.equal((await send('GET', `${foreignKey}/handover`, coordinator.token)).status, 409)
  for (const path of ['offer', 'decision']) {
    const marker = `frozen-${path}`
    assert.equal((await send('POST', `${foreignKey}/handover/${path}`, coordinator.token, '{', { 'x-fixture-unread': marker })).status, 409)
    assert.equal(observedBodies.get(marker), false)
  }
  console.log(`PASS native incident handover HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
