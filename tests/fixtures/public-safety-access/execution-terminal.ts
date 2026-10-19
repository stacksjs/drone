import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const core = await import('../../../resources/functions/drone/public-safety/execution/service')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
try {
  const seeded = await f.seed('execution-terminal')
  const before = await f.snapshot(seeded.key)
  await f.as(f.senderToken, async () => {
    const context = core.captureExecutionContext(seeded.key)
    const scope = (await readWorkspaceAccess(seeded.key)).scope
    const started = await core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
    let terminalCalls = 0
    const observer = await core.attachIncidentExecution(context, { execution: started.execution, scope }, value => {
      if (value.phase === 'completed') { terminalCalls++; throw new Error('Actual consumer refused terminal delivery') }
    })
    await observer.activate()
    const until = Date.parse(started.availableUntil) + 5000
    while (!terminalCalls && Date.now() < until) await Bun.sleep(20)
    assert.equal(terminalCalls, 1)
    // The failed delivery promise has settled; an unrelated later observer must be possible.
    await Bun.sleep(0)
    const current = await core.readIncidentExecution(context, { scope })
    assert.equal(current!.phase, 'completed')
    assert.equal(current!.admission, 'unsubmitted')
    assert(current!.completion)
    const replacement = await core.attachIncidentExecution(context, { execution: started.execution, scope }, () => {})
    assert.equal(replacement.initial.completion!.digest, current!.completion!.digest)
    await replacement.activate()
    observer.release(); observer.release()
    assert.equal((await replacement.check()).phase, 'completed', 'Old idempotent release cannot remove the new subscriber')
    replacement.release(); replacement.release()
    assert.equal((await core.closeIncidentExecution(context, { execution: started.execution, scope })).phase, 'discarded')
  })
  assert.deepEqual(await f.snapshot(seeded.key), before)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(seeded.key))).entries.length, 1)
  console.log('PASS native failed terminal observer cleanup preserves completed candidate')
}
finally { await f.database.closeDatabaseConnection() }
