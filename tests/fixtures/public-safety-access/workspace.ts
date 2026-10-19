import assert from 'node:assert/strict'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
try {
  const { readIncidentWorkspace } = await import('../../../resources/functions/drone/public-safety/workspace/service')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const seeded = await f.seed('workspace-native')
  const desk = await f.as(f.senderToken, () => readIncidentWorkspace(seeded.key, { sourceDigest: seeded.source.digest, limit: 1 }))
  assert.equal(desk.profile, 'incident-workspace-v1')
  assert.equal(desk.viewer.accountId, f.sender.id)
  assert.equal(desk.throughSequence, 4)
  assert.equal(desk.incident.version, desk.throughSequence)
  assert.equal(desk.handover.incident.version, desk.throughSequence)
  assert.equal(desk.sources.entries[0]?.digest, seeded.source.digest)
  assert.equal(desk.selected?.source.digest, seeded.source.digest)
  assert.equal(desk.selected?.contextThroughSequence, 4)
  assert.deepEqual(desk.selected?.entries, [])
  assert.equal(desk.recipients?.entries.length, 1)
  assert.equal(desk.recipients?.hasMore, true)
  assert.deepEqual(Object.keys(desk.recipients!.entries[0]!).sort(), ['membershipVersion', 'role', 'userId'])
  assert(desk.actions.canRegisterSource && desk.actions.canObserve && desk.actions.canReview && desk.actions.canManageMembers && desk.actions.canClose)
  assert(!JSON.stringify(desk).includes('canonical_json'))
  const access = await f.as(f.senderToken, () => readWorkspaceAccess(seeded.key, desk.scope))
  assert.equal(access.accountId, f.sender.id)
  assert.equal(access.scope, desk.scope)
  assert.equal(access.deadline, Date.parse(desk.availableUntil))
  await f.as(f.recipientToken, async () => {
    const recipient = await readIncidentWorkspace(seeded.key)
    assert.equal(recipient.selected, null)
    assert.equal(recipient.recipients, null)
    assert.equal(recipient.actions.canReview, true)
    assert.equal(recipient.actions.canManageMembers, false)
  })
  const readOnly = await f.credential(f.sender.id, ['public-safety:read'])
  await f.as(readOnly, async () => {
    const read = await readIncidentWorkspace(seeded.key)
    assert.equal(read.viewer.canCoordinate, false)
    assert(Object.values(read.actions).every(value => value === false))
    assert(Object.values(read.handover.actionability).every(value => value === false))
  })
  console.log('PASS native workspace coherent bounded selected-source and viewer projection')
}
finally { await f.database.closeDatabaseConnection() }
