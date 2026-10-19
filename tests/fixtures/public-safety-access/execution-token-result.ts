/* eslint-disable ts/no-top-level-await, no-console */
// Native token revoke API after real canonical validation; genuine ACK FIFO is controlled scheduling.
import assert from 'node:assert/strict'
import { setupMemberExecution } from './execution-member-setup'

const h = await setupMemberExecution('token-result')
const originalToken = await h.f.tokens.findToken(h.f.recipientToken)
assert(originalToken)
assert.equal(originalToken.id, h.slot.binding.tokenId)
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let actor: Promise<void> | undefined, actorError: unknown
let afterActor: { snapshot: Awaited<ReturnType<typeof h.f.snapshot>>, hints: number } | undefined
let holding = false, resultSeen = false, resultMs = 0, completedViews = 0, eventViews = 0
const pending: MessageEvent[] = []
assert(h.slot.worker)
const worker = h.slot.worker, observe = worker.onmessage
assert(observe)
const flush = () => {
  holding = false
  for (const event of pending.splice(0)) observe.call(worker, event)
}
try {
  // This wraps only actual delivery ordering. Every byte/event/ACK originates from
  // the real production Worker; the exact controller handler and validator run.
  worker.onmessage = event => {
    if (holding) {
      pending.push(event)
      return
    }
    if (event.data?.kind !== 'result') {
      observe.call(worker, event)
      return
    }
    resultSeen = true
    const at = performance.now()
    observe.call(worker, event)
    resultMs = performance.now() - at
    holding = true
    actor = (async () => {
      assert(h.slot.candidate, 'Actual full canonical validation produced a candidate')
      assert.equal(h.slot.finishedAck, false, 'No producer-finished ACK was fabricated or forwarded early')
      assert.equal(h.slot.phase, 'running')
      assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
      await h.f.tokens.revokeToken(h.f.recipientToken)
      assert.equal(await h.f.tokens.findToken(h.f.recipientToken), null, 'The supported native revoke API invalidated the original personal token')
      afterActor = { snapshot: await h.f.snapshot(h.key), hints: h.hints.length }
      assert.equal(h.slot.phase, 'running', 'An earlier heartbeat refusal cannot substitute for the fresh result authority check')
      assert.equal(h.slot.finishedAck, false)
      flush()
    })().catch(error => {
      actorError = error
      flush()
    })
  }
  attachment = await h.f.as(h.f.recipientToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, h.locator, value => {
      if (value.phase === 'completed' || value.completion) completedViews++
      if (value.latestEvent) eventViews++
    })
  })
  await attachment.activate()
  const until = Date.parse(h.started.availableUntil) + 5000
  while (h.slot.producer === 'pending' && !actorError && Date.now() < until) await Bun.sleep(20)
  if (actor) await actor
  if (actorError) throw actorError
  assert(resultSeen)
  assert(afterActor)
  await h.waitProducer()
  assert.equal(h.slot.finishedAck, true)
  assert.equal(h.slot.reason, 'authority-unavailable')
  assert.equal(h.slot.phase, 'canceled')
  assert(eventViews > 0)
  assert.equal(completedViews, 0)
  assert.equal(h.slot.candidate, null)
  assert.equal(h.slot.recording, null)
  assert.equal(h.slot.completion, null)
  await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), h.f.status(401))
  assert.equal(h.slot.binding.tokenId, originalToken.id, 'No replacement credential adopted the original run')
  assert.equal(h.slot.binding.memberVersion, 1)
  assert.deepEqual(await h.f.snapshot(h.key), afterActor.snapshot)
  assert.equal(h.hints.length, afterActor.hints)
  assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  console.log(`TOKEN_AUTHORITY ${JSON.stringify({ phase: 'result', originalTokenRevoked: true, originalBindingUnchanged: true, realCanonicalResultMs: resultMs, genuineFinishedAck: h.slot.finishedAck, completedViews, refusal: 'native-principal401-before-original-binding-guard', sourceCount: 0, controlledGenuineMessageFifo: true })}`)
  console.log('PASS native original token revocation refuses canonical result before completed acceptance')
}
finally {
  if (actor) await actor
  attachment?.release()
  flush()
  await h.close()
}
