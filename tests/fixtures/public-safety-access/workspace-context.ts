import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const { readIncidentWorkspace } = await import('../../../resources/functions/drone/public-safety/workspace/service')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
const { incidentDeadline } = await import('../../../resources/functions/drone/public-safety/access/deadline')
const { simulatePublicSafety } = await import('../../../resources/functions/drone/public-safety/runtime')
const { publicSafetyRecordingData } = await import('../../../resources/functions/drone/public-safety/evidence')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
try {
  const seeded = await f.seed('workspace-context')
  const read = (options = {}) => f.as(f.senderToken, () => readIncidentWorkspace(seeded.key, options))
  const second = await f.as(f.senderToken, () => f.records.registerPublicSafetySource(seeded.key, { expectedVersion: 4, recording: simulatePublicSafety({ config: seeded.config, seconds: 17 }) }))
  const capture = seeded.run.survey.captures[0]!, support = seeded.run.captures[0]!.support.findIndex(value => value === 1)
  const observe = async (digest = seeded.source.digest, note = 'Observed synthetic support', uncertainty = 'Original unresolved uncertainty') => f.as(f.senderToken, async () => {
    const current = await f.access.readPublicSafetyIncident(seeded.key)
    return f.records.appendPublicSafetyObservation(seeded.key, { expectedVersion: current.version, sourceDigest: digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note, uncertaintyNote: uncertainty })
  })
  const review = (observation: Awaited<ReturnType<typeof observe>>) => f.as(f.recipientToken, () => f.records.appendPublicSafetyReview(seeded.key, observation.observation.id, { expectedVersion: observation.incident.version, sourceDigest: observation.observation.sourceDigest, previousReviewId: null, disposition: 'unresolved', note: 'Reviewed declaration with original uncertainty preserved' }))
  const first = await observe(); await review(first)
  const next = await observe(); await review(next)
  const other = await observe(second.source.digest, 'Other source context', 'Other source uncertainty')
  const offered = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(seeded.key, { ...seeded.input, sourceDigest: second.source.digest }))
  let outsideCanonical = 0
  const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (sql.startsWith('select') && sql.includes('from public_safety_sources') && sql.includes('canonical_json') && !isInTransaction()) outsideCanonical++
  } })
  const initial = await read({ sourceDigest: seeded.source.digest, limit: 1 }).finally(unhook)
  assert.equal(outsideCanonical, 2, 'Exactly selected and distinct visible offer sources stage outside the final native transaction')
  assert.equal(initial.selected!.source.digest, seeded.source.digest)
  assert.equal(initial.handover.briefing!.source.digest, second.source.digest)
  assert.equal(initial.handover.briefing!.contextThroughSequence, offered.offer.contextThroughSequence)
  assert.equal(initial.handover.briefing!.entries[0]!.id, other.observation.id)
  assert.equal(initial.availableUntil, offered.offer.expiresAt)
  const deadline = Date.parse(initial.availableUntil)
  const checkDeadline = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    assert.equal(incidentDeadline(value), deadline)
    for (const nested of Object.values(value)) checkDeadline(nested)
  }
  checkDeadline(initial)
  assert(!JSON.stringify(initial).includes('thermalCentiKelvin'))
  const later = await observe(); await review(later)
  const entries = [...initial.selected!.entries]
  let cursor = initial.selected!.cursor
  while (cursor) {
    const page = await read({ sourceDigest: seeded.source.digest, contextCursor: cursor, limit: 1 })
    assert.equal(page.throughSequence, later.incident.version + 1)
    assert.equal(page.handover.incident.version, page.throughSequence)
    assert.equal(page.selected!.contextThroughSequence, initial.throughSequence)
    assert.deepEqual(page.selected!.newerContext, { throughSequence: page.throughSequence, observations: 1, reviews: 1 })
    assert.equal(page.handover.briefing!.newerContext.observations, 0)
    entries.push(...page.selected!.entries)
    cursor = page.selected!.cursor
  }
  assert.deepEqual(entries.map(value => value.createdSequence), [first.observation.createdSequence, first.observation.createdSequence + 1, next.observation.createdSequence, next.observation.createdSequence + 1])
  assert(entries.every(value => value.sourceDigest === seeded.source.digest && value.uncertaintyNote === first.observation.uncertaintyNote))
  assert(entries.filter(value => 'observationId' in value).every(value => 'selfReview' in value && value.selfReview === false))
  const lastSource = await read({ sourcesAfterSequence: seeded.source.createdSequence, limit: 1 })
  assert.deepEqual(lastSource.sources.entries.map(value => value.digest), [second.source.digest])
  const roster1 = await read({ limit: 1 }), roster2 = await read({ limit: 1, membersAfterUserId: roster1.recipients!.cursor })
  assert.deepEqual([...roster1.recipients!.entries, ...roster2.recipients!.entries].map(value => value.userId), [f.recipient.id, f.unrelated.id])
  await f.Rbac.revokePermission(f.recipient.id, 'public-safety:access', 'web')
  assert((await read()).recipients!.entries.some(value => value.userId === f.recipient.id), 'Roster presence does not claim platform eligibility')
  await f.Rbac.givePermission(f.recipient.id, 'public-safety:access', 'web')
  const hidden = await f.as(f.unrelatedToken, () => readIncidentWorkspace(seeded.key, { sourceDigest: seeded.source.digest }))
  assert.equal(hidden.handover.offer, null); assert.equal(hidden.handover.briefing, null); assert.equal(hidden.recipients, null)
  await assert.rejects(() => f.as(f.unrelatedToken, () => readIncidentWorkspace(seeded.key, { offerKey: offered.offer.key })), f.status(404))
  let traps = 0
  await assert.rejects(() => read(new Proxy({}, { ownKeys() { traps++; return [] } })), f.status(422)); assert.equal(traps, 0)
  await assert.rejects(() => read(Object.defineProperty({}, 'limit', { enumerable: true, get() { traps++; throw new Error('must not execute') } })), f.status(422)); assert.equal(traps, 0)
  for (const options of [{ limit: 0 }, { limit: 101 }, { sourceDigest: 'bad' }, { contextCursor: initial.selected!.cursor }, { unknown: 1 }, { sourcesAfterSequence: 2147483647 }, { sourceDigest: second.source.digest, contextCursor: initial.selected!.cursor }, { limit: undefined }]) await assert.rejects(() => read(options), f.status(422))
  const tuple = JSON.parse(Buffer.from(initial.selected!.cursor!, 'base64url').toString('utf8')) as unknown[]
  tuple[3] = 2147483647
  await assert.rejects(() => read({ sourceDigest: seeded.source.digest, contextCursor: Buffer.from(JSON.stringify(tuple)).toString('base64url') }), f.status(422))
  // Controlled malformed persisted metadata, after a legitimate public observation.
  writer.query('UPDATE public_safety_observations SET note = ? WHERE id = ?').run('🔥'.repeat(1024 * 1024), first.observation.id)
  try { await assert.rejects(() => read({ sourceDigest: seeded.source.digest }), f.status(409)) }
  finally { writer.query('UPDATE public_safety_observations SET note = ? WHERE id = ?').run(first.observation.note, first.observation.id) }

  const nativeToken = await f.tokens.findToken(f.senderToken); assert(nativeToken)
  const incident = (await f.snapshot(seeded.key)).incident!
  const permission = writer.query("SELECT id FROM permissions WHERE name = 'public-safety:access' AND guard_name = 'web'").get() as { id: number }
  for (const change of ['token', 'platform', 'member', 'config', 'source', 'incarnation'] as const) {
    let hit = 0
    const undo = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase()
      if (hit || isInTransaction() || !sql.startsWith('select') || !sql.includes('from public_safety_sources') || !sql.includes('canonical_json')) return
      hit++
      if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked = 1 WHERE id = ?').run(nativeToken.id)
      if (change === 'platform') writer.query('DELETE FROM user_permissions WHERE user_id = ? AND permission_id = ?').run(f.sender.id, permission.id)
      if (change === 'member') writer.query('UPDATE public_safety_incident_members SET active = 0 WHERE incident_id = ? AND user_id = ?').run(incident.id as number, f.sender.id)
      if (change === 'config') writer.query('UPDATE public_safety_incidents SET config_json = ? WHERE id = ?').run(publicSafetyRecordingData({ ...seeded.config, policyId: 'changed-policy' }), incident.id as number)
      if (change === 'source') writer.query('UPDATE public_safety_sources SET uploaded_at_iso = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', seeded.source.id)
      if (change === 'incarnation') writer.query('UPDATE public_safety_incidents SET created_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', incident.id as number)
    } })
    try {
      await assert.rejects(() => read({ sourceDigest: seeded.source.digest }), f.status(change === 'token' ? 401 : change === 'platform' || change === 'member' ? 403 : 409))
      assert.equal(hit, 1)
    }
    finally {
      undo()
      if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked = 0 WHERE id = ?').run(nativeToken.id)
      if (change === 'platform') await f.Rbac.givePermission(f.sender.id, 'public-safety:access', 'web')
      if (change === 'member') writer.query('UPDATE public_safety_incident_members SET active = 1 WHERE incident_id = ? AND user_id = ?').run(incident.id as number, f.sender.id)
      if (change === 'config') writer.query('UPDATE public_safety_incidents SET config_json = ? WHERE id = ?').run(incident.config_json as string, incident.id as number)
      if (change === 'source') writer.query('UPDATE public_safety_sources SET uploaded_at_iso = ? WHERE id = ?').run(seeded.source.uploadedAt, seeded.source.id)
      if (change === 'incarnation') writer.query('UPDATE public_safety_incidents SET created_at = ? WHERE id = ?').run(incident.created_at as string, incident.id as number)
    }
  }
  const { Gate } = await import('@stacksjs/auth/gate')
  const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
  Gate.define('public-safety:view', async (user, key) => { await publicSafetyIncidentGate(user, key, 'view'); return false })
  await assert.rejects(() => f.as(f.senderToken, () => readWorkspaceAccess(seeded.key)), f.status(403))
  Gate.define('public-safety:view', (user, key) => publicSafetyIncidentGate(user, key, 'view'))
  await assert.rejects(() => f.as(f.senderToken, () => readWorkspaceAccess(seeded.key, 'a'.repeat(64))), f.status(409))
  const coordinateOnly = await f.credential(f.sender.id, ['public-safety:coordinate'])
  await assert.rejects(() => f.as(coordinateOnly, () => readIncidentWorkspace(seeded.key)), f.status(403))
  for (const source of [seeded.source, second.source]) {
    const original = writer.query('SELECT canonical_json FROM public_safety_sources WHERE id = ?').get(source.id) as { canonical_json: string }
    writer.query('UPDATE public_safety_sources SET canonical_json = ? WHERE id = ?').run('{}', source.id)
    try { await assert.rejects(() => read({ sourceDigest: seeded.source.digest }), f.status(409)) }
    finally { writer.query('UPDATE public_safety_sources SET canonical_json = ? WHERE id = ?').run(original.canonical_json, source.id) }
  }
  await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, f.decision(offered)))
  const outgoing = await read({ offerKey: offered.offer.key })
  assert.equal(outgoing.recipients, null)
  assert.equal(outgoing.actions.canManageMembers, false)
  assert.equal(outgoing.handover.offer!.state, 'accepted')
  assert.equal(outgoing.handover.briefing, null)
  const incoming = await f.as(f.recipientToken, () => readIncidentWorkspace(seeded.key))
  assert.equal(incoming.recipients!.entries.some(value => value.userId === f.sender.id && value.membershipVersion === 2 && value.role === 'observer'), true)
  assert.equal(incoming.actions.canManageMembers, true)
  await f.as(f.recipientToken, () => f.access.closePublicSafetyIncident(seeded.key, { expectedVersion: incoming.throughSequence }))
  const closed = await f.as(f.recipientToken, () => readIncidentWorkspace(seeded.key))
  assert.equal(closed.incident.status, 'closed')
  assert(Object.values(closed.actions).every(value => value === false))
  assert(Object.values(closed.handover.actionability).every(value => value === false))
  const retention = await import('../../../resources/functions/drone/public-safety/retention/service')
  const { publicSafetyRetentionGate } = await import('../../../resources/functions/drone/public-safety/retention/policy')
  for (const ability of ['read', 'manage', 'revoke'] as const) Gate.define(`public-safety:retention-${ability}`, (user, key) => publicSafetyRetentionGate(user, key, ability))
  await f.as(f.recipientToken, async () => {
    const preview = await retention.previewPublicSafetyRetention(seeded.key); assert('inventoryDigest' in preview)
    await retention.enrollPublicSafetyRetention(seeded.key, { expectedVersion: closed.throughSequence, inventoryDigest: preview.inventoryDigest, policyVersion: 'local-managed-v1', requestId: crypto.randomUUID() })
  })
  // A controlled persisted freeze after genuine enrollment qualifies content policy without claiming accepted purge execution.
  await f.database.db.primary.updateTable('public_safety_retention_scopes').set({ freeze_state: 'frozen' }).where('incident_id', '=', incident.id).execute()
  await assert.rejects(() => f.as(f.recipientToken, () => readIncidentWorkspace(seeded.key, { sourceDigest: seeded.source.digest })), f.status(409))
  await assert.rejects(() => f.as(f.recipientToken, () => readWorkspaceAccess(seeded.key)), f.status(409))
  console.log('PASS native workspace context, source staging, authority and byte bounds')
}
finally { writer.close(); await f.database.closeDatabaseConnection() }
