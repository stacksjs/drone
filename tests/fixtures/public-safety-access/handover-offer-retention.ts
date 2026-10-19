import assert from 'node:assert/strict'
import { setupHandoverFixture } from './handover-setup'
const f = await setupHandoverFixture()
try {
  const seeded = await f.seed('handover-offer-retention', 12000)
  const deadline = Date.parse(seeded.config.retention.expiresAt)
  const before = await f.snapshot(seeded.key)
  let committed = false
  f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    committed = true
    assert(Date.now() < deadline, 'New offer actually commits while incident retention is still future')
    // The real native transaction has committed. No database call occurs in this callback.
    await Bun.sleep(Math.max(1, deadline - Date.now() + 20))
  } })
  try { await assert.rejects(() => f.offer(seeded), f.status(404)) }
  finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
  assert(committed, 'The withheld new-offer receipt follows a real successful COMMIT')
  const after = await f.snapshot(seeded.key)
  assert.equal(after.incident!.version, (before.incident!.version as number) + 1)
  assert.deepEqual(after.members, before.members)
  const offers = after.audits.filter(row => row.action === 'handover-offered')
  assert.equal(offers.length, 1)
  assert.equal(offers[0]!.request_id, seeded.input.requestId)
  assert.equal(JSON.parse(offers[0]!.details_json as string).expiresAt, seeded.config.retention.expiresAt)
  await assert.rejects(() => f.as(f.senderToken, () => f.handover.readIncidentHandoverDesk(seeded.key)), f.status(404))
  await assert.rejects(() => f.as(f.recipientToken, () => f.handover.readIncidentHandoverDesk(seeded.key, { offerKey: offers[0]!.handover_key as string })), f.status(404))
  await assert.rejects(() => f.offer(seeded), f.status(404))
  assert.deepEqual(await f.snapshot(seeded.key), after)
  console.log('PASS new offer withholds receipt after actual COMMIT crosses incident retention; durable offer remains and post-expiry content is unavailable')
}
finally { await f.database.closeDatabaseConnection() }
