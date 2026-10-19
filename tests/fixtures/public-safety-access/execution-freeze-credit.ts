/* eslint-disable ts/no-top-level-await, no-console */
// Actual current freeze policy after a genuine first content callback.
import assert from 'node:assert/strict'
import { setupFreezeExecution } from './execution-freeze-setup'

const h = await setupFreezeExecution('credit')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let afterActor: ReturnType<typeof h.freeze> | undefined
try {
  let callbacks = 0
  attachment = await h.f.as(h.f.recipientToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, h.locator, async value => {
      callbacks++
      assert.equal(value.latestEvent?.sequence, 1)
      afterActor = h.freeze()
      await h.assertCurrentFrozen()
      assert.equal(h.slot.phase, 'running', 'Earlier heartbeat refusal cannot stand in for post-callback freeze refusal')
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
  await h.assertCurrentFrozen()
  h.unchanged(afterActor)
  console.log(`FREEZE_AUTHORITY ${JSON.stringify({ phase: 'credit', genuinelyEnrolledFutureScope: true, incidentCas: h.expectedVersion, scopeVersion: 1, onlyFreezeStateChanged: true, credit: 0, emitted: 1, returned: 0, refusal: 'native-requireIncidentUnfrozen409', checkedBindingClaim: false, acceptedPurgeWorkflowClaim: false, sourceCount: 0 })}`)
  console.log('PASS native enrolled freeze blocks genuine post-observer producer credit')
}
finally { attachment?.release(); await h.close() }
