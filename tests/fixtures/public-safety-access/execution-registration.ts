import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import { setupHandoverFixture } from './handover-setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'

const f = await setupHandoverFixture()
const { requireIncidentAccess } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { createBroadcastHub, setServer } = await import('@stacksjs/realtime/server-instance')
const hints: unknown[] = []
const hub = createBroadcastHub()
const unhookHints = hub.addBroadcastHook(hint => { hints.push(hint) })
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
const create = async (key: string) => {
  const config = examplePublicSafetyConfig()
  config.id = key; config.revision = 'r1'; config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  return { config, run: simulatePublicSafety({ config, seconds: 16 }) }
}
const sources = async (key: string) => f.as(f.senderToken, () => f.records.listPublicSafetySources(key))
try {
  const config = examplePublicSafetyConfig()
  config.id = 'registration-rollback'
  config.revision = 'r1'
  config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const run = simulatePublicSafety({ config, seconds: 16 })
  const before = await f.snapshot(config.id)
  const initialHints = hints.length
  let called = 0
  await assert.rejects(() => f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(config.id, { expectedVersion: 1, recording: run }, async (tx, access) => {
    called++
    assert.equal(access.principal.userId, f.sender.id)
    assert.equal(access.incident.version, 1)
    assert.equal((await tx.selectFrom('public_safety_sources').select('id').where('incident_id', '=', access.incident.id).execute()).length, 0)
    throw new Error('Trusted owner guard refused')
  })), /Trusted owner guard refused/)
  assert.equal(called, 1)
  assert.equal(hints.length, initialHints)
  assert.deepEqual(await f.snapshot(config.id), before)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(config.id))).entries.length, 0)
  const deadline = Date.now() + 30000
  const guarded = await f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(config.id, { expectedVersion: 1, recording: run }, async (tx, access) => {
    assert.equal(access.principal.userId, f.sender.id)
    assert.equal((await tx.selectFrom('public_safety_incidents').select('version').where('id', '=', access.incident.id).executeTakeFirst())!.version, 1)
    return deadline
  }))
  const { incidentDeadline } = await import('../../../resources/functions/drone/public-safety/access/deadline')
  let taggedObjects = 0
  const assertMinimumDeadline = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    taggedObjects++
    assert.equal(incidentDeadline(value), deadline, 'Each trusted nested registration projection retains the checked minimum')
    for (const nested of Object.values(value)) assertMinimumDeadline(nested)
  }
  assertMinimumDeadline(guarded)
  assert(taggedObjects > 20, 'The walk includes actual nested configuration and coordinate arrays')
  assert.equal(guarded.incident.version, 2)
  assert.equal(guarded.source.uploaderId, f.sender.id)
  assert.deepEqual(Object.keys(guarded).sort(), ['incident', 'source'])
  const read = await f.as(f.senderToken, () => f.records.readPublicSafetySource(config.id, guarded.source.digest))
  assert.equal(publicSafetyRecordingData(read.recording), publicSafetyRecordingData(run))
  assert.equal((await f.snapshot(config.id)).audits.at(-1)!.action, 'source-registered')
  let invalidCalled = 0
  await assert.rejects(() => f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(config.id, { expectedVersion: 2, recording: {} }, async () => { invalidCalled++; return deadline })), f.status(422))
  await assert.rejects(() => f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(config.id, { expectedVersion: 1, recording: run }, async () => { invalidCalled++; return deadline })), f.status(409))
  assert.equal(invalidCalled, 0, 'Guard follows canonical replay and current mutation/version authorization')

  const coordinate = { ...config, id: 'registration-coordinate' }
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config: coordinate }))
  const coordinateToken = await f.credential(f.sender.id, ['public-safety:coordinate'])
  const publicResult = await f.as(coordinateToken, () => f.records.registerPublicSafetySource(coordinate.id, { expectedVersion: 1, recording: simulatePublicSafety({ config: coordinate, seconds: 16 }) }))
  assert.equal(publicResult.incident.version, 2)
  assert.equal(publicResult.source.uploaderId, f.sender.id)
  assert.equal(incidentDeadline(publicResult), Date.parse(coordinate.retention.expiresAt), 'Unchanged public wrapper retains incident retention behavior')
  assert.equal(incidentDeadline(publicResult.incident.config), undefined, 'Only the checked variant deep-tags its trusted result')
  await assert.rejects(() => f.as(coordinateToken, () => f.records.registerPublicSafetySource(coordinate.id, { expectedVersion: 2, recording: run, check: true })), f.status(422))
  // These trusted fixture guards represent a previously captured owner. They use the
  // actual writer handle/current access; future execution policy still needs API tests.
  for (const change of ['token', 'member-aba', 'incarnation'] as const) {
    const staged = await create(`registration-${change}`)
    const original = await f.as(f.senderToken, () => requireIncidentAccess(staged.config.id, 'source-register'))
    const incidentRow = (await f.snapshot(staged.config.id)).incident!
    const nativeToken = await f.tokens.findToken(f.senderToken); assert(nativeToken)
    const beforeHints = hints.length
    let changed = 0, guardCalls = 0, hookError: unknown, external: Awaited<ReturnType<typeof f.snapshot>> | undefined
    const undo = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase()
      if (changed || isInTransaction() || !sql.startsWith('select') || !sql.includes('from public_safety_incident_members')) return
      changed++
      try {
        if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked = 1 WHERE id = ?').run(nativeToken.id)
        if (change === 'member-aba') {
          writer.query('UPDATE public_safety_incident_members SET active = 0, version = version + 1 WHERE id = ?').run(original.member.id)
          writer.query('UPDATE public_safety_incident_members SET active = 1, version = version + 1 WHERE id = ?').run(original.member.id)
        }
        if (change === 'incarnation') {
          // Same valid config/key/version, a genuinely replaced SQL identity and member.
          // This independent writer is the race adversary, never a migration or app writer.
          const member = writer.query('SELECT * FROM public_safety_incident_members WHERE id = ?').get(original.member.id) as Record<string, string | number | null>
          writer.query('DELETE FROM public_safety_audits WHERE incident_id = ?').run(original.incident.id)
          writer.query('DELETE FROM public_safety_incident_members WHERE incident_id = ?').run(original.incident.id)
          writer.query('DELETE FROM public_safety_incidents WHERE id = ?').run(original.incident.id)
          const { id, ...replacement } = incidentRow
          assert.equal(id, original.incident.id)
          replacement.created_at = new Date(Date.now() + 1).toISOString()
          const fields = Object.keys(replacement)
          writer.query(`INSERT INTO public_safety_incidents (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(replacement) as Array<string | number | null>)
          const replacementId = (writer.query('SELECT id FROM public_safety_incidents WHERE incident_key = ?').get(staged.config.id) as { id: number }).id
          assert.notEqual(replacementId, original.incident.id)
          const { id: memberId, ...newMember } = member
          assert.equal(memberId, original.member.id)
          newMember.incident_id = replacementId
          const memberFields = Object.keys(newMember)
          writer.query(`INSERT INTO public_safety_incident_members (${memberFields.join(',')}) VALUES (${memberFields.map(() => '?').join(',')})`).run(...Object.values(newMember))
        }
      }
      catch (error) { hookError = error }
    } })
    try {
      await assert.rejects(() => f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(staged.config.id, { expectedVersion: 1, recording: staged.run }, async (tx, current) => {
        guardCalls++
        const row = await tx.selectFrom('public_safety_incidents').select('created_at').where('id', '=', current.incident.id).executeTakeFirst()
        if (current.principal.tokenId !== original.principal.tokenId || current.principal.userId !== original.principal.userId || current.member.id !== original.member.id || current.member.version !== original.member.version || current.member.role !== original.member.role || current.incident.id !== original.incident.id || row!.created_at !== incidentRow.created_at || current.incident.config_json !== original.incident.config_json) throw new f.access.PublicSafetyAccessError(409, 'Original owner or incident scope has changed')
        return Date.now() + 30000
      })), f.status(change === 'token' ? 401 : 409))
      if (hookError) throw hookError
      assert.equal(changed, 1)
      assert.equal(guardCalls, change === 'token' ? 0 : 1)
      assert.equal(hints.length, beforeHints)
      external = await f.snapshot(staged.config.id)
      assert.equal(external.incident!.version, 1)
      assert.equal(external.audits.length, change === 'incarnation' ? 0 : 1)
    }
    finally {
      undo()
      if (change === 'token') writer.query('UPDATE oauth_access_tokens SET revoked = 0 WHERE id = ?').run(nativeToken.id)
    }
    assert.deepEqual(await f.snapshot(staged.config.id), external)
    assert.equal((await sources(staged.config.id)).entries.length, 0)
  }
  const switched = await create('registration-token-switch')
  const originalToken = await f.tokens.findToken(f.senderToken); assert(originalToken)
  let switchedGuard = 0
  await assert.rejects(async () => f.as(await f.credential(f.sender.id), () => f.records.registerPublicSafetySourceChecked(switched.config.id, { expectedVersion: 1, recording: switched.run }, async (tx, current) => {
    switchedGuard++
    assert.equal((await tx.selectFrom('public_safety_sources').select('id').where('incident_id', '=', current.incident.id).execute()).length, 0)
    if (current.principal.tokenId !== originalToken.id) throw new f.access.PublicSafetyAccessError(409, 'Original credential has changed')
    return Date.now() + 30000
  })), f.status(409))
  assert.equal(switchedGuard, 1)
  assert.equal((await sources(switched.config.id)).entries.length, 0)
  const refused = await create('registration-deadline')
  const refusedBefore = await f.snapshot(refused.config.id), refusedHints = hints.length
  for (const invalidDeadline of [Number.NaN, Number.POSITIVE_INFINITY, Date.now() - 1]) {
    await assert.rejects(() => f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(refused.config.id, { expectedVersion: 1, recording: refused.run }, async () => invalidDeadline)), f.status(404))
    assert.deepEqual(await f.snapshot(refused.config.id), refusedBefore)
    assert.equal(hints.length, refusedHints)
    assert.equal((await sources(refused.config.id)).entries.length, 0)
  }
  // Actual SQL audit refusal rolls the source INSERT and incident CAS back together.
  const refusedId = refusedBefore.incident!.id as number
  writer.exec(`CREATE TRIGGER reject_registration_audit BEFORE INSERT ON public_safety_audits WHEN NEW.incident_id = ${refusedId} BEGIN SELECT RAISE(ABORT, 'guarded audit failure'); END`)
  try {
    await assert.rejects(() => f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(refused.config.id, { expectedVersion: 1, recording: refused.run }, async () => Date.now() + 30000)), /guarded audit failure/)
    assert.deepEqual(await f.snapshot(refused.config.id), refusedBefore)
    assert.equal(hints.length, refusedHints)
    assert.equal((await sources(refused.config.id)).entries.length, 0)
  }
  finally { writer.exec('DROP TRIGGER reject_registration_audit') }

  let preCommitDeadline = 0, audited = 0
  const restoreAudit = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (audited || !isInTransaction() || !sql.startsWith('insert into public_safety_audits')) return
    audited++
    // A real elapsed deadline after the INSERT and before the transaction callback
    // returns, not a mocked clock or a replaced native transaction.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, preCommitDeadline - Date.now() + 20))
  } })
  try {
    await assert.rejects(() => f.as(f.senderToken, () => f.records.registerPublicSafetySourceChecked(refused.config.id, { expectedVersion: 1, recording: refused.run }, async () => { preCommitDeadline = Date.now() + 500; return preCommitDeadline })), f.status(404))
    assert.equal(audited, 1)
    assert.deepEqual(await f.snapshot(refused.config.id), refusedBefore)
    assert.equal(hints.length, refusedHints)
    assert.equal((await sources(refused.config.id)).entries.length, 0)
  }
  finally { restoreAudit() }

  // Expiry can occur during native COMMIT or while its response is held. In both
  // cases the expired result must be refused without pretending SQL rolled back.
  let heldResponseCases = 0
  for (const kind of ['result', 'token', 'incident', 'commit-crossing'] as const) {
    const committed = await create(`registration-commit-${kind}`)
    let token = f.senderToken, deadline = 0
    if (kind === 'token') {
      const credential = await f.tokens.createToken(f.sender.id, 'guarded short lifetime', ['public-safety:coordinate'], { expiresAt: new Date(Date.now() + 2000), withRefreshToken: false })
      token = credential.plainTextToken
      deadline = (await f.tokens.findToken(token))!.expiresAt!.getTime()
    }
    if (kind === 'incident') {
      committed.config.retention.expiresAt = new Date(Date.now() + 2500).toISOString()
      committed.run = simulatePublicSafety({ config: committed.config, seconds: 16 })
      deadline = Date.parse(committed.config.retention.expiresAt)
      writer.query('UPDATE public_safety_incidents SET config_json = ?, retain_until = ? WHERE incident_key = ?').run(publicSafetyRecordingData(committed.config), committed.config.retention.expiresAt, committed.config.id)
    }
    const before = await f.snapshot(committed.config.id), hintCount = hints.length
    let actualCommits = 0, crossingCallbacks = 0, nativeReturnMarginMs: number | null = null, refusalObserved = false
    f.database.db.primary.setTransactionDefaults({ logger: event => {
      // QB's "commit" logger is inside the transaction callback, before native
      // begin() resolves. This real elapsed pause exercises expiry across COMMIT.
      if (kind !== 'commit-crossing' || event.type !== 'commit') return
      crossingCallbacks++
      const waitMs = Math.max(1, deadline - Date.now() + 20)
      assert(waitMs <= 600, 'Controlled commit crossing retains its bounded 500 ms lifetime')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
      assert(Date.now() >= deadline, 'Controlled callback pause actually crosses expiry')
    }, afterCommit: async () => {
      actualCommits++
      // A separate native SQLite connection proves this writer's change is
      // committed. Hook receipt time is an upper bound, not a SQL commit clock.
      const persisted = writer.query('SELECT version, (SELECT COUNT(*) FROM public_safety_sources WHERE incident_id = public_safety_incidents.id) AS source_count FROM public_safety_incidents WHERE incident_key = ?').get(committed.config.id) as { version: number, source_count: number }
      assert.deepEqual(persisted, { version: 2, source_count: 1 })
      nativeReturnMarginMs = deadline - Date.now()
      if (nativeReturnMarginMs > 0) heldResponseCases++
      if (kind === 'commit-crossing') assert(nativeReturnMarginMs <= 0, 'Explicit crossing arrives after expiry')
      await Bun.sleep(Math.max(1, deadline - Date.now() + 20))
      assert(Date.now() >= deadline, 'Response release actually follows the scoped expiry')
    } })
    try {
      await assert.rejects(() => f.as(token, () => f.records.registerPublicSafetySourceChecked(committed.config.id, { expectedVersion: 1, recording: committed.run }, async () => {
        if (kind === 'result' || kind === 'commit-crossing') { deadline = Date.now() + 500; return deadline }
        return Date.now() + 30000
      })), f.status(404))
      refusalObserved = true
    }
    finally {
      f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, logger: undefined })
      const phase = nativeReturnMarginMs === null ? 'native-return-unobserved' : nativeReturnMarginMs > 0 ? 'held-after-native-return' : 'expired-at-native-return'
      console.error(`REGISTRATION_COMMIT_BOUNDARY ${JSON.stringify({ kind, phase, actualCommits, crossingCallbacks, nativeReturnMarginMs, refusalObserved, refusalMarginMs: deadline - Date.now() })}`)
    }
    assert.equal(actualCommits, 1)
    assert.equal(crossingCallbacks, kind === 'commit-crossing' ? 1 : 0)
    const after = await f.snapshot(committed.config.id)
    assert.equal(after.incident!.version, 2)
    assert.equal(after.audits.length, before.audits.length + 1)
    assert.equal(after.audits.at(-1)!.action, 'source-registered')
    assert.equal(hints.length, hintCount + 1, 'Already committed change retains exactly one refresh hint')
    // Raw native SQL is an independent persisted-state oracle even once read retention expired.
    assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_sources WHERE incident_id = ?').get(after.incident!.id as number) as { count: number }).count, 1)
    if (kind !== 'incident') assert.equal((await sources(committed.config.id)).entries.length, 1)
  }
  assert(heldResponseCases > 0, 'At least one actual native return precedes expiry and the held response crosses it')
  console.log('PASS native guarded source registration compatibility, authority, rollback and COMMIT deadlines')
}
finally { unhookHints(); setServer(null); writer.close(); await f.database.closeDatabaseConnection() }
