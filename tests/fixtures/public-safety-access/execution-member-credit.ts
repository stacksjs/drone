/* eslint-disable ts/no-top-level-await, no-console */
// Ordered standalone native boot and scalar qualification output are intentional.
import assert from 'node:assert/strict'
import { setupMemberExecution } from './execution-member-setup'

const h = await setupMemberExecution('credit')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let actor: Promise<Awaited<ReturnType<typeof h.nativeABA>>> | undefined
try {
  let callbacks = 0
  attachment = await h.f.as(h.f.recipientToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, h.locator, async value => {
      callbacks++
      assert.equal(value.latestEvent?.sequence, 1)
      actor = h.nativeABA()
      await actor
      assert.equal(h.slot.phase, 'running', 'An earlier heartbeat or temporary native denial cannot stand in for post-observer generation refusal')
    })
  })
  await attachment.activate()
  await h.waitProducer()
  assert(actor)
  const afterActor = await actor
  assert.equal(callbacks, 1)
  assert.equal(h.slot.reason, 'authority-unavailable')
  assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.emitted), 1)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
  assert(h.postActorAllows() > 0, 'Current native source permission remains eligible after the same-role ABA')
  await assert.rejects(() => h.core.readIncidentExecution(h.context, { scope: h.scope }), h.bindingConflict)
  assert.equal(h.slot.binding.memberVersion, 1)
  assert.equal(h.slot.recording, null)
  assert.equal(h.slot.completion, null)
  assert.deepEqual(await h.f.snapshot(h.key), afterActor.snapshot)
  assert.equal(h.hints.length, afterActor.hints)
  assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  console.log('MEMBER_AUTHORITY {"phase":"credit","nativeSameRoleVersion":3,"originalVersion":1,"credit":0,"emitted":1,"returned":0,"refusal":"original-binding409-after-current-native-eligibility","sourceCount":0}')
  console.log('PASS native member ABA blocks genuine post-observer producer credit')
}
finally {
  if (actor) await actor.catch(() => {})
  attachment?.release()
  await h.close()
}
