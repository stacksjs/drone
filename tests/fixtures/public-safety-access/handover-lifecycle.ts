import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'
const f = await setupHandoverFixture()
try {
  const expiring = await f.seed('handover-commit-expiry')
  const offered = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(expiring.key, { ...expiring.input, expiresInSeconds: 30 }))
  const decision = f.decision(offered)
  const deadline = Date.parse(offered.offer.expiresAt)

  const closed = await f.seed('handover-closed')
  const pending = await f.offer(closed)
  await f.as(f.senderToken, () => f.access.closePublicSafetyIncident(closed.key, { expectedVersion: pending.incident.version }))
  const closedDesk = await f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(closed.key, { offerKey: pending.offer.key }))
  assert.equal(closedDesk.offer!.state, 'invalidated')
  assert.equal(closedDesk.briefing, null)
  assert(!Object.values(closedDesk.actionability).some(Boolean))
  await assert.rejects(() => f.offer(closed), f.status(409))
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(closed.key, f.decision(pending))), f.status(409))

  const historical = await f.seed('handover-historical')
  const historicOffer = await f.offer(historical)
  const historicDecision = f.decision(historicOffer)
  const accepted = await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(historical.key, historicDecision))
  await f.as(f.recipientToken, () => f.access.closePublicSafetyIncident(historical.key, { expectedVersion: accepted.incident.version }))
  const historicDesk = await f.as(f.senderToken, () => f.handover.readIncidentHandoverDesk(historical.key, { offerKey: historicOffer.offer.key }))
  assert.equal(historicDesk.offer!.state, 'accepted')
  assert.equal(historicDesk.briefing, null)
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(historical.key, historicDecision)), f.status(409))

  const frozen = await f.seed('handover-frozen')
  const frozenOffer = await f.offer(frozen)
  const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
  const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
  const { Gate } = await import('@stacksjs/auth/gate')
  for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
  await f.as(f.senderToken, async () => {
    const preview = await retention.previewPublicSafetyRetention(frozen.key)
    assert('inventoryDigest' in preview)
    await retention.enrollPublicSafetyRetention(frozen.key, { expectedVersion: frozenOffer.incident.version, inventoryDigest: preview.inventoryDigest, policyVersion: 'local-managed-v1', requestId: randomUUID() })
  })
  const frozenState = await f.snapshot(frozen.key)
  await f.database.db.primary.updateTable('public_safety_retention_scopes').set({ freeze_state: 'frozen' }).where('incident_id', '=', frozenState.incident!.id).execute()
  for (const work of [() => f.offer(frozen), () => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(frozen.key, f.decision(frozenOffer))), () => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(frozen.key))]) await assert.rejects(work, f.status(409))
  assert.deepEqual(await f.snapshot(frozen.key), frozenState)
  console.log('PASS native closed historical reads and frozen handover refusal')

  // Normal wall time, native afterCommit callback. No clock, Auth or ORM replacement.
  await Bun.sleep(Math.max(1, deadline - Date.now() - 5000))
  let committed = false
  f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    committed = true
    assert(Date.now() < deadline, 'Actual COMMIT finished before the offered deadline')
    await Bun.sleep(Math.max(1, deadline - Date.now() + 20))
  } })
  try { await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(expiring.key, decision)), f.status(404)) }
  finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
  assert(committed)
  assert.equal((await f.as(f.recipientToken, () => f.access.readPublicSafetyIncident(expiring.key))).coordinatorId, f.recipient.id, 'Durable transfer is not undone by withholding its expired response')
  const later = await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(expiring.key, decision))
  assert.equal(later.replayed, true)
  assert.equal(later.offer.state, 'accepted')
  const read = await f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(expiring.key, { offerKey: offered.offer.key }))
  assert.equal(read.offer!.state, 'accepted')
  assert.equal(read.briefing, null)
  const { incidentDeadline } = await import('../../../resources/functions/drone/public-safety/access/deadline')
  assert.equal(incidentDeadline(later), Date.parse(expiring.config.retention.expiresAt))
  console.log('PASS new decision withholds content after actual COMMIT crosses offer expiry; historical receipt remains available')

  const unavailable = await f.seed('handover-expired-pending')
  const expiredOffer = await f.offer(unavailable)
  const realNow = Date.now
  Date.now = () => Date.parse(expiredOffer.offer.expiresAt) + 10
  try {
    const desk = await f.as(f.senderToken, () => f.handover.readIncidentHandoverDesk(unavailable.key))
    assert.equal(desk.offer, null, 'Expired pending source-bound content is unavailable')
    assert.equal(desk.briefing, null)
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(unavailable.key, { offerKey: expiredOffer.offer.key })), f.status(404))
    await assert.rejects(() => f.offer(unavailable), f.status(404))
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(unavailable.key, f.decision(expiredOffer))), f.status(409))
  }
  finally { Date.now = realNow }
  console.log('PASS expired pending offers expose no actionable briefing or source-bound receipt')
}
finally { await f.database.closeDatabaseConnection() }
