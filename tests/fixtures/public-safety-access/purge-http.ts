import assert from 'node:assert/strict'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import { randomUUID } from 'node:crypto'

// A fixture-only model generates the native session table; no application session API is installed.
const { root, database, User } = await setupIncidentDatabase({
  prepare: async root => {
    delete process.env.PUBLIC_SAFETY_PURGE_ENABLED
    await writeFile(join(root, 'app/Models/IncidentOperator.ts'), "import { extendModel } from '@stacksjs/orm'\nimport User from './User'\nexport default extendModel(User, { name: 'IncidentOperator', table: 'incident_operators' })\n")
    await mkdir(join(root, 'managed'), { mode: 0o700 })
    process.env.PUBLIC_SAFETY_MANAGED_ROOT = join(root, 'managed')
    await writeFile(join(root, 'app/Models/Session.ts'), `import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'
export default defineModel({name:'Session',table:'sessions',primaryKey:'id',autoIncrement:false,traits:{useApi:false,useTimestamps:false},attributes:{
id:{required:true,validation:{rule:schema.string()}},userId:{required:true,validation:{rule:schema.number().integer()}},
ipAddress:{validation:{rule:schema.string().optional()}},userAgent:{validation:{rule:schema.string().optional()}},
payload:{required:true,validation:{rule:schema.string()}},lastActivity:{required:true,validation:{rule:schema.number().integer()}},expiresAt:{required:true,validation:{rule:schema.string()}}
}})`)
  },
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
let lateReceipt: { deadline: number, responseStatus: number | null } | undefined
route.use(async (request: Request, next: () => Response | null | Promise<Response | null>) => {
  try {
    const result = await next()
    if (lateReceipt && request.headers.has('x-fixture-receipt-delay')) {
      lateReceipt.responseStatus = result?.status ?? null
      assert(Date.now() < lateReceipt.deadline, 'Late middleware must observe the response before its real deadline')
      await Bun.sleep(Math.max(1, lateReceipt.deadline - Date.now() + 10))
      assert(Date.now() >= lateReceipt.deadline)
    }
    return result
  }
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
  for (const name of ['coordinator', 'custodian', 'pilot', 'observer', 'reviewer', 'outsider', 'receipt-custodian']) {
    const user = await User.create({ name, email: `${name}@example.invalid`, password: 'temporary-fixture-password' })
    people.set(name, { id: user.id, token: (await createToken(user.id, 'purge wire fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken })
  }
  const coordinator = people.get('coordinator')!, custodian = people.get('custodian')!, pilot = people.get('pilot')!, observer = people.get('observer')!, reviewer = people.get('reviewer')!, outsider = people.get('outsider')!
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const user of people.values()) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const raw = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const check = async (response: Response) => {
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim())
    assert(vary?.includes('authorization') && vary.includes('cookie'))
    const data = await response.json() as any
    if (response.status >= 400) { assert.deepEqual(Object.keys(data), ['error']); for (const secret of ['SELECT', root, 'temporary-fixture-password']) assert(!JSON.stringify(data).includes(secret)) }
    return { status: response.status, data }
  }
  const send = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => raw(method, path, token, body, headers).then(check)
  const receiptCustodian = people.get('receipt-custodian')!
  const config = examplePublicSafetyConfig()
  config.id = 'accepted-purge-wire'
  config.retention.expiresAt = new Date(Date.now() + 20000).toISOString()
  config.retention.hold = 'none'
  const key = `/${config.id}`, custody = `${key}/retention`, collection = `${custody}/purge`, token = coordinator.token
  assert.equal((await send('POST', '', token, { config })).status, 201)
  for (const [user, role] of [[custodian, 'evidence-custodian'], [receiptCustodian, 'evidence-custodian'], [pilot, 'pilot'], [observer, 'observer'], [reviewer, 'reviewer']] as const) {
    const version = (await send('GET', key, token)).data.version
    assert.equal((await send('PUT', `${key}/members`, token, { expectedVersion: version, userId: user.id, role })).status, 200)
  }
  const recording = JSON.parse(publicSafetyRecordingData(simulatePublicSafety({ config, seconds: 10 })))
  const version = async () => (await send('GET', key, token)).data.version
  const admitted = await send('POST', `${key}/sources`, pilot.token, { expectedVersion: await version(), recording })
  assert.equal(admitted.status, 201)
  const sourceDigest = admitted.data.source.digest, capture = recording.survey.captures[0], support = recording.captures[0].support.findIndex((value: number) => value === 1)
  assert(support >= 0)
  const note = 'private-purge-wire-observation', uncertainty = 'private-purge-wire-uncertainty', reviewNote = 'private-purge-wire-review'
  const observation = await send('POST', `${key}/observations`, observer.token, { expectedVersion: await version(), sourceDigest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note, uncertaintyNote: uncertainty })
  assert.equal(observation.status, 201)
  assert.equal((await send('POST', `${key}/observations/${observation.data.observation.id}/reviews`, reviewer.token, { expectedVersion: await version(), sourceDigest, previousReviewId: null, disposition: 'unresolved', note: reviewNote })).status, 201)
  const retained = (await send('GET', `${custody}/preview`, token)).data
  assert.equal((await send('POST', `${custody}/enrollment`, token, { expectedVersion: retained.incidentVersion, inventoryDigest: retained.inventoryDigest, policyVersion: 'local-managed-v1', requestId: randomUUID() })).status, 200)
  const dataset = await send('POST', `${key}/managed-artifacts`, token, { expectedVersion: await version(), expectedRetentionVersion: 1, sourceDigest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() })
  assert.equal(dataset.status, 201)
  const heldConfig = structuredClone(config); heldConfig.id = 'accepted-purge-held'; heldConfig.retention.hold = 'declared-review-required'
  assert.equal((await send('POST', '', token, { config: heldConfig })).status, 201)
  const heldCustody = `/${heldConfig.id}/retention`, heldCollection = `${heldCustody}/purge`
  const heldPreview = (await send('GET', `${heldCustody}/preview`, token)).data
  assert.equal((await send('POST', `${heldCustody}/enrollment`, token, { expectedVersion: heldPreview.incidentVersion, inventoryDigest: heldPreview.inventoryDigest, policyVersion: 'local-managed-v1', requestId: randomUUID() })).status, 200)
  const safe = (input: unknown) => {
    const text = JSON.stringify(input)
    for (const fragment of [note, uncertainty, reviewNote, sourceDigest, root, 'config_json', 'canonical_json', 'planned_json', 'identity_json', 'operation_nonce', 'request_digest', 'birthtimeNs', 'recording.json', dataset.data.artifact.key]) assert(!text.includes(fragment), `private fragment ${fragment}`)
  }
  const initial = await send('GET', `${collection}/preview`, token)
  assert.equal(initial.status, 200); assert.equal(initial.data.executorEnabled, false); assert.equal(initial.data.reason, 'executor-disabled')
  safe(initial.data)
  assert.equal(initial.data.existingPurgeKey, null); assert.equal(initial.data.inventoryKind, 'current-preview')
  assert.equal(initial.data.counts.sources, 1); assert.equal(initial.data.counts.observations, 1); assert.equal(initial.data.counts.reviews, 1); assert.equal(initial.data.counts.managedArtifacts, 1); assert(initial.data.counts.managedFiles > 1)
  const readOnly = (await createToken(custodian.id, 'purge read only', ['public-safety:read'], { withRefreshToken: false })).plainTextToken
  const coordinateOnly = (await createToken(custodian.id, 'purge coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  const placeholder = '00000000-0000-4000-8000-000000000001'
  for (const [credential, expected, name] of [[null, 401, 'anonymous'], [outsider.token, 403, 'outsider'], [pilot.token, 403, 'pilot'], [observer.token, 403, 'observer'], [reviewer.token, 403, 'reviewer']] as const) {
    for (const suffix of ['/preview', `/${placeholder}`, `/${placeholder}/events`]) assert.equal((await send('GET', collection + suffix, credential)).status, expected)
    for (const suffix of ['', `/${placeholder}/retry`]) {
      const marker = `${name}-${suffix}`
      assert.equal((await send('POST', collection + suffix, credential, '{'.padEnd(8193, ' '), { 'x-fixture-unread': marker })).status, expected)
      assert.equal(observedBodies.get(marker), false)
    }
  }
  for (const suffix of ['', `/${placeholder}/retry`]) {
    const marker = `read-only-${suffix}`
    assert.equal((await send('POST', collection + suffix, readOnly, '{', { 'x-fixture-unread': marker })).status, 403)
    assert.equal(observedBodies.get(marker), false)
    assert.equal((await send('POST', collection + suffix, token, '{}'.padEnd(8193, ' '))).status, 413)
    assert.equal((await send('POST', collection + suffix, token, '{}', { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await send('POST', collection + suffix, token, '{')).status, 400)
    assert.equal((await send('POST', `${collection}${suffix}?actor=1`, token, '{', { 'x-fixture-unread': 'query' })).status, 422)
    assert.equal(observedBodies.get('query'), false)
    assert.equal((await send('POST', collection + suffix, null, '{', { cookie: `${authCookieName()}=${custodian.token}`, 'x-fixture-unread': 'csrf' })).status, 403)
    assert.equal(observedBodies.get('csrf'), false)
  }
  assert.equal((await send('GET', `${collection}/preview`, readOnly)).status, 200)
  assert.equal((await send('GET', `${collection}/preview`, coordinateOnly)).status, 403)
  const session = await sessionLogin('coordinator@example.invalid', 'temporary-fixture-password')
  assert.equal(await sessionCheck(session.sessionId), true)
  assert.equal((await send('GET', `${collection}/preview`, null, undefined, { cookie: `session_id=${session.sessionId}` })).status, 401)
  const Operator = (await import(join(root, 'app/Models/IncidentOperator.ts'))).default
  const operator = await Operator.create({ name: 'Non-user', email: 'operator@example.invalid', password: 'temporary-fixture-password' })
  assert.equal(operator.id, coordinator.id)
  const nonUser = (await createToken(operator.id, 'non-user', ['public-safety:read', 'public-safety:coordinate'], { tokenableType: 'incident_operators', withRefreshToken: false })).plainTextToken
  const { resolveOAuthProviderConfig } = await import('@stacksjs/auth/oauth-provider')
  const { registerOAuthClient } = await import('@stacksjs/auth/oauth-client-registration')
  const { createOAuthGrant } = await import('@stacksjs/auth/oauth-grants')
  const { issueAuthorizationCode } = await import('@stacksjs/auth/oauth-authorization-codes')
  const { createS256CodeChallenge } = await import('@stacksjs/auth/oauth-pkce')
  const { exchangeOAuthAuthorizationCode } = await import('@stacksjs/auth/oauth-token-exchange')
  const provider = resolveOAuthProviderConfig({ enabled: true, issuer: 'https://incident.invalid', scopes: { 'public-safety:read': { description: 'Read scope' }, 'public-safety:coordinate': { description: 'Coordinate scope' } } })
  assert(provider)
  const redirectUri = 'https://fixture-client.invalid/callback', scopes = ['public-safety:read', 'public-safety:coordinate']
  const { client } = await registerOAuthClient(provider, coordinator.id, { name: 'Purge delegated fixture', type: 'public', tokenEndpointAuthMethod: 'none', redirectUris: [redirectUri], grantTypes: ['authorization_code'], scopes, resources: [] })
  const grant = await createOAuthGrant({ clientId: client.id, subjectType: 'users', subjectId: coordinator.id, scopes, resources: [], audiences: [] })
  const verifier = 'fixture-code-verifier-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const code = await issueAuthorizationCode({ grantId: grant.id, redirectUri, codeChallenge: await createS256CodeChallenge(verifier), lifetimeMs: 60000 })
  const exchanged = await exchangeOAuthAuthorizationCode({ code, clientId: client.id, redirectUri, codeVerifier: verifier, accessTokenLifetimeMs: 60000, refreshTokenLifetimeMs: 60000 })
  assert(exchanged.ok)
  for (const credential of [nonUser, exchanged.value.accessToken]) {
    for (const suffix of ['/preview', `/${placeholder}`, `/${placeholder}/events`]) assert.equal((await send('GET', collection + suffix, credential)).status, 401)
    for (const suffix of ['', `/${placeholder}/retry`]) {
      const marker = `native-credential-${suffix}`
      assert.equal((await send('POST', collection + suffix, credential, '{', { 'x-fixture-unread': marker })).status, 401)
      assert.equal(observedBodies.get(marker), false)
    }
  }
  for (const suffix of ['/preview', `/${placeholder}`]) assert.equal((await send('GET', `${collection}${suffix}?path=secret`, token)).status, 422)
  for (const query of ['after=-1', 'after=01', 'after=1%0A', 'after=2147483648', 'limit=0', 'limit=101', 'limit=1&limit=2', 'after=0&after=1', 'afterSequence=1', 'sourceId=1']) assert.equal((await send('GET', `${collection}/${placeholder}/events?${query}`, token)).status, 422)
  const exclusions = { historicalDiagnostics: true, offlineExports: true, downloadedCopies: true, backupsAndReplicas: true, processMemory: true, mediaResiduals: true }
  const command = (preview: any) => ({ expectedVersion: preview.incidentVersion, expectedRetentionVersion: preview.retentionVersion, inventoryDigest: preview.inventoryDigest, policyVersion: 'local-managed-purge-v1', coverage: 'active-db-and-registered-namespace-v1', exclusions, receiptRetentionDays: 1, requestId: randomUUID() })
  const disabled = command(initial.data)
  assert.equal((await send('POST', collection, token, disabled)).status, 409)
  assert.equal((await send('GET', custody, token)).data.version, 1)
  assert.equal((await send('GET', `${collection}/preview`, token)).data.existingPurgeKey, null)
  process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'true'
  // Wall time advances normally. No database deadline rewrite or clock replacement grants eligibility.
  if (Date.now() < Date.parse(config.retention.expiresAt)) {
    const notDue = (await send('GET', `${collection}/preview`, token)).data
    assert.equal(notDue.reason, 'not-due')
    assert.equal((await send('POST', collection, token, command(notDue))).status, 409)
    await Bun.sleep(Math.max(1, Date.parse(config.retention.expiresAt) - Date.now() + 10))
  }
  const due = (await send('GET', `${collection}/preview`, token)).data
  assert.equal(due.reason, 'eligible'); assert.equal(due.expired, true)
  for (const suffix of ['', '/sources', '/observations', '/audit', `/managed-artifacts/${dataset.data.artifact.key}`]) assert.equal((await send('GET', key + suffix, token)).status, 404)
  const heldDue = (await send('GET', `${heldCollection}/preview`, token)).data
  assert.equal(heldDue.reason, 'held'); assert.equal(heldDue.expired, true)
  assert.equal((await send('POST', heldCollection, token, command(heldDue))).status, 409)
  assert.equal((await send('GET', heldCustody, token)).data.holdState, 'pending-review')
  const accept = command(due)
  for (const changed of [{ actorUserId: coordinator.id }, { root }, { expectedVersion: String(accept.expectedVersion) }, { expectedRetentionVersion: '1' }, { policyVersion: 'local-managed-v1' }, { coverage: 'everything' }, { inventoryDigest: 'A'.repeat(64) }, { inventoryDigest: `${accept.inventoryDigest}\n` }, { receiptRetentionDays: 0 }, { receiptRetentionDays: 366 }, { receiptRetentionDays: '1' }, { exclusions: { ...exclusions, mediaResiduals: false } }, { exclusions: { ...exclusions, extra: true } }, { exclusions: {} }, { requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }, { requestId: `${accept.requestId}\n` }]) assert.equal((await send('POST', collection, token, { ...accept, ...changed })).status, 422)
  assert.equal((await send('POST', collection, token, { ...accept, expectedVersion: accept.expectedVersion + 1 })).status, 409)
  assert.equal((await send('POST', collection, token, { ...accept, expectedRetentionVersion: accept.expectedRetentionVersion + 1 })).status, 409)
  assert.equal((await send('POST', collection, token, { ...accept, inventoryDigest: 'a'.repeat(64) })).status, 409)
  for (const state of ['token', 'permission', 'membership'] as const) {
    const fresh = await createToken(custodian.id, 'purge late revocation', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
    let armed = true, passed = 0
    Gate.after(async (user, ability, allowed, args) => {
      if (!armed || ability !== 'public-safety:purge-accept' || args[0] !== config.id || user?.id !== custodian.id) return
      assert.equal(allowed, true); armed = false; passed++
      if (state === 'token') await revokeToken(fresh.plainTextToken)
      if (state === 'permission') await Rbac.revokePermission(custodian.id, 'public-safety:access', 'web')
      if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('user_id', '=', custodian.id).execute()
    })
    try { assert.equal((await send('POST', collection, fresh.plainTextToken, accept)).status, state === 'token' ? 401 : 403); assert.equal(passed, 1) }
    finally { armed = false; if (state === 'permission') await Rbac.givePermission(custodian.id, 'public-safety:access', 'web'); if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: true }).where('user_id', '=', custodian.id).execute() }
    assert.equal((await send('GET', `${collection}/preview`, token)).data.existingPurgeKey, null)
  }
  const csrf = 'a'.repeat(64), cookie = `${authCookieName()}=${token}; X-CSRF-Token=${csrf}`
  const exact = JSON.stringify(accept).padEnd(8192, ' ')
  assert.equal((await send('POST', collection, token, exact + ' ')).status, 413)
  const accepted = await send('POST', collection, null, exact, { cookie, 'x-csrf-token': csrf })
  assert.equal(accepted.status, 202); assert.equal(accepted.data.replayed, false)
  assert.equal(accepted.data.purge.state, 'building'); assert.equal(accepted.data.purge.contentDeletionPerformed, false)
  assert.deepEqual(accepted.data.event.actor, { kind: 'human', userId: coordinator.id })
  assert.equal(accepted.data.event.action, 'accept')
  const path = `${collection}/${accepted.data.purge.purgeKey}`
  safe(accepted.data)
  for (const suffix of ['', '/events']) assert.equal((await send('GET', `${heldCollection}/${accepted.data.purge.purgeKey}${suffix}`, token)).status, 404)
  assert.equal((await send('POST', `${heldCollection}/${accepted.data.purge.purgeKey}/retry`, token, { expectedPurgeVersion: 1, expectedRetentionVersion: 1, requestId: randomUUID() })).status, 404)
  for (const malformed of ['not-a-uuid', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', `${accepted.data.purge.purgeKey}%0A`]) for (const suffix of ['', '/events']) assert.equal((await send('GET', `${collection}/${malformed}${suffix}`, token)).status, 422)
  for (const flag of ['diagnosticsErased', 'allCopiesErased', 'mediaErasure']) assert.equal(accepted.data.purge[flag], false)
  const reordered = Object.fromEntries(Object.entries({ ...accept, exclusions: Object.fromEntries(Object.entries(exclusions).reverse()) }).reverse())
  const replay = await send('POST', collection, token, reordered)
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true); assert.deepEqual(replay.data.event, accepted.data.event)
  for (const [credential, changed] of [[custodian.token, accept], [token, { ...accept, receiptRetentionDays: 2 }], [token, { ...accept, requestId: randomUUID() }]] as const) assert.equal((await send('POST', collection, credential, changed)).status, 409)
  const discovered = await send('GET', `${collection}/preview`, readOnly)
  assert.equal(discovered.status, 200); assert.equal(discovered.data.reason, 'already-accepted'); assert.equal(discovered.data.inventoryKind, 'accepted-frozen')
  assert.equal(discovered.data.existingPurgeKey, accepted.data.purge.purgeKey); assert.equal(discovered.data.inventoryDigest, due.inventoryDigest)
  assert.deepEqual(discovered.data.counts, due.counts); safe(discovered.data)
  for (const suffix of ['', '/preview', '/events']) assert.equal((await send('GET', custody + suffix, token)).status, 409)
  for (const credential of [token, custodian.token, readOnly]) { assert.equal((await send('GET', path, credential)).status, 200); assert.equal((await send('GET', `${path}/events`, credential)).status, 200) }
  for (const credential of [coordinateOnly, pilot.token, observer.token, reviewer.token, outsider.token]) for (const suffix of ['', '/events']) assert.equal((await send('GET', path + suffix, credential)).status, 403)
  const firstPage = (await send('GET', `${path}/events?after=0&limit=1`, token)).data
  assert.deepEqual(firstPage.entries.map((entry: any) => entry.sequence), [1]); assert.equal(firstPage.cursor, 1); safe(firstPage)
  const current = (await send('GET', path, token)).data
  const retry = { expectedPurgeVersion: current.version, expectedRetentionVersion: current.retentionVersion, requestId: randomUUID() }
  for (const changed of [{ expectedPurgeVersion: '1' }, { expectedRetentionVersion: '2' }, { batchSize: 1 }, { actorUserId: coordinator.id }, { requestId: 'bad' }, { requestId: `${retry.requestId}\n` }]) assert.equal((await send('POST', `${path}/retry`, token, { ...retry, ...changed })).status, 422)
  assert.equal((await send('POST', `${path}/retry`, token, { ...retry, expectedPurgeVersion: current.version + 1 })).status, 409)
  const retried = await send('POST', `${path}/retry`, token, JSON.stringify(retry).padEnd(8192, ' '))
  assert.equal(retried.status, 202); assert.equal(retried.data.replayed, false); assert.equal(retried.data.event.action, 'retry'); safe(retried.data)
  const retriedAgain = await send('POST', `${path}/retry`, token, Object.fromEntries(Object.entries(retry).reverse()))
  assert.equal(retriedAgain.status, 200); assert.equal(retriedAgain.data.replayed, true); assert.deepEqual(retriedAgain.data.event, retried.data.event)
  assert.equal((await send('POST', `${path}/retry`, custodian.token, retry)).status, 409)
  const events = (await send('GET', `${path}/events?after=1&limit=1`, token)).data
  assert.deepEqual(events.entries.map((entry: any) => entry.action), ['retry']); assert.equal(events.hasMore, false)
  // Each allowed outer Gate is followed by a real revocation before the service's fresh authority check.
  for (const [ability, method, endpoint, body] of [
    ['preview', 'GET', `${collection}/preview`, undefined], ['read', 'GET', path, undefined],
    ['events', 'GET', `${path}/events`, undefined], ['retry', 'POST', `${path}/retry`, retry],
  ] as const) for (const state of ['token', 'permission', 'membership'] as const) {
    const fresh = await createToken(custodian.id, 'purge late receipt revocation', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
    let armed = true, passed = 0
    Gate.after(async (user, currentAbility, allowed, args) => {
      if (!armed || currentAbility !== `public-safety:purge-${ability}` || args[0] !== config.id || user?.id !== custodian.id) return
      assert.equal(allowed, true); armed = false; passed++
      if (state === 'token') await revokeToken(fresh.plainTextToken)
      if (state === 'permission') await Rbac.revokePermission(custodian.id, 'public-safety:access', 'web')
      if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('user_id', '=', custodian.id).execute()
    })
    try { assert.equal((await send(method, endpoint, fresh.plainTextToken, body)).status, state === 'token' ? 401 : 403); assert.equal(passed, 1) }
    finally { armed = false; if (state === 'permission') await Rbac.givePermission(custodian.id, 'public-safety:access', 'web'); if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: true }).where('user_id', '=', custodian.id).execute() }
  }
  const revoked = await send('POST', `${custody}/revoke-member`, token, { expectedRetentionVersion: retried.data.purge.retentionVersion, userId: custodian.id, requestId: randomUUID() })
  assert.equal(revoked.status, 200); assert.equal(revoked.data.event.action, 'member-revoked'); assert.deepEqual(revoked.data.event.actor, { kind: 'human', userId: coordinator.id }); safe(revoked.data)
  for (const suffix of ['', '/events']) assert.equal((await send('GET', path + suffix, custodian.token)).status, 403)
  assert.equal((await send('GET', `${collection}/preview`, readOnly)).status, 403)
  assert.equal((await send('GET', path, token)).status, 200)
  assert.equal((await readdir(join(root, 'managed'))).length, 1)
  for (const slug of ['public-safety-purge', 'public-safety-purge-item', 'public-safety-purge-event']) for (const [method, suffix] of [['GET', ''], ['POST', ''], ['PATCH', '/1'], ['DELETE', '/1']] as const) {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/dashboard/models/${slug}${suffix}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' || method === 'PATCH' ? { body: '{"fields":{"state":"complete"}}' } : {}) })
    assert.equal((await check(response)).status, 404)
  }
  const job = (await import('../../../app/Jobs/PublicSafetyPurgeSweep')).default
  let finished = (await send('GET', path, token)).data
  console.log(`HTTP matrix complete, advancing actual native Job nativeRoutes=${nativeRoutes}`)
  for (let index = 0; index < 80 && finished.state !== 'complete'; index++) {
    await job.dispatchNow({ purgeKey: finished.purgeKey })
    finished = (await send('GET', path, token)).data
    if (finished.state === 'blocked') break
  }
  assert.equal(finished.dbState, 'complete'); assert.equal(finished.completed.sourceRowsRemoved, 1)
  assert.equal(finished.completed.observationRowsRemoved, 1); assert.equal(finished.completed.reviewRowsRemoved, 1)
  assert.equal(finished.completed.incidentPayloadRowsCleared, 1); safe(finished)
  if (finished.state === 'complete') {
    assert(finished.completed.namesUnlinked > 0); assert.equal((await readdir(join(root, 'managed'))).length, 0)
    assert.equal(Date.parse(finished.receiptRetainUntil) - Date.parse(finished.completedAt), 86400000)
    assert.equal((await send('GET', path, receiptCustodian.token)).status, 200)
    const tombstone = await send('GET', custody, token)
    assert.equal(tombstone.status, 200); assert.equal(tombstone.data.purged, true); assert.equal(tombstone.data.historyRetired, true)
    assert.deepEqual(Object.keys(tombstone.data).sort(), ['key', 'policyVersion', 'version', 'incidentVersion', 'retainUntil', 'expired', 'purged', 'purgeKey', 'historyRetired', 'capabilities'].sort())
    const retiredEvents = (await send('GET', `${custody}/events`, token)).data
    assert.deepEqual(retiredEvents.entries, []); assert.equal(retiredEvents.historyRetired, true)
    safe(tombstone.data); safe(retiredEvents)
    const completedRevoke = { expectedRetentionVersion: finished.retentionVersion, userId: receiptCustodian.id, requestId: randomUUID() }
    const currentRevoke = await send('POST', `${custody}/revoke-member`, token, completedRevoke)
    assert.equal(currentRevoke.status, 200); assert.equal(currentRevoke.data.event.action, 'member-revoked'); safe(currentRevoke.data)
    for (const suffix of ['', '/events']) assert.equal((await send('GET', path + suffix, receiptCustodian.token)).status, 403)
    assert.equal((await send('GET', `${collection}/preview`, receiptCustodian.token)).status, 403)
    console.log(`PASS actual awaited native Job completed HTTP tombstone lifecycle nativeRoutes=${nativeRoutes}`)
    // Controlled persisted receipt-deadline reconstruction tests stale storage denial, not elapsed one-day qualification.
    const Purge = (await import(join(root, 'app/Models/PublicSafetyPurge.ts'))).default
    const stored = await Purge.where('purge_key', finished.purgeKey).first()
    // Reconstruct only short FUTURE completed-receipt dates, then cross them through actual awaited work.
    // This is deadline-boundary evidence, not a simulated clock or an elapsed day of receipt retention.
    const crossings = [
      { name: 'purge-preview', method: 'GET', endpoint: `${collection}/preview`, body: undefined },
      { name: 'purge-read', method: 'GET', endpoint: path, body: undefined },
      { name: 'purge-events', method: 'GET', endpoint: `${path}/events`, body: undefined },
      { name: 'custody-preview', method: 'GET', endpoint: `${custody}/preview`, body: undefined },
      { name: 'custody-read', method: 'GET', endpoint: custody, body: undefined },
      { name: 'custody-events', method: 'GET', endpoint: `${custody}/events`, body: undefined },
      { name: 'accept-replay', method: 'POST', endpoint: collection, body: accept },
      { name: 'retry-replay', method: 'POST', endpoint: `${path}/retry`, body: retry },
      { name: 'frozen-revoke-replay', method: 'POST', endpoint: `${custody}/revoke-member`, body: completedRevoke },
    ]
    const failures: string[] = []
    const futureDeadline = async () => {
      const deadline = Date.now() + 600
      await stored.update({ completed_at_iso: new Date(deadline - 86400000).toISOString(), receipt_retain_until_iso: new Date(deadline).toISOString(), next_eligible_at_iso: new Date(deadline).toISOString() })
      return deadline
    }
    const observe = (name: string, status: number) => {
      console.log(`Receipt deadline crossing ${name} nativeRoutes=${nativeRoutes} status=${status}`)
      if (status !== 404) failures.push(`${name}:${status}`)
    }
    for (const crossing of crossings) {
      const deadline = await futureDeadline()
      lateReceipt = { deadline, responseStatus: null }
      try {
        const response = await send(crossing.method, crossing.endpoint, token, crossing.body, { 'x-fixture-receipt-delay': '1' })
        console.log(`Receipt before middleware ${crossing.name} nativeRoutes=${nativeRoutes} status=${lateReceipt.responseStatus}`)
        if (lateReceipt.responseStatus !== 200) failures.push(`not-current:${crossing.name}:${lateReceipt.responseStatus}`)
        observe(`middleware:${crossing.name}`, response.status)
      }
      finally { lateReceipt = undefined }
    }
    for (const crossing of crossings) {
      const deadline = await futureDeadline()
      let commits = 0
      database.db.primary.setTransactionDefaults({ afterCommit: async () => {
        commits++
        assert(Date.now() < deadline, 'Actual COMMIT must complete while the receipt is current')
        await Bun.sleep(Math.max(1, deadline - Date.now() + 10))
      } })
      try {
        const response = await send(crossing.method, crossing.endpoint, token, crossing.body)
        assert.equal(commits, 1, `Expected actual native post-COMMIT release for ${crossing.name}`)
        observe(`commit-release:${crossing.name}`, response.status)
      }
      finally { database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
    }
    const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
    for (const name of ['purge-events', 'accept-replay', 'frozen-revoke-replay']) {
      const crossing = crossings.find(value => value.name === name)!, deadline = await futureDeadline()
      let delayed = 0
      const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (delayed || !sql.startsWith('select') || !sql.includes('from public_safety_purge_events')) return
        delayed++
        assert(Date.now() < deadline, 'Actual event SELECT must observe a current receipt')
        // Native query hooks are synchronous. Blocking here delays the real awaited SELECT result.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, deadline - Date.now() + 10))
      } })
      try {
        const response = await send(crossing.method, crossing.endpoint, token, crossing.body)
        assert.equal(delayed, 1, `Expected actual event SELECT for ${name}`)
        observe(`awaited-select:${name}`, response.status)
      }
      finally { unhook() }
    }
    assert.deepEqual(failures, [], 'Completed receipts must remain private after every awaited release boundary')
    console.log(`PASS actual future receipt SQL COMMIT and middleware deadline crossings nativeRoutes=${nativeRoutes}`)
    const elapsedAt = new Date(Date.now() - 2 * 86400000).toISOString(), expiredAt = new Date(Date.parse(elapsedAt) + 86400000).toISOString()
    await stored.update({ completed_at_iso: elapsedAt, receipt_retain_until_iso: expiredAt, next_eligible_at_iso: expiredAt })
    process.env.PUBLIC_SAFETY_PURGE_ENABLED = 'false'
    for (const endpoint of [path, `${path}/events`, `${collection}/preview`, custody, `${custody}/preview`, `${custody}/events`]) assert.equal((await send('GET', endpoint, token)).status, 404)
    assert.equal((await send('POST', collection, token, accept)).status, 404)
    assert.equal((await send('POST', `${path}/retry`, token, retry)).status, 404)
    assert.equal((await send('POST', `${custody}/revoke-member`, token, { expectedRetentionVersion: currentRevoke.data.purge.retentionVersion, userId: custodian.id, requestId: randomUUID() })).status, 404)
    await assert.rejects(() => job.dispatchNow({ purgeKey: finished.purgeKey }))
    assert((await Purge.where('purge_key', finished.purgeKey).first()), 'Disabled cleanup must leave expired receipt metadata while reads refuse it')
    console.log(`PASS reconstructed persisted overdue receipt is private with executor disabled nativeRoutes=${nativeRoutes}`)
  }
  else {
    assert.equal(finished.state, 'blocked'); assert.equal(finished.outcomeCode, 'inspection-unavailable')
    assert.equal(finished.completed.namesUnlinked, 0); assert.equal((await readdir(join(root, 'managed'))).length, 1)
    assert.equal((await send('GET', custody, token)).status, 409)
    console.log(`PASS actual shared-host inspection refusal preserves HTTP namespace nativeRoutes=${nativeRoutes}; completion and TTL unavailable`)
  }
  console.log(`PASS native accepted purge HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
