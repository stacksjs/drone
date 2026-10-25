/* eslint-disable ts/no-top-level-await, no-console */
// Actual sole-writer race; raw SQLite is only the independent owned fixture adversary/oracle.
import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupMemberExecution } from './execution-member-setup'

const h = await setupMemberExecution('admit')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let unhook: (() => void) | undefined
try {
  attachment = await h.f.as(h.f.recipientToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, h.locator, () => {})
  })
  await attachment.activate()
  const until = Date.parse(h.started.availableUntil) + 5000
  while (['waiting-for-consumer', 'running'].includes(h.slot.phase) && Date.now() < until) await Bun.sleep(20)
  assert.equal(h.slot.phase, 'completed')
  assert.equal(h.slot.producer, 'finished')
  assert.equal(h.slot.admission, 'unsubmitted')
  attachment.release()
  const completion = await h.core.readIncidentExecution(h.context, { scope: h.scope })
  assert(completion?.completion)
  const before = await h.f.snapshot(h.key)
  assert.equal(before.incident!.version, 2)
  assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  const beforeHints = h.hints.length
  let changed = 0, mutationReads = 0, guardCreatedAtReads = 0, executionWrites = 0
  let actorError: unknown, actorSnapshot: typeof before | undefined
  unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (!changed && !isInTransaction() && sql.startsWith('select') && sql.includes('from public_safety_incident_members')) {
      changed++
      try {
        // Exact existing fixture adversary: same native identity/role and incident CAS,
        // newer member generation, between actual preflight and unchanged replay/write.
        writer.query('UPDATE public_safety_incident_members SET active = 0, version = version + 1 WHERE id = ?').run(h.original.member.id)
        writer.query('UPDATE public_safety_incident_members SET active = 1, version = version + 1 WHERE id = ?').run(h.original.member.id)
        h.markActorFinished()
        const incident = writer.query('SELECT * FROM public_safety_incidents WHERE incident_key = ?').get(h.key) as NonNullable<typeof before.incident>
        assert(typeof incident.id === 'number')
        actorSnapshot = {
          incident,
          members: writer.query('SELECT * FROM public_safety_incident_members WHERE incident_id = ? ORDER BY id ASC').all(incident.id) as typeof before.members,
          audits: writer.query('SELECT * FROM public_safety_audits WHERE incident_id = ? ORDER BY sequence ASC').all(incident.id) as typeof before.audits,
        }
      }
      catch (error) { actorError = error }
      return
    }
    if (!changed || !isInTransaction()) return
    if (/^(?:insert|update|delete)\b/.test(sql)) executionWrites++
    if (sql.startsWith('select') && sql.includes('from public_safety_incidents')) {
      mutationReads++
      // Only the actual checked execution guard reads this lone column after
      // replay/current mutation auth/CAS; the earlier core precheck preceded changed.
      if (/^select (?:[a-z_]+\.)?created_at from public_safety_incidents\b/.test(sql)) guardCreatedAtReads++
    }
  } })
  await assert.rejects(() => h.f.as(h.f.recipientToken, async () => {
    const caller = h.core.captureExecutionContext(h.key)
    return h.core.admitIncidentExecution(caller, { ...h.locator, digest: completion.completion!.digest, expectedVersion: 2 })
  }), h.bindingConflict)
  if (actorError) throw actorError
  assert.equal(changed, 1)
  assert(actorSnapshot)
  assert.equal(actorSnapshot.incident!.version, 2, 'The adversary preserved the actual source writer CAS')
  const member = actorSnapshot.members.find(row => row.id === h.original.member.id)!
  assert.equal(member.version, 3)
  assert.equal(member.role, 'pilot')
  assert.equal([true, 1].includes(member.active), true)
  assert(mutationReads > 0)
  assert.equal(guardCreatedAtReads, 1, 'The actual checked guard ran on the sole mutation handle')
  assert(h.postActorAllows() > 0, 'Actual current native source eligibility survived the same-role ABA')
  assert.equal(executionWrites, 0, 'No native advance/insert/audit statement ran after the actual guard refusal')
  assert.equal(h.slot.admission, 'unsubmitted', 'Pre-write guard refusal is not an ambiguous COMMIT')
  assert.equal(h.slot.reason, null)
  assert.deepEqual(await h.f.snapshot(h.key), actorSnapshot)
  assert.equal(h.hints.length, beforeHints)
  assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  console.log(`MEMBER_AUTHORITY ${JSON.stringify({ phase: 'admit', nativeSameRoleVersion: member.version, originalVersion: h.slot.binding.memberVersion, incidentCasBefore: before.incident!.version, incidentCasAfter: actorSnapshot.incident!.version, outsideTransactionAdversary: changed, actualGuardCreatedAtReads: guardCreatedAtReads, executionWrites, admission: h.slot.admission, refusal: 'actual-sole-writer-original-binding409', sourceCount: 0 })}`)
  console.log('PASS native member ABA refuses actual source admission guard with preserved CAS')
}
finally {
  unhook?.()
  attachment?.release()
  writer.close()
  await h.close()
}
