import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const core = await import('../../../resources/functions/drone/public-safety/execution/service')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
try {
  const seeded = await f.seed('execution-owner-credit')
  const before = await f.snapshot(seeded.key)
  const ownerToken = await f.credential(f.sender.id)
  await f.as(ownerToken, async () => {
    const context = core.captureExecutionContext(seeded.key)
    const scope = (await readWorkspaceAccess(seeded.key)).scope
    const started = await core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
    // Private actual controls are an independent credit/producer oracle, never a DTO.
    const slot = executionOwner().slot as { control: Int32Array, producer: string }
    let callbacks = 0
    const attachment = await core.attachIncidentExecution(context, { execution: started.execution, scope }, async value => {
      callbacks++
      assert.equal(value.latestEvent?.sequence, 1)
      await f.tokens.revokeToken(ownerToken)
    })
    await attachment.activate()
    const until = Date.now() + 8000
    while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
    assert.equal(slot.producer, 'finished', 'The canceled owned producer acknowledged the end of its work')
    assert.equal(callbacks, 1)
    assert.equal(Atomics.load(slot.control, executionWords.credit), 0, 'Revocation during the observer cannot release a stale credit')
    assert.equal(Atomics.load(slot.control, executionWords.emitted), 1, 'Only the already-held genuine callback was emitted')
    assert.equal(Atomics.load(slot.control, executionWords.returned), 0)
    await assert.rejects(() => core.readIncidentExecution(context, { scope }), f.status(401))
    attachment.release()
  })
  assert.deepEqual(await f.snapshot(seeded.key), before)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(seeded.key))).entries.length, 1)
  console.log('PASS native original-owner revocation across the actual observer credit gap')
}
finally { await f.database.closeDatabaseConnection() }
