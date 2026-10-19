import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import type { HandoverOfferInput, HandoverReceipt } from '../../../resources/functions/drone/public-safety/access/handover-types'

// One real expiry crossing per isolated database avoids serializing another case
// behind an awaited native COMMIT callback. The wall clock is never substituted.
const { root, database, User } = await setupIncidentDatabase()
const crossing = process.env.HANDOVER_DEADLINE_CASE ?? ''
assert(['offer-commit', 'decision-commit', 'offer-middleware', 'decision-middleware', 'pending-middleware'].includes(crossing))
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { getCurrentRequest, route } = await import('@stacksjs/router')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
let crossed = false
route.use(async (request: Request, next: () => Response | null | Promise<Response | null>) => {
  const result = await next()
  if (request.headers.has('x-fixture-handover-delay')) {
    assert(result)
    assert.equal(result.status, crossing === 'offer-middleware' ? 201 : 200)
    const data = await result.clone().json() as { offer: { expiresAt: string } }
    const deadline = Date.parse(data.offer.expiresAt)
    assert(Number.isFinite(deadline) && Date.now() < deadline, 'Middleware must observe a genuinely current handover response')
    crossed = true
    await Bun.sleep(Math.max(1, deadline - Date.now() + 20))
    assert(Date.now() >= deadline)
  }
  return result
})
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents`
try {
  const coordinator = await User.create({ name: 'Deadline outgoing', email: 'deadline-outgoing@example.invalid', password: 'temporary-fixture-password' })
  const recipient = await User.create({ name: 'Deadline incoming', email: 'deadline-incoming@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const user of [coordinator, recipient]) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  await Rbac.givePermission(coordinator.id, 'public-safety:create', 'web')
  const outgoing = (await createToken(coordinator.id, 'deadline outgoing', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  const incoming = (await createToken(recipient.id, 'deadline incoming', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  const send = async (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')!.toLowerCase().split(',').map(value => value.trim())
    assert(vary.includes('authorization') && vary.includes('cookie'))
    const data = await response.json() as any
    if (response.status >= 400) assert.deepEqual(Object.keys(data), ['error'])
    return { status: response.status, data }
  }
  const config = examplePublicSafetyConfig(); config.id = `wire-${crossing}`; config.retention.expiresAt = new Date(Date.now() + 180000).toISOString()
  const key = `/${config.id}`
  assert.equal((await send('POST', '', outgoing, { config })).status, 201)
  assert.equal((await send('PUT', `${key}/members`, outgoing, { expectedVersion: 1, userId: recipient.id, role: 'observer' })).status, 200)
  const admitted = await send('POST', `${key}/sources`, outgoing, { expectedVersion: 2, recording: JSON.parse(publicSafetyRecordingData(simulatePublicSafety({ config, seconds: 10 }))) })
  assert.equal(admitted.status, 201)
  const offerInput: HandoverOfferInput = { requestId: randomUUID(), assignment: { kind: 'incident-coordination', coordinatorId: coordinator.id, coordinatorMembershipVersion: 1 }, recipientUserId: recipient.id, recipientMembershipVersion: 1, sourceDigest: admitted.data.source.digest, outgoingRole: 'observer', expiresInSeconds: 30 }
  const offering = crossing.startsWith('offer-'), deciding = crossing.startsWith('decision-')
  let offered: HandoverReceipt | undefined
  if (!offering) {
    const response = await send('POST', `${key}/handover/offer`, outgoing, offerInput)
    assert.equal(response.status, 201)
    offered = response.data
  }
  const accept = offered ? { requestId: randomUUID(), offerKey: offered.offer.key, decision: 'accept', acknowledgement: { offerDigest: offered.offer.digest, assignment: 'incident-coordination', sourceDigest: offered.offer.source.digest, contextThroughSequence: offered.offer.contextThroughSequence, uncertaintyAcknowledged: true } } : undefined
  let commits = 0
  const started = Date.now()
  if (crossing.endsWith('-commit')) database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    if (!getCurrentRequest()?.headers.has('x-fixture-handover-commit')) return
    commits++
    assert.equal(commits, 1)
    // This native callback follows actual COMMIT. Querying a transaction-bound
    // handle here would not be a valid proof of release after transaction exit.
    assert(Date.now() - started < 25000, 'The command must commit inside its genuine 30-second offer window')
    const deadline = offering ? Date.now() + 31000 : Date.parse(offered!.offer.expiresAt)
    assert(Number.isFinite(deadline) && Date.now() < deadline)
    crossed = true
    await Bun.sleep(Math.max(1, deadline - Date.now() + 20))
    assert(Date.now() >= deadline)
  } })
  const headers = { [crossing.endsWith('-commit') ? 'x-fixture-handover-commit' : 'x-fixture-handover-delay']: '1' }
  const response = offering ? await send('POST', `${key}/handover/offer`, outgoing, offerInput, headers)
    : deciding ? await send('POST', `${key}/handover/decision`, incoming, accept, headers)
      : await send('GET', `${key}/handover?offer=${offered!.offer.key}`, incoming, undefined, headers)
  database.db.primary.setTransactionDefaults({ afterCommit: undefined })
  assert.equal(crossed, true, 'The actual COMMIT or awaited middleware must have crossed the wall deadline')
  assert.equal(response.status, 404, 'New command or actionable briefing must be withheld after real offer expiry')
  if (crossing.endsWith('-commit')) assert.equal(commits, 1)
  assert(Date.now() < Date.parse(config.retention.expiresAt), 'Historical content must still be inside incident retention')
  if (deciding) {
    const current = await send('GET', key, incoming)
    assert.equal(current.status, 200)
    assert.equal(current.data.coordinatorId, recipient.id, 'Withheld response must not roll back a committed handover')
    const historical = await send('GET', `${key}/handover?offer=${offered!.offer.key}`, incoming)
    assert.equal(historical.status, 200)
    assert.equal(historical.data.offer.state, 'accepted')
    assert.equal(historical.data.briefing, null)
    assert.equal(historical.data.actionability.canAccept, false)
    const replay = await send('POST', `${key}/handover/decision`, incoming, accept)
    assert.equal(replay.status, 200)
    assert.equal(replay.data.replayed, true)
    assert.equal(replay.data.offer.state, 'accepted')
    const offerReplay = await send('POST', `${key}/handover/offer`, outgoing, offerInput)
    assert.equal(offerReplay.status, 200)
    assert.equal(offerReplay.data.replayed, true)
    assert.equal(offerReplay.data.offer.state, 'accepted')
    const audit = await send('GET', `${key}/audit`, incoming)
    assert.equal(audit.data.entries.filter((entry: { action: string }) => entry.action === 'handover-accepted').length, 1)
  }
  else {
    const expired = await send('GET', `${key}/handover`, outgoing)
    assert.equal(expired.status, 200)
    assert.equal(expired.data.offer, null)
    assert.equal(expired.data.briefing, null)
    assert.equal(expired.data.actionability.canAccept, false)
    assert.equal(expired.data.actionability.canCancel, false)
    const audit = await send('GET', `${key}/audit`, outgoing)
    const offers = audit.data.entries.filter((entry: { action: string }) => entry.action === 'handover-offered')
    assert.equal(offers.length, 1, 'Public audit must prove the withheld offer command actually committed')
    const offerKey = offered?.offer.key ?? offers[0].details.key
    assert.equal(typeof offerKey, 'string')
    assert.equal((await send('GET', `${key}/handover?offer=${offerKey}`, outgoing)).status, 404)
    assert.equal((await send('POST', `${key}/handover/decision`, incoming, { requestId: randomUUID(), offerKey, decision: 'decline' })).status, 409)
  }
  console.log(`PASS actual handover ${crossing} offer expiry nativeRoutes=${nativeRoutes}`)
}
finally { database.db.primary.setTransactionDefaults({ afterCommit: undefined }); await server.stop(true); await database.closeDatabaseConnection() }
