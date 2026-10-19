import { randomUUID } from 'node:crypto'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
export async function setupHandoverFixture() {
  const { database, User } = await setupIncidentDatabase()
  const access = await import('../../../resources/functions/drone/public-safety/access/service')
  const records = await import('../../../resources/functions/drone/public-safety/access/records')
  const handover = await import('../../../resources/functions/drone/public-safety/access/handover')
  const policy = await import('../../../resources/functions/drone/public-safety/access/handover-policy')
  const { incidentAbilities } = await import('../../../resources/functions/drone/public-safety/access/types')
  const { publicSafetyCreateGate, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
  const { Gate } = await import('@stacksjs/auth/gate')
  const { Rbac } = await import('@stacksjs/auth/rbac')
  const tokens = await import('@stacksjs/auth/tokens')
  const { enhanceRequest, runWithRequest } = await import('@stacksjs/router')
  const { setAmbientRequestContext } = await import('@stacksjs/router/request-context')
  setAmbientRequestContext(true)
  Gate.define('public-safety:create', publicSafetyCreateGate)
  for (const ability of incidentAbilities) Gate.define(`public-safety:${ability}`, (user, key) => publicSafetyIncidentGate(user, key, ability))
  for (const ability of ['read', 'write'] as const) Gate.define(`public-safety:handover-${ability}`, (user, key) => policy.publicSafetyHandoverGate(user, key, ability))
  const as = <T>(token: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request('https://incident.invalid/api/public-safety/incidents', { headers: { authorization: `Bearer ${token}` } }) as Parameters<typeof enhanceRequest>[0]), work)
  const sender = await User.create({ name: 'Outgoing Coordinator', email: 'handover-sender@example.invalid', password: 'temporary-fixture-password' })
  const recipient = await User.create({ name: 'Incoming Coordinator', email: 'handover-recipient@example.invalid', password: 'temporary-fixture-password' })
  const unrelated = await User.create({ name: 'Unrelated Observer', email: 'handover-unrelated@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) await Rbac.createPermission(permission, 'web')
  for (const user of [sender, recipient, unrelated]) await Rbac.givePermission(user.id, 'public-safety:access', 'web')
  for (const user of [sender, recipient]) await Rbac.givePermission(user.id, 'public-safety:create', 'web')
  const credential = async (userId: number, scopes = ['public-safety:read', 'public-safety:coordinate']) => (await tokens.createToken(userId, 'handover fixture', scopes, { withRefreshToken: false })).plainTextToken
  const senderToken = await credential(sender.id), recipientToken = await credential(recipient.id), unrelatedToken = await credential(unrelated.id)
  const seed = async (key: string, lifetime = 86400000) => as(senderToken, async () => {
    const config = examplePublicSafetyConfig()
    config.id = key
    config.revision = 'r1'
    config.visitId = 'v1'
    config.retention.expiresAt = new Date(Date.now() + lifetime).toISOString()
    await access.createPublicSafetyIncident({ config })
    await access.changePublicSafetyMembership(key, { expectedVersion: 1, userId: recipient.id, role: 'reviewer' })
    await access.changePublicSafetyMembership(key, { expectedVersion: 2, userId: unrelated.id, role: 'observer' })
    const run = simulatePublicSafety({ config, seconds: 16 })
    const source = (await records.registerPublicSafetySource(key, { expectedVersion: 3, recording: run })).source
    const input = { requestId: randomUUID(), assignment: { kind: 'incident-coordination' as const, coordinatorId: sender.id, coordinatorMembershipVersion: 1 }, recipientUserId: recipient.id, recipientMembershipVersion: 1, sourceDigest: source.digest, outgoingRole: 'observer' as const, expiresInSeconds: 300 }
    return { key, config, run, source, input }
  })
  const offer = async (seeded: Awaited<ReturnType<typeof seed>>) => as(senderToken, () => handover.offerIncidentCoordination(seeded.key, seeded.input))
  const decision = (offered: Awaited<ReturnType<typeof offer>>, kind: 'accept' | 'decline' | 'cancel' = 'accept') => {
    const base = { requestId: randomUUID(), offerKey: offered.offer.key }
    return kind === 'accept' ? { ...base, decision: 'accept' as const, acknowledgement: { offerDigest: offered.offer.digest, assignment: 'incident-coordination' as const, sourceDigest: offered.offer.source.digest, contextThroughSequence: offered.offer.contextThroughSequence, uncertaintyAcknowledged: true as const } } : { ...base, decision: kind }
  }
  const status = (code: number) => (error: unknown) => error instanceof access.PublicSafetyAccessError && error.status === code
  const snapshot = async (key: string) => {
    const incident = await database.db.primary.selectFrom('public_safety_incidents').selectAll().where('incident_key', '=', key).executeTakeFirst()
    return { incident, members: await database.db.primary.selectFrom('public_safety_incident_members').selectAll().where('incident_id', '=', incident!.id).orderBy('id', 'asc').execute(), audits: await database.db.primary.selectFrom('public_safety_audits').selectAll().where('incident_id', '=', incident!.id).orderBy('sequence', 'asc').execute() }
  }
  return { database, access, records, handover, policy, Rbac, tokens, sender, recipient, unrelated, senderToken, recipientToken, unrelatedToken, credential, as, seed, offer, decision, status, snapshot }
}
