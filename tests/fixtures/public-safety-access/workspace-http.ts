import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'

// The setup guard precedes every model, connection and authorization write.
const { root, database, User } = await setupIncidentDatabase()
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { Rbac } = await import('@stacksjs/auth/rbac')
const { Gate } = await import('@stacksjs/auth/gate')
const { createToken, revokeToken } = await import('@stacksjs/auth/tokens')
const { route, getCurrentRequest } = await import('@stacksjs/router')
const { emit } = await import('@stacksjs/realtime/emit')
const { workspaceRefreshChannel } = await import('../../../resources/functions/drone/public-safety/workspace/updates')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const observedBodies = new Map<string, boolean>()
const subscriberContext = new AsyncLocalStorage<string>()
route.use(async (request: Request, next: () => Promise<Response | null> | Response | null) => {
  try { return await subscriberContext.run(request.headers.get('x-fixture-subscriber') ?? 'publisher', next) }
  finally { const marker = request.headers.get('x-fixture-unread'); if (marker) observedBodies.set(marker, request.bodyUsed) }
})
Gate.after((user, ability) => {
  const label = getCurrentRequest()?.headers.get('x-fixture-subscriber')
  if (label && ability === 'public-safety:view') assert.equal(subscriberContext.getStore(), label, 'Fresh native authority retains every subscriber async store')
})
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents`
try {
  const coordinator = await User.create({ name: 'Workspace coordinator', email: 'workspace@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) {
    await Rbac.createPermission(permission, 'web')
    await Rbac.givePermission(coordinator.id, permission, 'web')
  }
  const credential = (await createToken(coordinator.id, 'workspace fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  const config = examplePublicSafetyConfig(); config.id = 'workspace-wire'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const send = async (method: string, path: string, body?: unknown, token: string | null = credential, extra: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')!.toLowerCase().split(',').map(value => value.trim())
    assert(vary.includes('authorization') && vary.includes('cookie'))
    if (response.status >= 400) {
      const data = await response.clone().json() as object
      assert.deepEqual(Object.keys(data), ['error'])
      for (const canary of [credential, root, 'SELECT', 'temporary-fixture-password']) assert(!JSON.stringify(data).includes(canary))
    }
    return response
  }
  assert.equal((await send('POST', '', { config })).status, 201)
  const response = await send('GET', '/workspace-wire/workspace')
  assert.equal(response.status, 200, 'Native authorized workspace route must exist')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const snapshot = await response.json() as { profile: string, viewer: { accountId: number }, selected: unknown }
  assert.equal(snapshot.profile, 'incident-workspace-v1')
  assert.equal(snapshot.viewer.accountId, coordinator.id)
  assert.equal(snapshot.selected, null)
  for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'sourcesAfterSequence=01', 'handoverAfterSequence=1%0A', 'membersAfterUserId=-1', 'sourceDigest=x', 'offerKey=x', 'contextCursor=x', 'token=x', 'channel=x', 'sourcesAfterSequence=2147483648']) assert.equal((await send('GET', `/workspace-wire/workspace?${query}`)).status, 422, query)
  for (const suffix of ['/workspace', '/workspace/events']) {
    assert.equal((await send('GET', `/workspace-wire${suffix}`, undefined, null)).status, 401)
    assert.equal((await send('GET', `/workspace-wire${suffix}?channel=private-user.1`)).status, 422)
    const head = await send('HEAD', `/workspace-wire${suffix}`)
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  }
  const reader = await User.create({ name: 'Workspace reader', email: 'workspace-reader@example.invalid', password: 'temporary-fixture-password' })
  const outsider = await User.create({ name: 'Workspace outsider', email: 'workspace-outsider@example.invalid', password: 'temporary-fixture-password' })
  for (const person of [reader, outsider]) await Rbac.givePermission(person.id, 'public-safety:access', 'web')
  const token = async (id: number, scopes: string[]) => (await createToken(id, 'workspace reader', scopes, { withRefreshToken: false })).plainTextToken
  const readCredential = await token(reader.id, ['public-safety:read'])
  const outsiderCredential = await token(outsider.id, ['public-safety:read'])
  const coordinateOnly = await token(coordinator.id, ['public-safety:coordinate'])
  for (const suffix of ['/workspace', '/workspace/events']) {
    assert.equal((await send('GET', `/workspace-wire${suffix}`, undefined, outsiderCredential)).status, 403)
    assert.equal((await send('GET', `/workspace-wire${suffix}`, undefined, coordinateOnly)).status, 403)
  }
  assert.equal((await send('PUT', '/workspace-wire/members', { expectedVersion: 1, userId: reader.id, role: 'observer' })).status, 200)
  const recording = simulatePublicSafety({ config, seconds: 10 })
  const admitted = await send('POST', '/workspace-wire/sources', { expectedVersion: 2, recording: JSON.parse(publicSafetyRecordingData(recording)) })
  assert.equal(admitted.status, 201)
  const admittedSource = await admitted.json() as { source: { digest: string } }
  const selected = await send('GET', `/workspace-wire/workspace?sourceDigest=${admittedSource.source.digest}&limit=1`, undefined, readCredential)
  assert.equal(selected.status, 200)
  const selectedData = await selected.json() as { recipients: unknown, selected: { source: { digest: string } } }
  assert.equal(selectedData.recipients, null)
  assert.equal(selectedData.selected.source.digest, admittedSource.source.digest)
  for (const field of ['canonical_json', 'canonicalJson', 'rgba', 'thermalCentiKelvin', 'support']) assert(!JSON.stringify(selectedData).includes(`"${field}"`))
  const open = async (currentCredential: string) => {
    const abort = new AbortController()
    const response = await fetch(`${base}/workspace-wire/workspace/events`, { headers: { authorization: `Bearer ${currentCredential}`, 'accept-encoding': 'gzip', 'x-fixture-subscriber': currentCredential === credential ? 'subscriber-b' : 'subscriber-a' }, signal: abort.signal })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(response.headers.get('content-encoding'), null, 'Native stream must not be compressed')
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    const stream = response.body!.getReader()
    assert(new TextDecoder().decode((await stream.read()).value).includes(': connected'))
    return { abort, stream }
  }
  const first = await open(readCredential), second = await open(credential)
  try {
    // Revoked A must not borrow B's native Auth or the writer's after-COMMIT ORM scope.
    await revokeToken(readCredential)
    const incident = await database.db.primary.selectFrom('public_safety_incidents').select('id').where('incident_key', '=', config.id).executeTakeFirst()
    assert(incident)
    let committed = 0
    database.db.primary.setTransactionDefaults({ afterCommit: async () => {
      if (committed || !getCurrentRequest()?.headers.has('x-fixture-commit-scope')) return
      committed++
      // The native writer committed; publication deliberately has no SQL.
      emit(workspaceRefreshChannel(Number(incident.id)), 'refresh', { refresh: true })
      await Bun.sleep(20)
      assert(getCurrentRequest()?.headers.has('x-fixture-commit-scope'), 'Publisher context is restored')
    } })
    try {
      const changed = await send('PUT', '/workspace-wire/members', { expectedVersion: 3, userId: outsider.id, role: 'observer' }, credential, { 'x-fixture-commit-scope': '1' })
      assert.equal(changed.status, 200)
      assert.equal(committed, 1)
    }
    finally { database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
    assert.equal((await first.stream.read()).done, true, 'Committed writer must not authorize a revoked reader')
    const hint = new TextDecoder().decode((await second.stream.read()).value)
    assert(hint.includes('"event":"refresh"') && hint.includes('"data":{"refresh":true}'), 'Authorized subscriber must receive actual COMMIT hint without a stale transaction hang')
    for (const canary of [credential, admittedSource.source.digest, config.id, 'actorId', 'note', 'details']) assert(!hint.includes(canary))
    const current = await send('GET', '/workspace-wire/workspace')
    const currentData = await current.json() as { throughSequence: number }
    assert.equal(currentData.throughSequence, 4)
  }
  finally { first.abort.abort(); second.abort.abort(); await Promise.all([first.stream.cancel().catch(() => {}), second.stream.cancel().catch(() => {})]) }
  console.log(`PASS native workspace HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
