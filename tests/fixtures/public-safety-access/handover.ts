import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
const { database, User } = await setupIncidentDatabase()
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const records = await import('../../../resources/functions/drone/public-safety/access/records')
const handover = await import('../../../resources/functions/drone/public-safety/access/handover')
const { publicSafetyHandoverGate } = await import('../../../resources/functions/drone/public-safety/access/handover-policy')
const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
for (const ability of ['read', 'write'] as const) Gate.define(`public-safety:handover-${ability}`, (user, key) => publicSafetyHandoverGate(user, key, ability))
const as = <T>(token: string, action: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), action)
try {
  const sender = await User.create({ name: 'Outgoing Coordinator', email: 'handover-sender@example.invalid', password: 'temporary-fixture-password' })
  const recipient = await User.create({ name: 'Incoming Coordinator', email: 'handover-recipient@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  await Rbac.givePermission(sender.id, 'public-safety:create', 'web')
  for (const user of [sender, recipient]) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  const token = await createToken(sender.id, 'handover sender', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  const incomingToken = await createToken(recipient.id, 'handover recipient', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  const config = examplePublicSafetyConfig()
  config.id = 'handover-native'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const offered = await as(token.plainTextToken, async () => {
    await access.createPublicSafetyIncident({ config })
    await access.changePublicSafetyMembership(config.id, { expectedVersion: 1, userId: recipient.id, role: 'reviewer' })
    const run = simulatePublicSafety({ config, seconds: 16 })
    const source = await records.registerPublicSafetySource(config.id, { expectedVersion: 2, recording: run })
    const observationInput = { sourceDigest: source.source.digest, captureId: run.survey.captures[0]!.id, modality: 'visible', pixel: { x: 0, y: run.survey.captures[0]!.height - 1 }, note: 'Selected source declaration', uncertaintyNote: 'Original uncertainty survives review pagination' }
    for (const expectedVersion of [3, 5]) {
      const point = await records.appendPublicSafetyObservation(config.id, { ...observationInput, expectedVersion })
      await records.appendPublicSafetyReview(config.id, point.observation.id, { expectedVersion: expectedVersion + 1, sourceDigest: source.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Original observation is outside the next review page' })
    }
    const otherSource = await records.registerPublicSafetySource(config.id, { expectedVersion: 7, recording: simulatePublicSafety({ config, seconds: 17 }) })
    const otherPoint = await records.appendPublicSafetyObservation(config.id, { ...observationInput, sourceDigest: otherSource.source.digest, expectedVersion: 8, note: 'Other source must not enter selected briefing' })
    await records.appendPublicSafetyReview(config.id, otherPoint.observation.id, { expectedVersion: 9, sourceDigest: otherSource.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Other source review is excluded' })
    return handover.offerIncidentCoordination(config.id, { requestId: randomUUID(), assignment: { kind: 'incident-coordination', coordinatorId: sender.id, coordinatorMembershipVersion: 1 }, recipientUserId: recipient.id, recipientMembershipVersion: 1, sourceDigest: source.source.digest, outgoingRole: 'observer', expiresInSeconds: 300 })
  })
  assert.equal(offered.incident.coordinatorId, sender.id)
  assert.equal(offered.offer.state, 'pending')
  const firstPages = await as(incomingToken.plainTextToken, async () => {
    let afterSequence = 0
    const sequences: number[] = []
    for (;;) {
      const desk = await handover.readIncidentHandoverDesk(config.id, { offerKey: offered.offer.key, afterSequence, limit: 1 })
      assert(desk.briefing)
      assert.equal(desk.briefing.entries.length, 1)
      assert.equal(desk.briefing.entries[0]!.uncertaintyNote, 'Original uncertainty survives review pagination')
      sequences.push(desk.briefing.entries[0]!.createdSequence)
      if (!desk.briefing.hasMore) break
      afterSequence = desk.briefing.cursor
    }
    assert.deepEqual(sequences, [4, 5, 6, 7])
    return sequences
  })
  assert.equal(firstPages.length, 4)
  await as(token.plainTextToken, async () => {
    const run = simulatePublicSafety({ config, seconds: 16 })
    const point = await records.appendPublicSafetyObservation(config.id, { expectedVersion: offered.incident.version, sourceDigest: offered.offer.source.digest, captureId: run.survey.captures[0]!.id, modality: 'visible', pixel: { x: 0, y: run.survey.captures[0]!.height - 1 }, note: 'Later context is unacknowledged', uncertaintyNote: 'Later original uncertainty' })
    await records.appendPublicSafetyReview(config.id, point.observation.id, { expectedVersion: point.incident.version, sourceDigest: offered.offer.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Later review remains outside offered cutoff' })
  })
  const accepted = await as(incomingToken.plainTextToken, async () => {
    const desk = await handover.readIncidentHandoverDesk(config.id, { offerKey: offered.offer.key })
    assert.equal(desk.actionability.canAccept, true)
    assert(desk.briefing)
    assert.deepEqual(desk.briefing.newerContext, { throughSequence: 13, observations: 1, reviews: 1 })
    assert.deepEqual(desk.briefing.entries.map(entry => entry.createdSequence), [4, 5, 6, 7])
    return handover.decideIncidentHandover(config.id, { requestId: randomUUID(), offerKey: offered.offer.key, decision: 'accept', acknowledgement: desk.briefing.acknowledgementRequired })
  })
  assert.equal(accepted.offer.state, 'accepted')
  assert.deepEqual(accepted.event.newerContext, { throughSequence: 13, observations: 1, reviews: 1 })
  assert.equal(accepted.incident.coordinatorId, recipient.id)
  assert.deepEqual(accepted.incident.membership, { role: 'coordinator', version: 2 })
  assert.deepEqual((await as(token.plainTextToken, () => access.readPublicSafetyIncident(config.id))).membership, { role: 'observer', version: 2 })
  assert.equal((await as(incomingToken.plainTextToken, () => access.readPublicSafetyAudit(config.id))).entries.filter(row => row.action === 'handover-accepted').length, 1)
  console.log('PASS native recipient-bound coordination handover')
}
finally { await database.closeDatabaseConnection() }
