/* eslint-disable ts/no-top-level-await, no-console */
// Standalone native child: ordered awaited boot and scalar stdout are intentional.
import assert from 'node:assert/strict'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const policy = await import('../../../resources/functions/drone/public-safety/execution/policy')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { validatePublicSafetyRun, publicSafetyRecordingData } = await import('../../../resources/functions/drone/public-safety/evidence')
const limits = (await import('../../../config/execution')).default
try {
  const seeded = await f.seed('execution-check-elapsed')
  const before = await f.snapshot(seeded.key)
  await f.as(f.senderToken, async () => {
    const context = policy.captureExecutionContext(seeded.key)
    const began = performance.now()
    let replayBegan = 0, replayFinished = 0
    let finishWork!: () => void
    const workSettled = new Promise<void>(resolve => { finishWork = resolve })
    const checked = policy.runExecutionCheck(context, async () => {
      try {
        await f.access.authorizePublicSafetyIncident(seeded.key, 'source-register')
        // Controlled native Gate/check scheduling, followed by the unchanged real validator.
        // This is an elapsed-budget regression, not an isolated replay performance bound.
        await Bun.sleep(Math.max(1, limits.checkTimeoutMs - (performance.now() - began) - 50))
        replayBegan = performance.now() - began
        assert.equal(publicSafetyRecordingData(validatePublicSafetyRun(seeded.run)), publicSafetyRecordingData(seeded.run))
        replayFinished = performance.now() - began
        console.log(JSON.stringify({ replayBeganMs: replayBegan, replayFinishedMs: replayFinished, budgetMs: limits.checkTimeoutMs }))
        return 'must-be-withheld'
      }
      finally { finishWork() }
    })
    try { await assert.rejects(() => checked, f.status(404)) }
    finally {
      await workSettled
      // Let the captured promise chain run its actual budget-release finally.
      await Bun.sleep(0)
    }
    assert(replayBegan < limits.checkTimeoutMs, `Controlled replay window was not sampled: began ${replayBegan}ms, budget ${limits.checkTimeoutMs}ms`)
    assert(replayFinished > limits.checkTimeoutMs, `Real replay crossed deadline: ${replayFinished}`)
    assert.equal(executionOwner().pendingChecks, 0, 'The underlying native/replay work actually settled')
    await policy.runExecutionCheck(context, () => f.access.authorizePublicSafetyIncident(seeded.key, 'source-register'))
  })
  assert.deepEqual(await f.snapshot(seeded.key), before)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(seeded.key))).entries.length, 1)
  console.log('PASS native execution check elapsed deadline across genuine synchronous replay')
}
finally { await f.database.closeDatabaseConnection() }
