import { retainedPreview } from '../../helpers/public-safety-retained'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
const { database, User } = await setupIncidentDatabase()
const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
const { publicSafetyCreateGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { Gate } = await import('@stacksjs/auth/gate')
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
setAmbientRequestContext(true)
Gate.define('public-safety:create', publicSafetyCreateGate)
for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
try {
  const coordinator = await User.create({ name: 'Custody Coordinator', email: 'custody-coordinator@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(coordinator.id, permission, 'web') }
  const token = await createToken(coordinator.id, 'custody fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  await as(token.plainTextToken, async () => {
    const config = examplePublicSafetyConfig()
    config.id = 'retention-one'
    config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
    config.retention.hold = 'declared-review-required'
    await access.createPublicSafetyIncident({ config })
    const preview = retainedPreview(await retention.previewPublicSafetyRetention(config.id))
    assert.deepEqual(preview.counts, { sources: 0, observations: 0, reviews: 0 })
    assert.equal(preview.originalHold, 'declared-review-required')
    assert.equal(preview.purgeImplemented, false)
    const body = { expectedVersion: preview.incidentVersion, policyVersion: 'local-managed-v1', inventoryDigest: preview.inventoryDigest, requestId: randomUUID() }
    const enrollment = await retention.enrollPublicSafetyRetention(config.id, body)
    assert.equal(enrollment.scope.version, 1)
    assert.equal(enrollment.scope.incidentVersion, 2)
    assert.equal(enrollment.scope.holdState, 'pending-review')
    assert.equal(enrollment.scope.reviewRequired, true)
    assert.equal(enrollment.event.actorUserId, coordinator.id)
    assert.equal(enrollment.replayed, false)
    const due = new Date(Date.now() + 86400000).toISOString()
    const review = await retention.reviewPublicSafetyRetentionHold(config.id, { expectedRetentionVersion: 1, decision: 'retain', caseReference: 'case:synthetic-1', reviewDueAt: due, requestId: randomUUID() })
    assert.equal(review.scope.holdState, 'held')
    assert.equal(review.scope.version, 2)
    assert.equal(review.scope.incidentVersion, 3)
    assert.equal(review.scope.reviewDueAt, due)
    const replay = await retention.enrollPublicSafetyRetention(config.id, body)
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.event, enrollment.event)
    assert.equal(replay.scope.version, 2)
    assert.deepEqual((await retention.listPublicSafetyRetentionEvents(config.id)).entries.map(row => row.action), ['enrolled', 'hold-reviewed'])
  })
  console.log('PASS native custody enrollment and human hold lifecycle')
}
finally { await database.closeDatabaseConnection() }
