/* eslint-disable ts/no-top-level-await, no-console */
// Public non-adoption through distinct genuine credentials for the same account.
// No request-header/ALS replacement, token mutation or private protocol scheduling.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupMemberExecution } from './execution-member-setup'

const mode = process.argv[2]!
assert(['reserved', 'completed', 'admission'].includes(mode))
const h = await setupMemberExecution(`ownership-${mode}`)
const { requireIncidentAccess } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
// setupMemberExecution owns the real native createBroadcastHub and its hint hook.
const secondCredential = await h.f.credential(h.f.recipient.id)
const originalToken = await h.f.tokens.findToken(h.f.recipientToken)
const secondToken = await h.f.tokens.findToken(secondCredential)
assert(originalToken && secondToken)
assert.notEqual(originalToken.id, secondToken.id)
assert.equal(originalToken.userId, secondToken.userId)
assert.equal(originalToken.userId, h.f.recipient.id)
assert.deepEqual([...originalToken.scopes].sort(), [...secondToken.scopes].sort())
assert.equal(h.slot.binding.accountId, originalToken.userId)
assert.equal(h.slot.binding.tokenId, originalToken.id)
const originalBinding = { ...h.slot.binding }
const fresh = <T>(token: string, work: (context: ReturnType<typeof h.core.captureExecutionContext>) => Promise<T>) => h.f.as(token, () => work(h.core.captureExecutionContext(h.key)))
const original = <T>(work: (context: ReturnType<typeof h.core.captureExecutionContext>) => Promise<T>) => fresh(h.f.recipientToken, work)
const alternate = <T>(work: (context: ReturnType<typeof h.core.captureExecutionContext>) => Promise<T>) => fresh(secondCredential, work)
const eligible = await h.f.as(secondCredential, () => requireIncidentAccess(h.key, 'source-register'))
assert.equal(eligible.principal.tokenId, secondToken.id)
assert.equal(eligible.principal.userId, h.slot.binding.accountId)
assert.equal(eligible.member.id, h.slot.binding.memberId)
assert.equal(eligible.member.version, h.slot.binding.memberVersion)
const before = await h.f.snapshot(h.key), beforeHints = h.hints.length
const domainWrites: string[] = []
const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
  const sql = event.sql.replace(/["`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const write = /^(insert into|update|delete from) (public_safety_[a-z_]+)\b/.exec(sql)
  if (write) domainWrites.push(`${write[1]}:${write[2]}`)
} })
const slot = h.slot as typeof h.slot & { subscriber: unknown }
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let alternateViews = 0, originalEvents = 0, originalAdmissions = 0
const wait = async (predicate: () => boolean, message: string, timeoutMs = 8000) => {
  const until = performance.now() + timeoutMs
  while (!predicate() && performance.now() < until) await Bun.sleep(10)
  assert(predicate(), message)
}
const sourceCount = async () => (await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length
const unchanged = async () => {
  assert.deepEqual(await h.f.snapshot(h.key), before)
  assert.equal(await sourceCount(), 0)
  assert.deepEqual(domainWrites, [], 'Different-token refusal must execute no source/incident/audit DML')
  assert.equal(h.hints.length, beforeHints, 'Different-token refusal emits no afterCommit refresh')
  assert.deepEqual(h.slot.binding, originalBinding, 'A different credential never replaces the original run binding')
  assert.equal(alternateViews, 0)
}
try {
  if (mode === 'reserved') {
    assert.equal(slot.subscriber, null, 'No existing observer can explain the alternate attach refusal')
    assert.equal(h.slot.phase, 'waiting-for-consumer')
    assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
    await assert.rejects(() => alternate(context => h.core.readIncidentExecution(context, { scope: h.scope })), h.bindingConflict)
    await assert.rejects(() => alternate(context => h.core.attachIncidentExecution(context, h.locator, () => { alternateViews++ })), h.bindingConflict)
    await assert.rejects(() => alternate(context => h.core.closeIncidentExecution(context, h.locator)), h.bindingConflict)
    await assert.rejects(() => alternate(context => h.core.startIncidentExecution(context, { intent: randomUUID(), scope: h.scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))), error => h.f.status(429)(error) && error instanceof Error && error.message === 'An execution reservation is already retained')
    assert.equal(slot.subscriber, null)
    assert.equal(h.slot.phase, 'waiting-for-consumer')
    assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
    await unchanged()
    attachment = await original(context => h.core.attachIncidentExecution(context, h.locator, async value => {
      if (!value.latestEvent || originalEvents) return
      originalEvents++
      assert.equal(value.latestEvent.sequence, 1)
      await original(captured => h.core.closeIncidentExecution(captured, h.locator))
    }))
    await attachment.activate()
    await h.waitProducer()
    assert.equal(originalEvents, 1, 'The original credential can still consume its actual first event and stop')
    assert.equal(h.slot.phase, 'canceled')
    assert.equal(h.slot.reason, 'stopped-by-owner')
    assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
    await unchanged()
  }
  else {
    attachment = await original(context => h.core.attachIncidentExecution(context, h.locator, value => {
      if (value.latestEvent && value.latestEvent.sequence > originalEvents) {
        assert.equal(value.latestEvent.sequence, originalEvents + 1)
        originalEvents++
      }
    }))
    await attachment.activate()
    await wait(() => h.slot.phase === 'completed', 'The actual eight-second producer completes with its genuine final handshake', Math.max(1, Date.parse(h.started.availableUntil) - Date.now() + 1000))
    attachment.release()
    assert.equal(slot.subscriber, null)
    assert.equal(h.slot.producer, 'finished')
    assert.equal(h.slot.finishedAck, true)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
    const completed = await original(context => h.core.readIncidentExecution(context, { scope: h.scope }))
    assert(completed?.completion)
    assert.equal(completed.completion.eventCount, originalEvents)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), originalEvents)
    const recording = h.slot.recording
    assert(recording)
    const admission = { ...h.locator, digest: completed.completion.digest, expectedVersion: before.incident!.version as number }
    if (mode === 'completed') {
      await assert.rejects(() => alternate(context => h.core.readIncidentExecution(context, { scope: h.scope })), h.bindingConflict)
      await assert.rejects(() => alternate(context => h.core.attachIncidentExecution(context, h.locator, () => { alternateViews++ })), h.bindingConflict)
      await assert.rejects(() => alternate(context => h.core.closeIncidentExecution(context, h.locator)), h.bindingConflict)
    }
    await assert.rejects(() => alternate(context => h.core.admitIncidentExecution(context, admission)), h.bindingConflict)
    await unchanged()
    assert.equal(h.slot.phase, 'completed')
    assert.equal(h.slot.admission, 'unsubmitted')
    assert.equal(h.slot.recording, recording, 'The original completed bytes survive alternate credential refusal')
    assert.deepEqual((await original(context => h.core.readIncidentExecution(context, { scope: h.scope })))!.completion, completed.completion)
    const registered = await original(context => h.core.admitIncidentExecution(context, admission))
    originalAdmissions++
    assert.equal(registered.source.digest, completed.completion.digest)
    assert.equal(registered.source.uploaderId, h.f.recipient.id)
    assert.equal(registered.incident.version, Number(before.incident!.version) + 1)
    const catalog = await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))
    assert.equal(catalog.entries.length, 1)
    assert.equal(catalog.entries[0]!.digest, completed.completion.digest)
    const after = await h.f.snapshot(h.key)
    assert.equal(after.incident!.version, Number(before.incident!.version) + 1)
    assert.deepEqual(after.members, before.members)
    assert.equal(after.audits.length, before.audits.length + 1)
    assert.equal(after.audits.at(-1)!.action, 'source-registered')
    assert.deepEqual(domainWrites.toSorted(), ['update:public_safety_incidents', 'insert into:public_safety_sources', 'insert into:public_safety_audits'].toSorted(), 'Exactly the original sole writer advances, inserts and audits once')
    await wait(() => h.hints.length === beforeHints + 1, 'The original successful writer produces its native afterCommit refresh')
    assert.equal(h.slot.admission, 'confirmed')
    const admittedWrites = [...domainWrites]
    await assert.rejects(() => original(context => h.core.admitIncidentExecution(context, { ...admission, expectedVersion: registered.incident.version })), h.f.status(409))
    assert.deepEqual(domainWrites, admittedWrites)
    assert.deepEqual(await h.f.snapshot(h.key), after)
    assert.equal(await sourceCount(), 1)
    assert.equal(h.hints.length, beforeHints + 1)
  }
  await wait(() => h.executionOwner().pendingChecks === 0, 'All actual native checks settle before database cleanup')
  assert.equal(h.slot.binding.tokenId, originalToken.id)
  assert.notEqual(h.slot.binding.tokenId, secondToken.id)
  console.log(`TOKEN_OWNERSHIP ${JSON.stringify({ mode, sameAccount: true, distinctGenuineToken: true, alternateViews, originalEvents, originalAdmissions, sourceCount: await sourceCount(), domainWrites, nativeAfterCommitHints: h.hints.length - beforeHints, originalBindingRetained: true })}`)
  console.log(`PASS genuine same-account token cannot adopt ${mode} execution`)
}
finally {
  unhook()
  attachment?.release()
  await h.close()
}
