import assert from 'node:assert/strict'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
try {
  const seeded = await f.seed('execution-native')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const core = await import('../../../resources/functions/drone/public-safety/execution/service')
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(seeded.key))).scope
  const before = await f.snapshot(seeded.key)
  await f.as(f.senderToken, async () => {
    const context = core.captureExecutionContext(seeded.key)
    assert.equal(await core.readIncidentExecution(context, { scope }), null)
  })
  await assert.rejects(() => f.as('invalid-fixture-token', () => core.readIncidentExecution(core.captureExecutionContext(seeded.key), { scope })), f.status(401))
  const readOnly = await f.credential(f.sender.id, ['public-safety:read'])
  await assert.rejects(() => f.as(readOnly, () => core.readIncidentExecution(core.captureExecutionContext(seeded.key), { scope })), f.status(403))
  assert.deepEqual(await f.snapshot(seeded.key), before)
  console.log('PASS native execution empty status requires current authority')
}
finally { await f.database.closeDatabaseConnection() }
