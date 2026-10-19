import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const core = await import('../../../resources/functions/drone/public-safety/execution/service')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
try {
  const seeded = await f.seed('execution-quota')
  await f.as(f.senderToken, () => f.access.changePublicSafetyMembership(seeded.key, { expectedVersion: 4, userId: f.recipient.id, role: 'pilot' }))
  const before = await f.snapshot(seeded.key)
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(seeded.key))).scope
  const workerUrl = new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url)
  const start = (token: string, intent = randomUUID()) => f.as(token, () => core.startIncidentExecution(core.captureExecutionContext(seeded.key), { intent, scope, scenario: 'nominal', seconds: 8 }, workerUrl))
  const intent = randomUUID(), first = await start(f.senderToken, intent)
  await assert.rejects(() => start(f.senderToken, intent), f.status(409))
  await assert.rejects(() => start(f.senderToken), f.status(409))
  await assert.rejects(() => start('invalid-fixture-token'), f.status(401))
  await assert.rejects(() => start(f.unrelatedToken), f.status(403))
  await assert.rejects(() => start(f.recipientToken), f.status(429))
  assert.equal(await f.as(f.recipientToken, () => core.readIncidentExecution(core.captureExecutionContext(seeded.key), { scope })), null)
  await assert.rejects(() => f.as(f.recipientToken, () => core.closeIncidentExecution(core.captureExecutionContext(seeded.key), { execution: first.execution, scope })), f.status(404))
  const discard = (token: string, execution: string) => f.as(token, async () => {
    const context = core.captureExecutionContext(seeded.key)
    await core.closeIncidentExecution(context, { execution, scope })
    const until = Date.now() + 8000
    let current = await core.readIncidentExecution(context, { scope })
    while (current!.producer === 'pending' && Date.now() < until) { await Bun.sleep(20); current = await core.readIncidentExecution(context, { scope }) }
    assert.equal(current!.producer, 'finished')
    assert.equal((await core.closeIncidentExecution(context, { execution, scope })).phase, 'discarded')
    assert.equal(await core.readIncidentExecution(context, { scope }), null)
  })
  await discard(f.senderToken, first.execution)
  const second = await start(f.recipientToken)
  assert.notEqual(second.execution, first.execution)
  await discard(f.recipientToken, second.execution)
  assert.deepEqual(await f.snapshot(seeded.key), before)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(seeded.key))).entries.length, 1)
  console.log('PASS native two-owner finite execution quota and private refusal semantics')
}
finally { await f.database.closeDatabaseConnection() }
