/* eslint-disable ts/no-top-level-await, no-console */
// Controlled scheduling of genuine result/ACK FIFO, with the unchanged validator.
import assert from 'node:assert/strict'
import { setupTokenRowExecution } from './execution-token-row-setup'

const h = await setupTokenRowExecution('result')
assert(h.slot.worker)
const worker = h.slot.worker, observe = worker.onmessage
assert(observe)
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let actor: Promise<void> | undefined, actorError: unknown
let holding = false, resultSeen = false, resultMs = 0, completedViews = 0
const pending: MessageEvent[] = []
const flush = () => {
  holding = false
  for (const event of pending.splice(0)) observe.call(worker, event)
}
try {
  const before = await h.f.snapshot(h.key), hints = h.hints.length
  worker.onmessage = event => {
    if (holding) { pending.push(event); return }
    if (event.data?.kind !== 'result') { observe.call(worker, event); return }
    resultSeen = true
    const at = performance.now()
    observe.call(worker, event)
    resultMs = performance.now() - at
    holding = true
    actor = (async () => {
      assert(h.slot.candidate, 'The actual full canonical production handler accepted these genuine bytes')
      assert.equal(h.slot.finishedAck, false)
      assert.equal(h.slot.phase, 'running')
      h.replace()
      await h.currentEligibility()
      assert.equal(h.slot.phase, 'running', 'An earlier authority heartbeat refusal cannot stand in for final result checking')
      assert.equal(h.slot.finishedAck, false, 'No genuine ACK was forwarded early or fabricated')
      flush()
    })().catch(error => { actorError = error; flush() })
  }
  attachment = await h.f.as(h.f.recipientToken, () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), h.locator, value => {
    if (value.phase === 'completed' || value.completion) completedViews++
  }))
  await attachment.activate()
  const until = Date.parse(h.started.availableUntil) + 5000
  while (h.slot.producer === 'pending' && !actorError && Date.now() < until) await Bun.sleep(20)
  if (actor) await actor
  if (actorError) throw actorError
  assert(resultSeen)
  await h.waitProducer()
  assert.equal(h.slot.finishedAck, true)
  assert.equal(h.slot.phase, 'canceled')
  assert.equal(h.slot.reason, 'authority-unavailable')
  assert.equal(completedViews, 0)
  assert.equal(h.slot.candidate, null)
  assert.equal(h.slot.recording, null)
  assert.equal(h.slot.completion, null)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), Atomics.load(h.slot.control, h.executionWords.emitted))
  await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), h.bindingConflict)
  await h.assertUnchanged(before, hints)
  console.log(`TOKEN_ROW ${JSON.stringify({ phase: 'result', sqlRowIncarnation: true, nativeNewIdResolved: true, currentEligibilityAllowed: true, realCanonicalResultMs: resultMs, genuineFinishedAck: h.slot.finishedAck, controlledGenuineMessageFifo: true, completedViews, originalBindingRetained: true, sourceCount: 0, schema: h.schemaEvidence })}`)
  console.log('PASS native token row incarnation refuses canonical execution result')
}
finally {
  if (actor) await actor
  attachment?.release()
  flush()
  await h.close()
}
