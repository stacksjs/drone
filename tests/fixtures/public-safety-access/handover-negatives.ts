import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'
const f = await setupHandoverFixture()
const focus = process.env.HANDOVER_NEGATIVE_CASE
try {
  const seeded = await f.seed('handover-negatives')
  const offered = await f.offer(seeded)
  if (!focus || focus === 'semantic') {
    const before = await f.snapshot(seeded.key)
    for (const changed of [{ outgoingRole: 'reviewer' }, { expiresInSeconds: 301 }, { sourceDigest: 'a'.repeat(64) }]) {
      await assert.rejects(() => f.as(f.senderToken, () => f.handover.offerIncidentCoordination(seeded.key, { ...seeded.input, ...changed })), f.status(409))
      assert.deepEqual(await f.snapshot(seeded.key), before)
    }
    const original = seeded.input
    const reordered = { expiresInSeconds: original.expiresInSeconds, outgoingRole: original.outgoingRole, sourceDigest: original.sourceDigest, recipientMembershipVersion: original.recipientMembershipVersion, recipientUserId: original.recipientUserId, assignment: { coordinatorMembershipVersion: original.assignment.coordinatorMembershipVersion, coordinatorId: original.assignment.coordinatorId, kind: original.assignment.kind }, requestId: original.requestId }
    const retried = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(seeded.key, reordered))
    assert.equal(retried.replayed, true)
    assert.equal(retried.offer.expiresAt, offered.offer.expiresAt)
    assert.deepEqual(await f.snapshot(seeded.key), before)
    const decision = f.decision(offered)
    assert(decision.decision === 'accept')
    for (const changed of [{ offerDigest: 'b'.repeat(64) }, { sourceDigest: 'c'.repeat(64) }, { contextThroughSequence: offered.offer.contextThroughSequence + 1 }, { uncertaintyAcknowledged: false }, { assignment: 'sector' }]) {
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, { ...decision, acknowledgement: { ...decision.acknowledgement, ...changed } })), f.status('uncertaintyAcknowledged' in changed || 'assignment' in changed ? 422 : 409))
      assert.deepEqual(await f.snapshot(seeded.key), before)
    }
    await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, decision))
    const after = await f.snapshot(seeded.key)
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, { requestId: decision.requestId, offerKey: offered.offer.key, decision: 'decline' })), f.status(409))
    assert.deepEqual(await f.snapshot(seeded.key), after)
    console.log('PASS same-actor semantic request conflicts, reordered equivalent replay and explicit acknowledgement negatives preserve authority')
  }
  else if (focus === 'source-config') {
    const before = await f.snapshot(seeded.key)
    const { publicSafetyRecordingData } = await import('../../../resources/functions/drone/public-safety/evidence')
    const changedConfig = { ...seeded.config, policyId: 'changed-policy' }
    await f.database.db.primary.updateTable('public_safety_incidents').set({ config_json: publicSafetyRecordingData(changedConfig) }).where('id', '=', before.incident!.id).execute()
    const changed = await f.snapshot(seeded.key)
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered))), f.status(409))
    const invalidated = await f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(seeded.key, { offerKey: offered.offer.key }))
    assert.equal(invalidated.offer!.state, 'invalidated')
    assert.equal(invalidated.briefing, null)
    assert.equal(invalidated.actionability.canAccept, false)
    assert.deepEqual(await f.snapshot(seeded.key), changed)
    await f.database.db.primary.updateTable('public_safety_incidents').set({ config_json: before.incident!.config_json }).where('id', '=', before.incident!.id).execute()
    await f.database.db.primary.updateTable('public_safety_sources').set({ canonical_json: '{}' }).where('id', '=', seeded.source.id).execute()
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(seeded.key, { offerKey: offered.offer.key })), f.status(409))
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered))), f.status(409))
    assert.deepEqual(await f.snapshot(seeded.key), before)
    console.log('PASS current config change invalidates briefing; canonical source corruption refuses desk verification and acceptance without authority effects')
  }
  else if (focus === 'offer-protocol') {
    const before = await f.snapshot(seeded.key)
    const row = before.audits.find(value => value.sequence === offered.event.sequence)!
    const details = JSON.parse(row.details_json as string)
    const { profile, ...withoutProfile } = details
    assert.equal(typeof profile, 'string')
    const corruptions = [
      { details_json: '{' }, { details_json: JSON.stringify({ ...details, unexpected: true }) }, { details_json: JSON.stringify(withoutProfile) },
      { handover_key: null }, { handover_step: null }, { handover_assignment_version: null }, { request_id: null }, { request_digest: null },
      { handover_assignment_version: 2 }, { target_user_id: f.unrelated.id }, { action: 'created' },
    ] as const
    for (const corruption of corruptions) {
      await f.database.db.primary.updateTable('public_safety_audits').set(corruption).where('id', '=', row.id).execute()
      const changed = await f.snapshot(seeded.key)
      const unavailable = (error: unknown) => f.status(409)(error) || f.status(404)(error)
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(seeded.key, { offerKey: offered.offer.key })), unavailable)
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered))), unavailable)
      await assert.rejects(() => f.offer(seeded), unavailable)
      assert.deepEqual(await f.snapshot(seeded.key), changed)
      await f.database.db.primary.updateTable('public_safety_audits').set(Object.fromEntries(Object.entries(row).filter(([key]) => key in corruption))).where('id', '=', row.id).execute()
    }
    assert.deepEqual(await f.snapshot(seeded.key), before)
    console.log('PASS malformed legitimate offer JSON, shape and lookup/detail metadata fail closed without authority effects')
  }
  else if (focus === 'terminal-protocol') {
    const cancelBody = f.decision(offered, 'cancel')
    const canceled = await f.as(f.senderToken, () => f.handover.decideIncidentHandover(seeded.key, cancelBody))
    const subsequent = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(seeded.key, { ...seeded.input, requestId: randomUUID() }))
    const before = await f.snapshot(seeded.key)
    const row = before.audits.find(value => value.sequence === canceled.event.sequence)!
    const details = JSON.parse(row.details_json as string)
    const corruptions = [
      { details_json: '[' }, { details_json: JSON.stringify({ ...details, unexpected: true }) }, { details_json: JSON.stringify({ ...details, acknowledged: true }) },
      { handover_key: null }, { handover_key: subsequent.offer.key }, { handover_step: null }, { handover_assignment_version: null }, { request_id: null }, { request_digest: null },
      { handover_assignment_version: 2 }, { target_user_id: f.unrelated.id }, { action: 'created' },
    ] as const
    for (const corruption of corruptions) {
      await f.database.db.primary.updateTable('public_safety_audits').set(corruption).where('id', '=', row.id).execute()
      const changed = await f.snapshot(seeded.key)
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(seeded.key, { offerKey: offered.offer.key })), f.status(409))
      await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered))), f.status(409))
      const refused = (error: unknown) => f.status(409)(error) || f.status(404)(error)
      await assert.rejects(() => f.as(f.senderToken, () => f.handover.decideIncidentHandover(seeded.key, cancelBody)), refused)
      assert.deepEqual(await f.snapshot(seeded.key), changed)
      await f.database.db.primary.updateTable('public_safety_audits').set(Object.fromEntries(Object.entries(row).filter(([key]) => key in corruption))).where('id', '=', row.id).execute()
    }
    assert.equal((await f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(seeded.key, { offerKey: offered.offer.key }))).offer!.state, 'canceled')
    assert.deepEqual(await f.snapshot(seeded.key), before)
    console.log('PASS malformed legitimate terminal JSON, null fields and rebinding cannot revive canceled responsibility offers')
  }
  else if (focus === 'byte-guard') {
    await f.as(f.senderToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered, 'cancel')))
    const oversized = '🙂'.repeat(600)
    assert.equal(Buffer.byteLength(oversized, 'utf8'), 2400)
    // The SQLite column is TEXT. This controlled malformed metadata is outside public admission,
    // while the actual public offer body and full canonical source remain legitimate.
    await f.database.db.primary.updateTable('public_safety_sources').set({ uploaded_at_iso: oversized }).where('id', '=', seeded.source.id).execute()
    const before = await f.snapshot(seeded.key)
    const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
    let auditInserts = 0, counterUpdates = 0
    const unhook = registerPersistentQueryHooks({
      onQueryStart(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (sql.startsWith('insert into public_safety_audits')) auditInserts++
      },
      onQueryEnd(event) {
        const sql = event.sql.replace(/["`]/g, '').toLowerCase()
        if (sql.startsWith('update public_safety_incidents')) counterUpdates++
      },
    })
    try {
      await assert.rejects(() => f.as(f.senderToken, () => f.handover.offerIncidentCoordination(seeded.key, { ...seeded.input, requestId: randomUUID() })), f.status(409))
      assert.equal(counterUpdates, 1, 'The real common counter update is attempted before details admission')
      assert.equal(auditInserts, 0, 'UTF-8 details overflow is refused before a native audit insert is attempted')
      assert.deepEqual(await f.snapshot(seeded.key), before, 'The attempted common-counter update rolls back with the rejected offer')
    }
    finally { unhook() }
    console.log('PASS public native offer rejects oversized UTF-8 source metadata before audit insert and rolls back its common counter')
  }
  else if (focus === 'terminal-null-step') {
    const canceled = await f.as(f.senderToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered, 'cancel')))
    await f.database.db.primary.updateTable('public_safety_audits').set({ handover_step: null }).where('incident_id', '=', (await f.snapshot(seeded.key)).incident!.id).where('sequence', '=', canceled.event.sequence).execute()
    const corrupt = await f.snapshot(seeded.key)
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(seeded.key, { offerKey: offered.offer.key })), f.status(409))
    await assert.rejects(() => f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered))), f.status(409))
    assert.deepEqual(await f.snapshot(seeded.key), corrupt)
    console.log('PASS corrupted terminal slot cannot revive a legitimately canceled offer')
  }
}
finally { await f.database.closeDatabaseConnection() }
