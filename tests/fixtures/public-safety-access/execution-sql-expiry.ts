/* eslint-disable ts/no-top-level-await, no-console */
// Native persisted expiry adversary, not elapsed original retention or a clock mock.
import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupMemberExecution } from './execution-member-setup'

const phase = process.argv[2]!
assert(['credit', 'result', 'admit'].includes(phase))
const h = await setupMemberExecution(`expiry-${phase}`)
const { requireIncidentAccess } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
const before = await h.f.snapshot(h.key), beforeHints = h.hints.length
const version = before.incident!.version
assert(typeof version === 'number')
const originalBinding = { ...h.slot.binding }
assert(Date.parse(originalBinding.retainUntil) > Date.now() + 60000)
const nativeSnapshot = () => {
  const incident = writer.query('SELECT * FROM public_safety_incidents WHERE incident_key = ?').get(h.key) as NonNullable<typeof before.incident>
  assert(typeof incident.id === 'number')
  return {
    incident,
    members: writer.query('SELECT * FROM public_safety_incident_members WHERE incident_id = ? ORDER BY id ASC').all(incident.id) as typeof before.members,
    audits: writer.query('SELECT * FROM public_safety_audits WHERE incident_id = ? ORDER BY sequence ASC').all(incident.id) as typeof before.audits,
  }
}
let afterActor: ReturnType<typeof nativeSnapshot> | undefined
const expire = () => {
  assert.equal(afterActor, undefined)
  const past = new Date(Date.now() - 1000).toISOString()
  writer.transaction(() => {
    const changed = writer.query('UPDATE public_safety_incidents SET retain_until = ? WHERE incident_key = ? AND version = ? AND retain_until = ?').run(past, h.key, version, originalBinding.retainUntil)
    assert.equal(changed.changes, 1)
  }).immediate()
  afterActor = nativeSnapshot()
  assert.equal(afterActor.incident.retain_until, past)
  assert.deepEqual({ ...afterActor.incident, retain_until: before.incident!.retain_until }, before.incident, 'Only the authoritative persisted retention column changed')
  assert.deepEqual(afterActor.members, before.members)
  assert.deepEqual(afterActor.audits, before.audits)
  assert(Date.parse(originalBinding.retainUntil) > Date.now())
  h.markActorFinished()
}
const unavailable = (error: unknown) => error instanceof h.f.access.PublicSafetyAccessError && error.status === 404 && error.message === 'Incident is unavailable'
const unchanged = () => {
  assert(afterActor)
  assert.deepEqual(nativeSnapshot(), afterActor)
  assert.equal(h.hints.length, beforeHints)
  assert.deepEqual(h.slot.binding, originalBinding)
  assert.equal((writer.query('SELECT COUNT(*) AS count FROM public_safety_sources WHERE incident_id = ?').get(h.slot.binding.incidentId) as { count: number }).count, 0)
}
const wait = async (predicate: () => boolean) => {
  const until = Date.parse(h.started.availableUntil) + 5000
  while (!predicate() && Date.now() < until) await Bun.sleep(20)
  assert(predicate(), `Actual execution did not reach ${phase}: ${h.slot.phase}/${h.slot.producer}`)
}
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let unhook: (() => void) | undefined
let actor: Promise<void> | undefined, actorError: unknown
let holding = false, resultSeen = false, resultMs = 0, callbacks = 0, completedViews = 0
const fifo: MessageEvent[] = []
assert(h.slot.worker)
const worker = h.slot.worker, observe = worker.onmessage
assert(observe)
const flush = () => {
  holding = false
  for (const event of fifo.splice(0)) observe.call(worker, event)
}
try {
  if (phase === 'result') {
    worker.onmessage = event => {
      if (holding) { fifo.push(event); return }
      if (event.data?.kind !== 'result') { observe.call(worker, event); return }
      resultSeen = true
      const began = performance.now()
      observe.call(worker, event)
      resultMs = performance.now() - began
      holding = true
      actor = (async () => {
        assert(h.slot.candidate)
        assert.equal(h.slot.finishedAck, false)
        assert.equal(h.slot.phase, 'running')
        expire()
        await assert.rejects(() => h.f.as(h.f.recipientToken, () => requireIncidentAccess(h.key, 'source-register')), unavailable)
        assert.equal(h.slot.phase, 'running', 'An earlier heartbeat stop cannot qualify final-result refusal')
        flush()
      })().catch(error => { actorError = error; flush() })
    }
  }
  attachment = await h.f.as(h.f.recipientToken, () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), h.locator, async value => {
    if (value.phase === 'completed' || value.completion) completedViews++
    if (!value.latestEvent) return
    callbacks++
    if (phase !== 'credit') return
    assert.equal(callbacks, 1)
    assert.equal(value.latestEvent.sequence, 1)
    expire()
    await assert.rejects(() => h.f.as(h.f.recipientToken, () => requireIncidentAccess(h.key, 'source-register')), unavailable)
    assert.equal(h.slot.phase, 'running', 'Persisted expiry is staged before callback return')
  }))
  await attachment.activate()
  if (phase !== 'admit') {
    await wait(() => h.slot.producer !== 'pending')
    if (actor) await actor
    if (actorError) throw actorError
    await h.waitProducer()
    assert.equal(h.slot.phase, 'canceled')
    assert.equal(h.slot.reason, 'authority-unavailable')
    assert.equal(h.slot.recording, null)
    assert.equal(h.slot.completion, null)
    assert.equal(completedViews, 0)
    if (phase === 'credit') {
      assert.equal(callbacks, 1)
      assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
      assert.equal(Atomics.load(h.slot.control, h.executionWords.emitted), 1)
      assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
    }
    else {
      assert(resultSeen)
      assert.equal(h.slot.finishedAck, true)
      assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
    }
    await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), unavailable)
  }
  else {
    await wait(() => h.slot.phase === 'completed')
    attachment.release()
    assert.equal(h.slot.producer, 'finished')
    const completed = await h.core.readIncidentExecution(h.context, { scope: h.scope })
    assert(completed?.completion)
    const recording = h.slot.recording
    assert(recording)
    let initialCommits = 0, postActorCommits = 0, rollbacks = 0, rollbackStatus: number | null = null, domainWrites = 0
    const stack: string[] = []
    h.f.database.db.primary.setTransactionDefaults({
      afterCommit: () => { if (afterActor) postActorCommits++; else initialCommits++ },
      onRollback: error => {
        if (!afterActor) return
        rollbacks++
        rollbackStatus = error instanceof h.f.access.PublicSafetyAccessError ? error.status : null
        if (error instanceof Error) for (const line of (error.stack ?? '').split('\n')) if (line.includes('/resources/functions/drone/public-safety/')) stack.push(line.trim())
      },
    })
    unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
      const sql = event.sql.replace(/["`]/g, '').toLowerCase()
      if (!afterActor && !isInTransaction() && sql.startsWith('select') && sql.includes('from public_safety_incident_members')) {
        try { assert.equal(initialCommits, 1); expire() }
        catch (error) { actorError = error }
      }
      else if (afterActor && isInTransaction() && /^(?:insert|update|delete)\b/.test(sql)) domainWrites++
    } })
    await assert.rejects(() => h.f.as(h.f.recipientToken, () => h.core.admitIncidentExecution(h.core.captureExecutionContext(h.key), { ...h.locator, digest: completed.completion!.digest, expectedVersion: version })), unavailable)
    unhook()
    unhook = undefined
    h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
    if (actorError) throw actorError
    assert.equal(initialCommits, 1)
    assert.equal(postActorCommits, 0)
    assert.equal(rollbacks, 1, 'Actual source mutation rolled back, not only its outside-transaction preflight')
    assert.equal(rollbackStatus, 404)
    assert(stack.some(line => line.includes('requireIncidentAccess') && line.includes('/access/policy.ts:')))
    assert(stack.some(line => line.includes('/access/mutations.ts:')))
    assert.equal(domainWrites, 0)
    assert.equal(h.slot.admission, 'unsubmitted')
    assert.equal(h.slot.reason, null)
    assert.equal(h.slot.recording, recording)
    console.log(`SQL_EXPIRY_ADMISSION ${JSON.stringify({ initialCommits, postActorCommits, rollbacks, rollbackStatus, domainWrites, stack, checkedGuardClaim: false })}`)
  }
  unchanged()
  console.log(`SQL_EXPIRY ${JSON.stringify({ phase, persistedExpiryOnly: true, originalDeadlineStillFuture: Date.parse(originalBinding.retainUntil) > Date.now(), callbacks, realCanonicalResultMs: resultMs, completedViews, sourceCount: 0, nativeRefusal: 404, naturalElapsedRetentionClaim: false })}`)
  console.log(`PASS native SQL retention expiry refuses ${phase} execution`)
}
finally {
  if (actor) await actor
  unhook?.()
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  attachment?.release()
  flush()
  try { await h.close() }
  finally { writer.close() }
}
