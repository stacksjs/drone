/* eslint-disable ts/no-top-level-await, no-console */
// Actual native admission with one controlled hold after a genuine outside-TX Gate allow.
import assert from 'node:assert/strict'
import { setupAdmissionLifetime } from './execution-admission-lifetime-setup'

const mode = Bun.argv[2]
assert(mode === 'close-first' || mode === 'admit-first' || mode === 'ttl')
const h = await setupAdmissionLifetime(mode)
const { Gate } = await import('@stacksjs/auth/gate')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
let phase: 'initial' | 'held' | 'released' = 'initial'
let initialAuthorityCommits = 0, heldCommits = 0, otherReleasedCommits = 0, writerCommits = 0
let rollbacks = 0, rollbackStatus: number | null = null, writes = 0, sourceInserts = 0, auditInserts = 0, advances = 0
let writerAwaitingCommit = false, armed = false, held = false, settled = false
let release!: () => void
const released = new Promise<void>(resolve => { release = resolve })
const order: string[] = [], rollbackFrames: string[] = [], gateFrames: string[] = []
type Outcome = { ok: true, value: Awaited<ReturnType<typeof h.core.admitIncidentExecution>> } | { ok: false, error: unknown }
let admission: Promise<Outcome> | undefined
let unhook: (() => void) | undefined
const summary = () => ({ mode, initialAuthorityCommits, heldCommits, otherReleasedCommits, writerCommits, rollbacks, rollbackStatus, writes, sourceInserts, auditInserts, advances, order, rollbackFrames, gateFrames, admission: h.slot.admission, slotRetained: h.executionOwner().slot === h.slot, queryHooksCoverRawSql: false })
try {
  if (mode !== 'close-first') h.f.database.db.primary.setTransactionDefaults({
    afterCommit: () => {
      if (phase === 'initial') { initialAuthorityCommits++; order.push('initial-native-authority-commit') }
      else if (phase === 'held') { heldCommits++; order.push('held-fresh-authority-commit') }
      else if (writerAwaitingCommit) { writerAwaitingCommit = false; writerCommits++; order.push('actual-source-writer-commit') }
      else { otherReleasedCommits++; order.push('released-other-native-commit') }
    },
    onRollback: error => {
      if (phase !== 'released') return
      rollbacks++
      rollbackStatus = error instanceof h.f.access.PublicSafetyAccessError ? error.status : null
      order.push('released-native-rollback')
      if (error instanceof Error) for (const line of (error.stack ?? '').split('\n')) if (line.includes('/resources/functions/drone/public-safety/')) rollbackFrames.push(line.trim())
    },
  })
  unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (!/^(?:insert|update|delete)\b/.test(sql) || !sql.includes('public_safety_')) return
    writes++
    if (/^insert into public_safety_sources\b/.test(sql)) { sourceInserts++; writerAwaitingCommit = true; order.push('actual-source-insert') }
    if (/^insert into public_safety_audits\b/.test(sql)) { auditInserts++; order.push('actual-source-audit-insert') }
    if (/^update public_safety_incidents\b/.test(sql)) { advances++; order.push('actual-incident-cas-update') }
  } })
  if (mode === 'close-first') {
    assert.equal((await h.fresh(captured => h.core.closeIncidentExecution(captured, h.locator))).phase, 'discarded')
    assert.equal(h.executionOwner().slot, null)
    await assert.rejects(() => h.fresh(captured => h.core.admitIncidentExecution(captured, h.input)), h.f.status(404))
    assert.equal(writes, 0)
    await h.unchanged()
  }
  else {
    Gate.define('public-safety:source-register', async (user, key) => {
      const allowed = await publicSafetyIncidentGate(user, key, 'source-register')
      if (armed && !isInTransaction()) {
        armed = false
        assert.equal(allowed, true, 'The actual current native Gate allowed before the hold')
        assert.equal(h.slot.admission, 'submitting')
        assert.equal(initialAuthorityCommits, 1, 'The actual initial core authority COMMIT precedes outside-TX source preflight')
        for (const line of (new Error('Actual outside-TX delegated Gate').stack ?? '').split('\n')) if (line.includes('/resources/functions/drone/public-safety/')) gateFrames.push(line.trim())
        phase = 'held'; held = true; order.push('genuine-outside-transaction-gate-held')
        await released
      }
      return allowed
    })
    armed = true
    admission = h.fresh(captured => h.core.admitIncidentExecution(captured, h.input)).then<Outcome, Outcome>(value => ({ ok: true, value }), error => ({ ok: false, error })).finally(() => { settled = true })
    await h.wait(() => held || settled, 'Reach the genuine delegated outside-transaction source preflight')
    assert(held, 'Admission must not settle before the actual controlled preflight hold')
    assert.equal(settled, false)
    assert.equal(h.executionOwner().slot, h.slot)
    assert.equal(writes, 0)
    console.log(`ADMISSION_LIFETIME ${JSON.stringify({ oracle: 'actual-outside-transaction-hold', ...summary() })}`)
    if (mode === 'ttl') {
      const expiry = h.slot.metadataDeadline, observedAt = Date.now(), began = performance.now()
      assert(expiry > observedAt + 50000, 'Observe the original unshortened 60-second metadata TTL')
      assert(h.slot.binding.authorityUntil > expiry + 60000, 'Token and incident authority outlive this metadata TTL')
      assert(Date.parse(h.slot.binding.retainUntil) > expiry + 60000)
      console.log(`ADMISSION_LIFETIME ${JSON.stringify({ oracle: 'actual-submitting-retention-begins', configuredMs: h.limits.retainedMs, remainingMs: expiry - observedAt, metadataDeadline: expiry, tokenIncidentAuthorityRemainFuture: true })}`)
      // Ordinary scalar time/slot waiting only. No repeated native policy/SQL polling.
      await h.untilWall(expiry - 1000)
      assert.equal(h.executionOwner().slot, h.slot)
      assert.equal(h.slot.admission, 'submitting')
      assert(h.slot.recording && h.slot.completion)
      await h.untilWall(expiry + 100)
      await h.wait(() => h.slot.recording === null && h.slot.completion === null, 'Actual metadata timer clears the retained candidate fields')
      assert.equal(h.slot.candidate, null)
      assert.equal(h.slot.latestEvent, null)
      assert.equal(h.executionOwner().slot, h.slot, 'A real pending writer retains its submitting reservation beyond metadata TTL')
      assert.equal(settled, false)
      console.log(`ADMISSION_LIFETIME ${JSON.stringify({ oracle: 'actual-submitting-retention-expired', elapsedMs: performance.now() - began, expiryPassedMs: Date.now() - expiry, slotRetained: true, slotCandidateCleared: true, allRecordingCopiesErased: false })}`)
      await assert.rejects(() => h.fresh(captured => h.core.closeIncidentExecution(captured, h.locator)), h.f.status(409))
      await assert.rejects(() => h.newStart(), h.f.status(409))
    }
    else {
      await assert.rejects(() => h.fresh(captured => h.core.closeIncidentExecution(captured, h.locator)), h.f.status(409))
      await assert.rejects(() => h.fresh(captured => h.core.admitIncidentExecution(captured, h.input)), h.f.status(409))
    }
    assert.equal(settled, false)
    assert.equal(writes, 0, 'Concurrent close/start/duplicate cannot write while the genuine preflight is held')
    phase = 'released'; order.push('genuine-outside-transaction-gate-released'); release()
    const outcome = await admission
    console.log(`ADMISSION_LIFETIME ${JSON.stringify({ oracle: 'actual-admission-settled', ...summary(), outcome: outcome.ok ? 'committed-response' : 'refusal', refusalStatus: !outcome.ok && outcome.error instanceof h.f.access.PublicSafetyAccessError ? outcome.error.status : null })}`)
    if (mode === 'ttl') {
      assert.equal(outcome.ok, false)
      if (!outcome.ok) assert(h.f.status(404)(outcome.error))
      assert.equal(rollbacks, 1, 'The unchanged writer reached and rolled back its real mutation transaction')
      assert.equal(rollbackStatus, 404)
      assert(rollbackFrames.some(frame => frame.includes('/access/mutations.ts:')), 'Refusal comes from the actual native mutation callback')
      assert(rollbackFrames.some(frame => frame.includes('/execution/service.ts:')), 'The actual checked execution guard refuses expired candidate eligibility')
      assert.equal(writes, 0, 'Actual transaction guard refuses before source/CAS/audit DML')
      assert.equal(writerCommits, 0)
      assert.equal(h.slot.admission, 'unsubmitted')
      assert.equal(h.executionOwner().slot, null, 'Actual finally disposal releases only after the real mutation promise settles')
      assert.equal(await h.fresh(captured => h.core.readIncidentExecution(captured, { scope: h.scope })), null)
      await h.unchanged()
    }
    else {
      assert.equal(outcome.ok, true)
      if (outcome.ok) {
        assert.equal(outcome.value.source.digest, h.input.digest)
        assert.equal(outcome.value.source.uploaderId, h.f.sender.id)
        assert.equal(outcome.value.incident.version, h.input.expectedVersion + 1)
      }
      assert.equal(writerCommits, 1)
      assert.equal(sourceInserts, 1)
      assert.equal(auditInserts, 1)
      assert.equal(advances, 1)
      assert.equal(rollbacks, 0)
      assert.equal(h.slot.admission, 'confirmed')
      assert.equal(await h.sourceCount(), 1)
      const durable = await h.f.snapshot(h.key)
      assert.equal(durable.incident!.version, h.input.expectedVersion + 1)
      assert.equal(durable.audits.length, h.before.audits.length + 1)
      assert.equal(durable.audits.at(-1)!.action, 'source-registered')
      assert.equal((await h.fresh(captured => h.core.closeIncidentExecution(captured, h.locator))).phase, 'discarded')
      assert.equal(h.executionOwner().slot, null)
      assert.equal(await h.sourceCount(), 1)
      assert.deepEqual(await h.f.snapshot(h.key), durable, 'Later close cannot undo the genuine committed source/CAS/audit')
    }
  }
  console.log(`ADMISSION_LIFETIME ${JSON.stringify(summary())}`)
  console.log(`PASS native execution admission lifetime ${mode}`)
}
finally {
  // Release and observe the genuine in-flight native promise before hooks/DB cleanup.
  release()
  await admission
  unhook?.()
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  Gate.define('public-safety:source-register', (user, key) => publicSafetyIncidentGate(user, key, 'source-register'))
  await h.close()
}
