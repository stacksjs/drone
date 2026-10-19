/* eslint-disable ts/no-top-level-await, no-console */
// Actual native incarnation replacement at the first genuine observer callback.
import assert from 'node:assert/strict'
import { setupIncarnationExecution } from './execution-incarnation-setup'

const h = await setupIncarnationExecution('credit')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let afterActor: ReturnType<typeof h.replace> | undefined
try {
  let callbacks = 0
  attachment = await h.f.as(h.f.recipientToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, h.locator, async value => {
      callbacks++
      assert.equal(value.latestEvent?.sequence, 1)
      afterActor = h.replace()
      await h.currentEligibility()
      assert.equal(h.slot.phase, 'running', 'Earlier heartbeat refusal cannot stand in for post-callback scope refusal')
    })
  })
  await attachment.activate()
  await h.waitProducer()
  assert(afterActor)
  assert.equal(callbacks, 1)
  assert.equal(h.slot.reason, 'authority-unavailable')
  assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.emitted), 1)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
  assert.equal(h.slot.recording, null)
  assert.equal(h.slot.completion, null)
  await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), h.scopeConflict)
  h.unchanged(afterActor)
  console.log('INCARNATION_AUTHORITY {"phase":"credit","nativeIncidentAndMembersReplaced":true,"sameCas":true,"credit":0,"emitted":1,"returned":0,"refusal":"native-workspace-scope409","privateBindingComparisonClaim":false,"sourceCount":0}')
  console.log('PASS native incident incarnation blocks genuine post-observer producer credit')
}
finally {
  attachment?.release()
  await h.close()
}
