import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'
const f = await setupHandoverFixture()
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
try {
  const seeded = await f.seed('handover-source-race')
  const before = await f.snapshot(seeded.key)
  let fired = 0, failure: unknown
  const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (fired || !sql.startsWith('select') || !sql.includes('from public_safety_sources') || !sql.includes('canonical_json')) return
    fired++
    try { writer.query('UPDATE public_safety_sources SET canonical_json = ? WHERE id = ?').run('{}', seeded.source.id) }
    catch (error) { failure = error }
  } })
  try {
    await assert.rejects(() => f.offer(seeded), f.status(409))
    if (failure) throw failure
    assert.equal(fired, 1)
    assert.deepEqual(await f.snapshot(seeded.key), before)
  }
  finally { unhook() }
  console.log('PASS native staged source change refuses handover without authority effects')
  const stable = await f.seed('handover-p0')
  const offered = await f.offer(stable)
  const input = f.decision(offered)
  const initial = await f.snapshot(stable.key)
  const replayOffer = await f.offer(stable)
  assert.equal(replayOffer.replayed, true)
  assert.equal(replayOffer.offer.expiresAt, offered.offer.expiresAt)
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.offerIncidentCoordination(stable.key, stable.input)), f.status(409))
  await assert.rejects(() => f.as(f.senderToken, () => f.handover.offerIncidentCoordination(stable.key, { ...stable.input, requestId: randomUUID() })), f.status(409))
  const hidden = await f.as(f.unrelatedToken, () => f.handover.readIncidentHandoverDesk(stable.key))
  assert.equal(hidden.offer, null)
  assert.equal(hidden.briefing, null)
  await assert.rejects(() => f.as(f.unrelatedToken, () => f.handover.readIncidentHandoverDesk(stable.key, { offerKey: offered.offer.key })), f.status(404))
  for (const user of [f.sender, f.recipient]) {
    await f.Rbac.revokePermission(user.id, 'public-safety:access', 'web')
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, input)), f.status(403))
    assert.deepEqual(await f.snapshot(stable.key), initial)
    await f.Rbac.givePermission(user.id, 'public-safety:access', 'web')
  }
  writer.query('UPDATE public_safety_sources SET canonical_json = ? WHERE id = ?').run('{}', stable.source.id)
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, input)), f.status(409))
  assert.deepEqual(await f.snapshot(stable.key), initial)
  const { publicSafetyRecordingData } = await import('../../../resources/functions/drone/public-safety/evidence')
  writer.query('UPDATE public_safety_sources SET canonical_json = ? WHERE id = ?').run(publicSafetyRecordingData(stable.run), stable.source.id)
  for (const fault of ['member', 'pointer', 'audit'] as const) {
    const table = { member: 'public_safety_incident_members', pointer: 'public_safety_incidents', audit: 'public_safety_audits' }[fault]
    const operation = fault === 'audit' ? 'INSERT' : 'UPDATE'
    const condition = fault === 'pointer' ? `NEW.id = ${initial.incident!.id}` : `NEW.incident_id = ${initial.incident!.id}`
    writer.exec(`CREATE TRIGGER reject_handover_${fault} BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'handover persistence failure'); END`)
    try {
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, input)), /handover persistence failure/)
      assert.deepEqual(await f.snapshot(stable.key), initial)
    }
    finally { writer.exec(`DROP TRIGGER reject_handover_${fault}`) }
  }
  for (const fault of ['member', 'pointer'] as const) {
    const table = fault === 'member' ? 'public_safety_incident_members' : 'public_safety_incidents'
    const condition = fault === 'pointer' ? `NEW.id = ${initial.incident!.id}` : `NEW.incident_id = ${initial.incident!.id}`
    writer.exec(`CREATE TRIGGER ignore_handover_${fault} BEFORE UPDATE ON ${table} WHEN ${condition} BEGIN SELECT RAISE(IGNORE); END`)
    try {
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, input)), f.status(409))
      assert.deepEqual(await f.snapshot(stable.key), initial)
    }
    finally { writer.exec(`DROP TRIGGER ignore_handover_${fault}`) }
  }
  const accepted = await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, input))
  const acceptedSnapshot = await f.snapshot(stable.key)
  const acceptedReplay = await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, input))
  assert.equal(acceptedReplay.replayed, true)
  assert.deepEqual(acceptedReplay.event, accepted.event)
  assert.deepEqual(await f.snapshot(stable.key), acceptedSnapshot)
  assert.equal((await f.offer(stable)).replayed, true, 'old sender can replay its historical offer after demotion')
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, { ...input, requestId: randomUUID() })), f.status(409))
  await assert.rejects(() => f.as(f.recipientToken, () => f.access.changePublicSafetyMembership(stable.key, { expectedVersion: accepted.incident.version, userId: f.recipient.id, role: 'observer' })), f.status(409))
  await f.Rbac.revokePermission(f.recipient.id, 'public-safety:access', 'web')
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(stable.key, input)), f.status(403))
  await f.Rbac.givePermission(f.recipient.id, 'public-safety:access', 'web')
  const reverse = await f.as(f.recipientToken, () => f.handover.offerIncidentCoordination(stable.key, { ...stable.input, requestId: randomUUID(), assignment: { kind: 'incident-coordination', coordinatorId: f.recipient.id, coordinatorMembershipVersion: 2 }, recipientUserId: f.sender.id, recipientMembershipVersion: 2, outgoingRole: 'reviewer' }))
  await f.as(f.senderToken, () => f.handover.decideIncidentHandover(stable.key, f.decision(reverse)))
  const aba = await f.as(f.senderToken, () => f.handover.readIncidentHandoverDesk(stable.key))
  assert.deepEqual(aba.assignment, { kind: 'incident-coordination', coordinatorId: f.sender.id, coordinatorMembershipVersion: 3 })
  await assert.rejects(() => f.as(f.senderToken, () => f.handover.offerIncidentCoordination(stable.key, { ...stable.input, requestId: randomUUID(), recipientMembershipVersion: 3 })), f.status(409))
  const currentPending = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(stable.key, { ...stable.input, requestId: randomUUID(), assignment: aba.assignment, recipientMembershipVersion: 3 }))
  assert.equal(currentPending.offer.state, 'pending')
  const historicalSelection = await f.as(f.senderToken, () => f.handover.readIncidentHandoverDesk(stable.key, { offerKey: offered.offer.key }))
  assert.equal(historicalSelection.offer!.state, 'accepted')
  assert.equal(historicalSelection.actionability.canOffer, false, 'Historical selection cannot hide the actual current pending offer')
  console.log('PASS native exact replay, independent sender and recipient platform revocation, real rollback and coordinator ABA')

  const membership = await f.seed('handover-member-aba')
  const old = await f.offer(membership)
  let version = old.incident.version
  for (const role of [null, 'reviewer', 'observer', 'reviewer']) {
    const changed = await f.as(f.senderToken, () => f.access.changePublicSafetyMembership(membership.key, { expectedVersion: version, userId: f.recipient.id, role }))
    version = changed.incident.version
  }
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(membership.key, f.decision(old))), f.status(409))
  assert.equal((await f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(membership.key, { offerKey: old.offer.key }))).offer!.state, 'invalidated')
  const renewed = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(membership.key, { ...membership.input, requestId: randomUUID(), recipientMembershipVersion: 5 }))
  assert.equal(renewed.offer.state, 'pending')
  const raced = await Promise.allSettled([
    f.as(f.recipientToken, () => f.handover.decideIncidentHandover(membership.key, f.decision(renewed))),
    f.as(f.recipientToken, () => f.handover.decideIncidentHandover(membership.key, f.decision(renewed, 'decline'))),
    f.as(f.senderToken, () => f.handover.decideIncidentHandover(membership.key, f.decision(renewed, 'cancel'))),
  ])
  assert.equal(raced.filter(result => result.status === 'fulfilled').length, 1)
  for (const result of raced) if (result.status === 'rejected') assert(f.status(409)(result.reason))
  const terminals = (await f.snapshot(membership.key)).audits.filter(row => row.handover_step === 'terminal')
  assert.equal(terminals.length, 1)
  console.log('PASS native revoke/regrant and role ABA cannot revive offers; concurrent terminal decisions have one winner')

  const capacity = await f.seed('handover-capacity')
  writer.query('UPDATE public_safety_incident_members SET version = 2147483647 WHERE incident_id = ? AND user_id = ?').run((await f.snapshot(capacity.key)).incident!.id as number, f.recipient.id)
  const exhausted = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(capacity.key, { ...capacity.input, recipientMembershipVersion: 2147483647 }))
  const capacitySnapshot = await f.snapshot(capacity.key)
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(capacity.key, f.decision(exhausted))), f.status(409))
  assert.deepEqual(await f.snapshot(capacity.key), capacitySnapshot)
  writer.query('UPDATE public_safety_incidents SET version = 2147483647 WHERE incident_key = ?').run(capacity.key)
  const commonSnapshot = await f.snapshot(capacity.key)
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(capacity.key, f.decision(exhausted, 'decline'))), f.status(409))
  assert.deepEqual(await f.snapshot(capacity.key), commonSnapshot)
  console.log('PASS native handover member and common counter exhaustion are atomic')

  const nativeToken = await f.tokens.findToken(f.recipientToken)
  assert(nativeToken)
  const permission = writer.query("SELECT id FROM permissions WHERE name = 'public-safety:access' AND guard_name = 'web'").get() as { id: number }
  for (const change of ['token', 'recipient-platform', 'sender-platform', 'membership', 'close', 'source'] as const) {
    const current = await f.seed(`handover-fresh-${change}`)
    const currentOffer = await f.offer(current)
    const previous = await f.snapshot(current.key)
    let hit = 0
    const undo = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase()
      if (hit || !sql.startsWith('select') || !sql.includes('from public_safety_sources') || !sql.includes('canonical_json')) return
      hit++
      if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked = 1 WHERE id = ?').run(nativeToken.id)
      if (change === 'recipient-platform' || change === 'sender-platform') writer.query('DELETE FROM user_permissions WHERE user_id = ? AND permission_id = ?').run(change === 'sender-platform' ? f.sender.id : f.recipient.id, permission.id)
      if (change === 'membership') writer.query('UPDATE public_safety_incident_members SET active = 0, version = version + 1 WHERE incident_id = ? AND user_id = ?').run(previous.incident!.id as number, f.recipient.id)
      if (change === 'close') writer.query("UPDATE public_safety_incidents SET status = 'closed' WHERE id = ?").run(previous.incident!.id as number)
      if (change === 'source') writer.query('UPDATE public_safety_sources SET uploaded_at_iso = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', current.source.id)
    } })
    try {
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(current.key, f.decision(currentOffer))), f.status(change === 'token' ? 401 : change === 'close' || change === 'source' ? 409 : 403))
      assert.equal(hit, 1)
      const after = await f.snapshot(current.key)
      assert.deepEqual(after.audits, previous.audits)
      assert.equal(after.incident!.version, previous.incident!.version)
      assert.equal(after.incident!.coordinator_id, f.sender.id)
      assert(after.members.every(row => row.role !== 'coordinator' || row.user_id === f.sender.id))
    }
    finally {
      undo()
      if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked = 0 WHERE id = ?').run(nativeToken.id)
      if (change === 'recipient-platform' || change === 'sender-platform') await f.Rbac.givePermission(change === 'sender-platform' ? f.sender.id : f.recipient.id, 'public-safety:access', 'web')
    }
  }
  console.log('PASS native stage-to-authority token, both platform grants, membership, closure and full-source race checks')

  const scopes = await f.seed('handover-coordinate-only')
  const coordinateSender = await f.credential(f.sender.id, ['public-safety:coordinate'])
  const scopedOffer = await f.as(coordinateSender, () => f.handover.offerIncidentCoordination(scopes.key, scopes.input))
  const onlyCoordinate = await f.credential(f.recipient.id, ['public-safety:coordinate'])
  await f.as(onlyCoordinate, () => f.handover.decideIncidentHandover(scopes.key, f.decision(scopedOffer)))
  const readOnly = await f.credential(f.recipient.id, ['public-safety:read'])
  const readOnlyDesk = await f.as(readOnly, () => f.handover.readIncidentHandoverDesk(scopes.key))
  assert(!Object.values(readOnlyDesk.actionability).some(Boolean))
  await assert.rejects(() => f.as(readOnly, () => f.handover.decideIncidentHandover(scopes.key, f.decision(scopedOffer))), f.status(403))
  let traps = 0
  const proxy = new Proxy({}, { ownKeys() { traps++; return [] } })
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(scopes.key, proxy)), f.status(422))
  assert.equal(traps, 0, 'Exact handover inputs must not run Proxy traps')
  console.log('PASS native coordinate-only offer and acceptance, read-only desk and mutation refusal and descriptor-safe inputs')

  const revocation = await f.seed('handover-replay-revoke')
  const revokeOffer = await f.offer(revocation)
  const revokeBody = f.decision(revokeOffer)
  const received = await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(revocation.key, revokeBody))
  await f.as(f.recipientToken, () => f.access.changePublicSafetyMembership(revocation.key, { expectedVersion: received.incident.version, userId: f.sender.id, role: null }))
  await assert.rejects(() => f.offer(revocation), f.status(403))
  const revokedCredential = await f.credential(f.recipient.id)
  assert.equal((await f.as(revokedCredential, () => f.handover.decideIncidentHandover(revocation.key, revokeBody))).replayed, true)
  await f.tokens.revokeToken(revokedCredential)
  await assert.rejects(() => f.as(revokedCredential, () => f.handover.decideIncidentHandover(revocation.key, revokeBody)), f.status(401))
  console.log('PASS native member and credential revocation deny historical replay after successful transfer')
}
finally { writer.close(); await f.database.closeDatabaseConnection() }
