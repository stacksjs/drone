import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import { createHash, randomUUID } from 'node:crypto'

// A fixture-only model generates the native session table; no application session API is installed.
const { root, database, User } = await setupIncidentDatabase({
  prepare: async root => {
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
let delayedBinary = 0
let moveAfterResponse: { from: string, to: string } | undefined
route.use(async (request: Request, next: () => Response | null | Promise<Response | null>) => {
  try {
    const result = await next()
    if (result?.status === 200 && request.headers.has('x-fixture-managed-move') && moveAfterResponse) await rename(moveAfterResponse.from, moveAfterResponse.to)
    const delay = Number(request.headers.get('x-fixture-managed-delay'))
    if (result?.status === 200 && delay > 0) { delayedBinary++; await Bun.sleep(delay) }
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
  for (const name of ['coordinator', 'custodian', 'pilot', 'observer', 'reviewer', 'outsider']) {
    const user = await User.create({ name, email: `${name}@example.invalid`, password: 'temporary-fixture-password' })
    people.set(name, { id: user.id, token: (await createToken(user.id, 'managed wire fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken })
  }
  const coordinator = people.get('coordinator')!, custodian = people.get('custodian')!, pilot = people.get('pilot')!, observer = people.get('observer')!, reviewer = people.get('reviewer')!, outsider = people.get('outsider')!
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const user of people.values()) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const privateResponse = (response: Response) => {
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim())
    assert(vary?.includes('authorization') && vary.includes('cookie'))
    for (const header of response.headers.keys()) assert(!header.includes('retain-until'))
  }
  const raw = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const check = async (response: Response) => {
    privateResponse(response)
    const data = await response.json() as any
    if (response.status >= 400) { assert.deepEqual(Object.keys(data), ['error']); assert(!JSON.stringify(data).includes('SELECT')); assert(!JSON.stringify(data).includes(root)); assert(!JSON.stringify(data).includes('temporary-fixture-password')) }
    return { status: response.status, data }
  }
  const send = (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => raw(method, path, token, body, headers).then(check)
  const token = coordinator.token
  const deadlineScenario = process.env.INCIDENT_MANAGED_DEADLINE_ONLY === 'true'
  if (deadlineScenario) {
    // A separate genuinely short-lived source leaves all immutable config/plan bindings intact.
    const short = examplePublicSafetyConfig(); short.id = 'managed-release-deadline'; short.retention.expiresAt = new Date(Date.now() + 20000).toISOString()
    const shortKey = `/${short.id}`, shortCollection = `${shortKey}/managed-artifacts`
    assert.equal((await send('POST', '', token, { config: short })).status, 201)
    const shortSource = await send('POST', `${shortKey}/sources`, token, { expectedVersion: 1, recording: JSON.parse(publicSafetyRecordingData(simulatePublicSafety({ config: short, seconds: 16 }))) })
    assert.equal(shortSource.status, 201)
    const shortPreview = (await send('GET', `${shortKey}/retention/preview`, token)).data
    assert.equal((await send('POST', `${shortKey}/retention/enrollment`, token, { expectedVersion: shortPreview.incidentVersion, inventoryDigest: shortPreview.inventoryDigest, policyVersion: 'local-managed-v1', requestId: randomUUID() })).status, 200)
    const shortCreated = await send('POST', shortCollection, token, { expectedVersion: (await send('GET', shortKey, token)).data.version, expectedRetentionVersion: 1, sourceDigest: shortSource.data.source.digest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() })
    assert.equal(shortCreated.status, 201)
    const shortPath = `${shortCollection}/${shortCreated.data.artifact.key}`
    const shortFiles = (await send('GET', shortPath, token)).data.files
    const delay = Math.max(1, Date.parse(short.retention.expiresAt) - Date.now() + 25)
    const delayed = await send('GET', `${shortPath}/files/${shortFiles[0].id}`, token, undefined, { 'x-fixture-managed-delay': String(delay) })
    assert.equal(delayed.status, 404); assert.equal(delayedBinary, 1)
    assert.deepEqual(Object.keys(delayed.data), ['error'])
    assert.equal((await raw('HEAD', `${shortPath}/files/${shortFiles[0].id}`, token)).status, 404)
    assert.equal((await readdir(join(root, 'managed'))).length, 1)
  }
  else {
    const config = examplePublicSafetyConfig()
    config.id = 'managed-wire'
    config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
    config.retention.hold = 'declared-review-required'
    const key = `/${config.id}`, collection = `${key}/managed-artifacts`
    assert.equal((await send('POST', '', token, { config })).status, 201)
    for (const [user, role] of [[custodian, 'evidence-custodian'], [pilot, 'pilot'], [observer, 'observer'], [reviewer, 'reviewer']] as const) {
      const version = (await send('GET', key, token)).data.version
      assert.equal((await send('PUT', `${key}/members`, token, { expectedVersion: version, userId: user.id, role })).status, 200)
    }
    const run = simulatePublicSafety({ config, seconds: 16 })
    const recording = JSON.parse(publicSafetyRecordingData(run))
    const admitted = await send('POST', `${key}/sources`, pilot.token, { expectedVersion: (await send('GET', key, token)).data.version, recording })
    assert.equal(admitted.status, 201)
    const sourceDigest = admitted.data.source.digest
    const command = async () => ({ expectedVersion: (await send('GET', key, token)).data.version, expectedRetentionVersion: 1, sourceDigest, datasetProfile: 'owned-public-safety-dataset-v1', requestId: randomUUID() })
    assert.equal((await send('POST', collection, token, await command())).status, 409)
    const preview = (await send('GET', `${key}/retention/preview`, token)).data
    assert.equal((await send('POST', `${key}/retention/enrollment`, token, { expectedVersion: preview.incidentVersion, inventoryDigest: preview.inventoryDigest, policyVersion: 'local-managed-v1', requestId: randomUUID() })).status, 200)
    const readOnly = (await createToken(coordinator.id, 'managed read only', ['public-safety:read'], { withRefreshToken: false })).plainTextToken
    const coordinateOnly = (await createToken(custodian.id, 'managed coordinate only', ['public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
    for (const [credential, status, marker] of [[null, 401, 'anonymous'], [outsider.token, 403, 'outsider'], [pilot.token, 403, 'pilot'], [observer.token, 403, 'observer'], [reviewer.token, 403, 'reviewer'], [readOnly, 403, 'read-only']] as const) {
      assert.equal((await send('POST', collection, credential, '{'.padEnd(8193, ' '), { 'x-fixture-unread': marker })).status, status)
      assert.equal(observedBodies.get(marker), false)
    }
    const csrf = 'a'.repeat(64), cookie = `${authCookieName()}=${custodian.token}; X-CSRF-Token=${csrf}`
    assert.equal((await send('POST', collection, null, '{', { cookie: `${authCookieName()}=${custodian.token}`, 'x-fixture-unread': 'csrf' })).status, 403)
    assert.equal(observedBodies.get('csrf'), false)
    const session = await sessionLogin('coordinator@example.invalid', 'temporary-fixture-password')
    assert.equal(await sessionCheck(session.sessionId), true)
    assert.equal((await send('GET', collection, null, undefined, { cookie: `session_id=${session.sessionId}` })).status, 401)
    assert.equal((await send('POST', collection, token, '{}'.padEnd(8193, ' '))).status, 413)
    assert.equal((await send('POST', collection, token, '{}', { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await send('POST', collection, token, '{')).status, 400)
    assert.equal((await send('POST', `${collection}?actor=1`, token, '{', { 'x-fixture-unread': 'query' })).status, 422)
    assert.equal(observedBodies.get('query'), false)
    const create = await command()
    for (const changed of [{ actorUserId: coordinator.id }, { root }, { filename: 'arbitrary' }, { expectedVersion: String(create.expectedVersion) }, { expectedRetentionVersion: '1' }, { datasetProfile: 'other' }, { sourceDigest: 'A'.repeat(64) }, { requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }]) assert.equal((await send('POST', collection, token, { ...create, ...changed })).status, 422)
    const json = JSON.stringify(create), exact = json.padEnd(8192, ' ')
    assert.equal((await send('POST', collection, token, exact + ' ')).status, 413)
    const created = await send('POST', collection, token, exact)
    assert.equal(created.status, 201)
    assert.equal(created.data.replayed, false)
    const artifact = created.data.artifact.key, path = `${collection}/${artifact}`
    assert.equal(created.data.artifact.state, 'complete')
    assert.equal(created.data.artifact.version, 3)
    assert.equal(created.data.artifact.incidentVersion, create.expectedVersion + 3)
    const safe = (input: unknown) => {
      const text = JSON.stringify(input)
      for (const forbidden of ['target_path', 'receipt_json', 'identity_json', 'planned_root_json', 'operation_nonce', 'request_digest', 'canonical_json', 'config_json', root, 'preparationCtimeNs', 'birthtimeNs']) assert(!text.includes(forbidden))
    }
    safe(created.data)
    for (const flag of ['sourceIdentityAuthenticated', 'physicalFlightEnabled', 'physicalThermalVerified', 'purgeImplemented', 'contentDeletionPerformed']) assert.equal(created.data.artifact[flag], false)
    const repeated = await send('POST', collection, token, create)
    assert.equal(repeated.status, 200); assert.equal(repeated.data.replayed, true)
    assert.equal(repeated.data.artifact.key, artifact)
    assert.equal(repeated.data.artifact.version, 3)
    assert.equal(repeated.data.event.action, 'intent-recorded')
    assert.equal((await send('POST', collection, custodian.token, create)).status, 409)
    assert.equal((await send('POST', collection, token, { ...create, expectedVersion: create.expectedVersion + 1 })).status, 409)
    const lookup = await send('GET', `${collection}?requestId=${create.requestId}`, observer.token)
    assert.deepEqual(lookup.data.entries.map((row: any) => row.key), [artifact])
    const catalog = await send('GET', path, observer.token)
    assert.equal(catalog.status, 200); safe(catalog.data)
    const files = catalog.data.files as { id: number, role: string, captureId: string | null, filename: string, mimeType: string, bytes: number, sha256: string }[]
    assert.equal(files.length, created.data.artifact.fileCount)
    const firstFile = files.find(file => file.role === 'recording')!, filePath = `${path}/files/${firstFile.id}`
    for (const user of [coordinator, custodian, pilot, observer, reviewer]) {
      assert.equal((await send('GET', collection, user.token)).status, 200)
      assert.equal((await send('GET', path, user.token)).status, 200)
      assert.equal((await send('GET', `${path}/events`, user.token)).status, user === coordinator || user === custodian ? 200 : 403)
    }
    assert.equal((await send('GET', collection, coordinateOnly)).status, 403)
    for (const endpoint of [collection, path, `${path}/events`, filePath]) assert.equal((await send('GET', endpoint, outsider.token)).status, 403)
    const { decode } = await import('ts-images')
    for (const file of files) {
      const response = await raw('GET', `${path}/files/${file.id}`, observer.token, undefined, { 'accept-encoding': 'identity' })
      privateResponse(response); assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), file.mimeType)
      assert.equal(response.headers.get('content-encoding'), null)
      assert.equal(response.headers.get('content-length'), String(file.bytes))
      assert.equal(response.headers.get('content-disposition'), `attachment; filename="${file.filename}"`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      assert.equal(bytes.length, file.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
      if (file.role === 'recording') assert.equal(new TextDecoder().decode(bytes), `${publicSafetyRecordingData(run)}\n`)
      if (file.role === 'visible') { const image = await decode(bytes), visible = run.survey.captures.find(capture => capture.id === file.captureId)!; assert.equal(image.width, visible.width); assert.equal(image.height, visible.height); assert.deepEqual([...image.data], [...visible.rgba]) }
      if (file.role === 'support') assert.deepEqual([...bytes], [...run.captures[run.survey.captures.findIndex(capture => capture.id === file.captureId)]!.support])
      if (file.role === 'thermal') { const capture = run.captures[run.survey.captures.findIndex(capture => capture.id === file.captureId)]!, view = new DataView(bytes.buffer); assert.equal(bytes.length, capture.thermalCentiKelvin.length * 2); for (let i = 0; i < capture.thermalCentiKelvin.length; i++) assert.equal(view.getUint16(i * 2, true), capture.thermalCentiKelvin[i]) }
      if (file.role === 'manifest') { const manifest = JSON.parse(new TextDecoder().decode(bytes)); assert.equal(manifest.identityAuthenticated, false); assert.equal(manifest.retentionDeletionEnforced, false); assert.equal(manifest.physicalThermalVerified, false) }
    }
    const conditionalHeaders: Record<string, string>[] = [{ range: 'bytes=0-1' }, { 'if-none-match': '*' }, { 'if-modified-since': new Date().toUTCString() }]
    for (const headers of conditionalHeaders) {
      const response = await raw('GET', filePath, observer.token, undefined, { ...headers, 'accept-encoding': 'identity' })
      privateResponse(response); assert.equal(response.status, 200); assert.equal(response.headers.get('content-range'), null)
      assert.equal((await response.arrayBuffer()).byteLength, firstFile.bytes)
    }
    const encodedHeaders: Record<string, string>[] = [{}, { 'accept-encoding': 'gzip' }, { 'accept-encoding': 'deflate' }]
    for (const headers of encodedHeaders) {
      const response = await raw('GET', filePath, observer.token, undefined, headers)
      privateResponse(response); assert.equal(response.status, 200)
      assert(['gzip', 'deflate'].includes(response.headers.get('content-encoding')!))
      assert.equal(response.headers.get('content-length'), null)
      assert(response.headers.get('vary')?.toLowerCase().includes('accept-encoding'))
      const bytes = new Uint8Array(await response.arrayBuffer())
      assert.equal(bytes.length, firstFile.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), firstFile.sha256)
    }
    const unacceptable = await raw('GET', filePath, token, undefined, { 'accept-encoding': 'br, identity;q=0, gzip;q=0, deflate;q=0' })
    assert.equal(unacceptable.status, 406)
    assert.equal(unacceptable.headers.get('cache-control'), 'no-store')
    assert.equal(unacceptable.headers.get('x-content-type-options'), 'nosniff')
    for (const header of ['content-disposition', 'content-type', 'content-encoding', 'content-range']) assert.equal(unacceptable.headers.get(header), null)
    assert([null, '0'].includes(unacceptable.headers.get('content-length')))
    for (const name of ['authorization', 'cookie', 'accept-encoding']) assert(unacceptable.headers.get('vary')?.toLowerCase().split(',').map(value => value.trim()).includes(name))
    assert.equal((await unacceptable.arrayBuffer()).byteLength, 0)
    for (const [credential, expected] of [[observer.token, 200], [outsider.token, 403], [null, 401]] as const) {
      const response = await raw('HEAD', filePath, credential)
      privateResponse(response); assert.equal(response.status, expected); assert.equal((await response.arrayBuffer()).byteLength, 0)
    }
    for (const [credential, expected] of [[outsider.token, 403], [null, 401]] as const) assert.equal((await send('GET', filePath, credential, undefined, { range: 'bytes=0-1', 'if-none-match': '*' })).status, expected)
    const eventPage = await send('GET', `${path}/events?limit=1`, custodian.token)
    assert.deepEqual(eventPage.data.entries.map((event: any) => event.action), ['intent-recorded']); assert.equal(eventPage.data.hasMore, true)
    const tail = await send('GET', `${path}/events?after=${eventPage.data.cursor}&limit=2`, token)
    assert.deepEqual(tail.data.entries.map((event: any) => event.action), ['ownership-recorded', 'published']); assert.equal(tail.data.hasMore, false)
    for (const query of ['after=0', 'afterId=01', 'afterId=1%0A', 'limit=101', 'limit=0', 'limit=1&limit=2', 'requestId=x', `requestId=${create.requestId}&limit=1`, `requestId=${create.requestId}&afterId=0`, `requestId=${create.requestId}&requestId=${create.requestId}`, 'sourceDigest=x']) assert.equal((await send('GET', `${collection}?${query}`, token)).status, 422)
    for (const query of ['afterSequence=1', 'after=-1', 'after=01', 'after=1%0A', 'limit=101', 'after=0&after=1']) assert.equal((await send('GET', `${path}/events?${query}`, token)).status, 422)
    for (const endpoint of [path, filePath]) assert.equal((await send('GET', `${endpoint}?path=secret`, token)).status, 422)
    for (const id of ['0', '01', '-1', '1%0A', '2147483648']) assert.equal((await send('GET', `${path}/files/${id}`, token)).status, 422)
    const reconcile = { expectedVersion: (await send('GET', key, token)).data.version, expectedArtifactVersion: 3, requestId: randomUUID() }
    const reconcileJson = JSON.stringify(reconcile).padEnd(8192, ' ')
    assert.equal((await send('POST', `${path}/reconcile`, token, reconcileJson + ' ')).status, 413)
    for (const credential of [pilot.token, observer.token, reviewer.token, readOnly]) {
      const marker = `reconcile-${credential.slice(-8)}`
      assert.equal((await send('POST', `${path}/reconcile`, credential, '{', { 'x-fixture-unread': marker })).status, 403)
      assert.equal(observedBodies.get(marker), false)
    }
    assert.equal((await send('POST', `${path}/reconcile`, null, '{', { cookie: `${authCookieName()}=${custodian.token}`, 'x-fixture-unread': 'reconcile-csrf' })).status, 403)
    assert.equal(observedBodies.get('reconcile-csrf'), false)
    const reconciled = await send('POST', `${path}/reconcile`, null, reconcileJson, { cookie, 'x-csrf-token': csrf })
    assert.equal(reconciled.status, 200); assert.equal(reconciled.data.artifact.state, 'complete'); assert.equal(reconciled.data.artifact.version, 5)
    assert.equal((await send('POST', `${path}/reconcile`, custodian.token, reconcile)).data.replayed, true)
    assert.equal((await send('POST', `${path}/reconcile`, custodian.token, { ...reconcile, expectedArtifactVersion: 4 })).status, 409)
    assert.equal((await send('GET', `${key}/retention`, token)).data.version, 1)
    for (const state of ['token', 'permission', 'membership'] as const) {
      const fresh = await createToken(custodian.id, 'managed late revocation', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
      let armed = true, passed = 0
      Gate.after(async (user, ability, allowed, args) => {
        if (!armed || ability !== 'public-safety:managed-create' || args[0] !== config.id || user?.id !== custodian.id) return
        assert.equal(allowed, true); armed = false; passed++
        if (state === 'token') await revokeToken(fresh.plainTextToken)
        if (state === 'permission') await Rbac.revokePermission(custodian.id, 'public-safety:access', 'web')
        if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: false }).where('user_id', '=', custodian.id).execute()
      })
      try { assert.equal((await send('POST', collection, fresh.plainTextToken, await command())).status, state === 'token' ? 401 : 403); assert.equal(passed, 1) }
      finally { armed = false; if (state === 'permission') await Rbac.givePermission(custodian.id, 'public-safety:access', 'web'); if (state === 'membership') await database.db.primary.updateTable('public_safety_incident_members').set({ active: true }).where('user_id', '=', custodian.id).execute() }
    }
    const secondCommand = await command(), second = await send('POST', collection, null, secondCommand, { cookie, 'x-csrf-token': csrf })
    assert.equal(second.status, 201); assert.equal(second.data.artifact.requesterUserId, custodian.id)
    const firstPage = await send('GET', `${collection}?limit=1`, token), lastPage = await send('GET', `${collection}?afterId=${firstPage.data.cursor}&limit=1`, token)
    assert.equal(firstPage.data.hasMore, true); assert.equal(lastPage.data.hasMore, false)
    assert.deepEqual([firstPage.data.entries[0].key, lastPage.data.entries[0].key], [artifact, second.data.artifact.key])
    const foreign = structuredClone(config); foreign.id = 'managed-foreign'
    assert.equal((await send('POST', '', token, { config: foreign })).status, 201)
    const foreignCollection = `/${foreign.id}/managed-artifacts`
    for (const suffix of [`/${artifact}`, `/${artifact}/files/${firstFile.id}`, `/${artifact}/events`]) assert.equal((await send('GET', foreignCollection + suffix, token)).status, 404)
    assert.deepEqual((await send('GET', `${foreignCollection}?requestId=${create.requestId}`, token)).data.entries, [])
    assert.equal((await send('POST', `${foreignCollection}/${artifact}/reconcile`, token, { ...reconcile, expectedVersion: 1 })).status, 404)
    for (const slug of ['public-safety-managed-artifact', 'public-safety-managed-artifact-file', 'public-safety-managed-artifact-event']) for (const [method, suffix] of [['GET', ''], ['POST', ''], ['PATCH', '/1'], ['DELETE', '/1']] as const) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/dashboard/models/${slug}${suffix}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'POST' || method === 'PATCH' ? { body: '{"fields":{"state":"complete"}}' } : {}) })
      assert.equal((await check(response)).status, 404)
    }
    // A real corrupt registered file is refused rather than replaced or rerendered.
    const Artifact = (await import(join(root, 'app/Models/PublicSafetyManagedArtifact.ts'))).default
    const stored = await Artifact.where('artifact_key', artifact).first()
    const owned = JSON.parse(stored.receipt_json)
    moveAfterResponse = { from: owned.directory, to: join(root, 'moved-after-read') }
    try {
      const buffered = await raw('GET', filePath, token, undefined, { 'x-fixture-managed-move': '1', 'accept-encoding': 'gzip' })
      privateResponse(buffered); assert.equal(buffered.status, 200)
      assert.equal(buffered.headers.get('content-encoding'), 'gzip')
      const releasedBytes = new Uint8Array(await buffered.arrayBuffer())
      assert.equal(createHash('sha256').update(releasedBytes).digest('hex'), firstFile.sha256)
      assert.equal((await readdir(join(root, 'managed'))).includes(artifact), false)
    }
    finally { await rename(moveAfterResponse.to, moveAfterResponse.from); moveAfterResponse = undefined }
    const recordingPath = join(owned.directory, 'recording.json'), original = await readFile(recordingPath)
    const corrupted = Buffer.from(original); corrupted[0] = corrupted[0]! ^ 1
    await writeFile(recordingPath, corrupted)
    assert.equal((await send('GET', filePath, token)).status, 409)
    assert.deepEqual(await readFile(recordingPath), corrupted)
    await writeFile(recordingPath, original)
    assert.equal((await raw('GET', filePath, token)).status, 200)
    assert.equal((await send('POST', `${key}/close`, token, { expectedVersion: (await send('GET', key, token)).data.version })).status, 200)
    for (const endpoint of [collection, path, `${path}/events`]) assert.equal((await send('GET', endpoint, token)).status, 200)
    assert.equal((await raw('GET', filePath, token)).status, 200)
    assert.equal((await send('POST', collection, token, '{', { 'x-fixture-unread': 'closed-create' })).status, 409)
    assert.equal(observedBodies.get('closed-create'), false)
    assert.equal((await send('POST', `${path}/reconcile`, token, '{', { 'x-fixture-unread': 'closed-reconcile' })).status, 409)
    assert.equal(observedBodies.get('closed-reconcile'), false)
    // Persisted past-due data remains private during a hold, including artifact catalogs and event IDs.
    const Incident = (await import(join(root, 'app/Models/PublicSafetyIncident.ts'))).default
    const incident = await Incident.where('incident_key', config.id).first(), expired = structuredClone(config)
    expired.retention.expiresAt = new Date(Date.now() - 86400000).toISOString()
    await incident.update({ config_json: publicSafetyRecordingData(expired), retain_until: expired.retention.expiresAt })
    for (const endpoint of [collection, path, `${path}/events`, filePath]) assert.equal((await send('GET', endpoint, token)).status, 404)
    for (const endpoint of [collection, `${path}/reconcile`]) assert.equal((await send('POST', endpoint, token, '{', { 'x-fixture-unread': 'expired' })).status, 404)
    assert.equal(observedBodies.get('expired'), false)
    const expiredPreview = await send('GET', `${key}/retention/preview`, token)
    assert.equal(expiredPreview.status, 200); assert.equal(expiredPreview.data.managedArtifactCount, 2)
    safe(expiredPreview.data)
    assert(!JSON.stringify(expiredPreview.data).includes(artifact)); assert(!JSON.stringify(expiredPreview.data).includes(sourceDigest))
    assert.equal((await readdir(join(root, 'managed'))).length, 2)
  }
  console.log(`PASS native managed dataset HTTP nativeRoutes=${nativeRoutes} scenario=${deadlineScenario ? 'deadline' : 'lifecycle'}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
