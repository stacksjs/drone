/* eslint-disable ts/no-top-level-await, no-console */
import assert from 'node:assert/strict'
import { setupTokenRowExecution } from './execution-token-row-setup'

const h = await setupTokenRowExecution('credit')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let actor: Promise<void> | undefined
try {
  const before = await h.f.snapshot(h.key), hints = h.hints.length
  let callbacks = 0
  attachment = await h.f.as(h.f.recipientToken, () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), h.locator, async value => {
    callbacks++
    assert.equal(value.latestEvent?.sequence, 1)
    actor = (async () => {
      h.replace()
      await h.currentEligibility()
      assert.equal(h.slot.phase, 'running', 'Actual current eligibility and replacement finish before the observer returns')
    })()
    await actor
  }))
  await attachment.activate()
  await h.waitProducer()
  assert(actor)
  await actor
  assert.equal(callbacks, 1)
  assert.equal(h.slot.producer, 'finished')
  assert.equal(h.slot.phase, 'canceled')
  assert.equal(h.slot.reason, 'authority-unavailable')
  assert.equal(Atomics.load(h.slot.control, h.executionWords.emitted), 1)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
  await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), h.bindingConflict)
  assert.equal(h.slot.candidate, null)
  assert.equal(h.slot.recording, null)
  assert.equal(h.slot.completion, null)
  await h.assertUnchanged(before, hints)
  console.log(`TOKEN_ROW ${JSON.stringify({ phase: 'credit', sqlRowIncarnation: true, nativeNewIdResolved: true, currentEligibilityAllowed: true, credit: 0, emitted: 1, returned: 0, originalBindingRetained: true, sourceCount: 0, schema: h.schemaEvidence })}`)
  console.log('PASS native token row incarnation refuses post-observer execution credit')
}
finally {
  if (actor) await actor.catch(() => {})
  attachment?.release()
  await h.close()
}
