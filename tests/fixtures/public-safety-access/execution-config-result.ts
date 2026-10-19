/* eslint-disable ts/no-top-level-await, no-console */
// Controlled FIFO forwards genuine Worker bytes only; full canonical validation is unchanged.
import assert from 'node:assert/strict'
import { setupConfigExecution } from './execution-config-setup'

const h = await setupConfigExecution('result')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let actor: Promise<void> | undefined, actorError: unknown
let afterActor: ReturnType<typeof h.replace> | undefined
let holding = false, resultSeen = false, resultMs = 0, completedViews = 0
const pending: MessageEvent[] = []
assert(h.slot.worker)
const worker = h.slot.worker, observe = worker.onmessage
assert(observe)
const flush = () => {
  holding = false
  for (const event of pending.splice(0)) observe.call(worker, event)
}
try {
  worker.onmessage = event => {
    if (holding) { pending.push(event); return }
    if (event.data?.kind !== 'result') { observe.call(worker, event); return }
    resultSeen = true
    const at = performance.now()
    observe.call(worker, event)
    resultMs = performance.now() - at
    holding = true
    actor = (async () => {
      assert(h.slot.candidate, 'The unchanged full canonical handler produced its actual candidate')
      assert.equal(h.slot.finishedAck, false)
      assert.equal(h.slot.phase, 'running')
      assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
      afterActor = h.replace()
      await h.currentEligibility()
      assert.equal(h.slot.phase, 'running', 'An earlier heartbeat stop is not final-result authority refusal')
      assert.equal(h.slot.finishedAck, false)
      flush()
    })().catch(error => { actorError = error; flush() })
  }
  attachment = await h.f.as(h.f.recipientToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, h.locator, value => {
      if (value.phase === 'completed' || value.completion) completedViews++
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
  assert.equal(h.slot.finishedAck, true, 'Actual finished ACK does not prove an individual OS thread join')
  assert.equal(h.slot.reason, 'authority-unavailable')
  assert.equal(h.slot.phase, 'canceled')
  assert.equal(completedViews, 0)
  assert.equal(h.slot.candidate, null)
  assert.equal(h.slot.recording, null)
  assert.equal(h.slot.completion, null)
  await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), h.scopeConflict)
  h.unchanged(afterActor)
  console.log(`CONFIG_AUTHORITY ${JSON.stringify({ phase: 'result', realCanonicalResultMs: resultMs, validPrivacyPolygonChanged: true, sameIdentityPurposeRetentionCas: true, genuineFinishedAck: h.slot.finishedAck, completedViews, refusal: 'native-full-config-workspace-scope409', privateBindingComparisonClaim: false, sourceCount: 0, controlledGenuineMessageFifo: true })}`)
  console.log('PASS native full configuration refuses canonical result before completed acceptance')
}
finally {
  if (actor) await actor
  attachment?.release()
  flush()
  await h.close()
}
