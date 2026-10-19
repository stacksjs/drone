import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'
const f = await setupHandoverFixture()
try {
  const seeded = await f.seed('handover-coordinator-integrity')
  const contending = await Promise.allSettled([seeded.input, { ...seeded.input, requestId: randomUUID() }].map(input => f.as(f.senderToken, () => f.handover.offerIncidentCoordination(seeded.key, input))))
  const winner = contending.find(result => result.status === 'fulfilled')
  assert(winner && winner.status === 'fulfilled')
  assert.equal(contending.filter(result => result.status === 'fulfilled').length, 1)
  for (const result of contending) if (result.status === 'rejected') assert(f.status(409)(result.reason))
  const offered = winner.value
  const before = await f.snapshot(seeded.key)
  // A controlled corruption of existing persisted membership, never a forged offer/principal.
  await f.database.db.primary.updateTable('public_safety_incident_members').set({ role: 'coordinator' }).where('incident_id', '=', before.incident!.id).where('user_id', '=', f.unrelated.id).execute()
  const corrupt = await f.snapshot(seeded.key)
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered))), f.status(409))
  assert.deepEqual(await f.snapshot(seeded.key), corrupt)
  await f.database.db.primary.updateTable('public_safety_incident_members').set({ role: 'observer' }).where('incident_id', '=', before.incident!.id).where('user_id', '=', f.unrelated.id).execute()
  const accepted = await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered)))
  const after = await f.snapshot(seeded.key)
  const coordinators = after.members.filter(row => row.role === 'coordinator' && (row.active === 1 || row.active === true))
  assert.equal(coordinators.length, 1)
  assert.equal(coordinators[0]!.user_id, accepted.incident.coordinatorId)
  console.log('PASS native coordinator corruption fails closed and transfer preserves exactly one active coordinator')
}
finally { await f.database.closeDatabaseConnection() }
