import assert from 'node:assert/strict'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const policy = await import('../../../resources/functions/drone/public-safety/execution/policy')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { Gate } = await import('@stacksjs/auth/gate')
const { getCurrentRequest } = await import('@stacksjs/router')
const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
try {
  const seeded = await f.seed('execution-check-budget')
  const before = await f.snapshot(seeded.key)
  assert.equal(typeof policy.runExecutionCheck, 'function', 'Coarse native preflight must use the sole shared check budget')
  await f.as(f.senderToken, async () => {
    const captured = policy.captureExecutionContext(seeded.key), original = getCurrentRequest()
    let release!: () => void, entered = 0, settled = 0
    const barrier = new Promise<void>(resolve => { release = resolve })
    Gate.define('public-safety:source-register', async (user, key) => {
      assert.equal(getCurrentRequest(), original)
      entered++
      await barrier
      const allowed = await publicSafetyIncidentGate(user, key, 'source-register')
      settled++
      return allowed
    })
    const attempts = Array.from({ length: 8 }, () => policy.runExecutionCheck(captured, () => f.access.authorizePublicSafetyIncident(seeded.key, 'source-register')).then(() => null, error => error))
    const entryDeadline = Date.now() + 1500
    while (entered < 8 && Date.now() < entryDeadline) await Bun.sleep(5)
    assert.equal(entered, 8)
    assert.equal(executionOwner().pendingChecks, 8)
    await assert.rejects(() => policy.runExecutionCheck(captured, async () => {}), f.status(409))
    const timedOut = await Promise.all(attempts)
    assert(timedOut.every(f.status(404)))
    assert.equal(executionOwner().pendingChecks, 8, 'Timeout cannot release still-pending native decisions')
    assert.equal(settled, 0)
    await assert.rejects(() => policy.runExecutionCheck(captured, async () => {}), f.status(409))
    release()
    const settlementDeadline = Date.now() + 5000
    while (executionOwner().pendingChecks && Date.now() < settlementDeadline) await Bun.sleep(5)
    assert.equal(settled, 8)
    assert.equal(executionOwner().pendingChecks, 0)
    await policy.runExecutionCheck(captured, () => f.access.authorizePublicSafetyIncident(seeded.key, 'source-register'))
    assert.equal(executionOwner().pendingChecks, 0)
  })
  assert.deepEqual(await f.snapshot(seeded.key), before)
  console.log('PASS native execution preflight shared timeout and actual settlement budget')
}
finally { await f.database.closeDatabaseConnection() }
