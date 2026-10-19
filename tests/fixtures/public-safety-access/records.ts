import assert from 'node:assert/strict'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
const { database, User } = await setupIncidentDatabase()
const access = await import('../../../resources/functions/drone/public-safety/access/service')
const records = await import('../../../resources/functions/drone/public-safety/access/records')
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
const as = <T>(token: string, action: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), action)
try {
  const coordinator = await User.create({ name: 'Record Coordinator', email: 'record-coordinator@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) { await Rbac.createPermission(permission, 'web'); await Rbac.givePermission(coordinator.id, permission, 'web') }
  const credential = await createToken(coordinator.id, 'record fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })
  const config = examplePublicSafetyConfig()
  config.id = 'records-one'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const recording = simulatePublicSafety({ config, seconds: 16 })
  await as(credential.plainTextToken, async () => {
    await access.createPublicSafetyIncident({ config })
    const registered = await records.registerPublicSafetySource(config.id, { expectedVersion: 1, recording })
    assert.equal(registered.incident.version, 2)
    assert.equal(registered.source.uploaderId, coordinator.id)
    assert.equal(registered.source.sourceIdentityAuthenticated, false)
    const read = await records.readPublicSafetySource(config.id, registered.source.digest)
    assert.equal(publicSafetyRecordingData(read.recording), publicSafetyRecordingData(recording))
    assert.equal((await records.listPublicSafetySources(config.id)).entries.length, 1)
    assert.equal((await access.readPublicSafetyAudit(config.id)).entries.at(-1)?.action, 'source-registered')
    const capture = recording.survey.captures[0]!, thermal = recording.captures[0]!
    const support = thermal.support.findIndex(value => value === 1)
    assert(support >= 0)
    const observationInput = { expectedVersion: 2, sourceDigest: registered.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'Explicit source pixel declaration', uncertaintyNote: 'Synthetic source, physical meaning unqualified' }
    const appended = await records.appendPublicSafetyObservation(config.id, observationInput)
    assert.equal(appended.incident.version, 3)
    assert.deepEqual(appended.observation.pixel, observationInput.pixel)
    assert.equal(appended.observation.actorId, coordinator.id)
    assert.deepEqual(await records.readPublicSafetyObservation(config.id, appended.observation.id), appended.observation)
    const review = await records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: 3, sourceDigest: registered.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Physical meaning remains unqualified' })
    assert.equal(review.incident.version, 4)
    assert.equal(review.review.selfReview, true)
    const latest = await records.appendPublicSafetyReview(config.id, appended.observation.id, { expectedVersion: 4, sourceDigest: registered.source.digest, previousReviewId: review.review.id, disposition: 'supported-by-source', note: 'Source supports the pixel declaration, physical meaning remains unqualified' })
    assert.equal(latest.incident.version, 5)
    assert.deepEqual((await records.listPublicSafetyReviews(config.id, appended.observation.id)).entries.map(row => row.disposition), ['unresolved', 'supported-by-source'])
    assert.deepEqual(await records.readPublicSafetyObservation(config.id, appended.observation.id), appended.observation)
    assert.equal((await records.listPublicSafetyObservations(config.id)).entries.length, 1)
  })
  console.log('PASS native persisted source, explicit observation and append-only review lifecycle')
}
finally { await database.closeDatabaseConnection() }
