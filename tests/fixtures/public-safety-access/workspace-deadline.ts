import assert from 'node:assert/strict'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const { readIncidentWorkspace } = await import('../../../resources/functions/drone/public-safety/workspace/service')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
try {
  const stable = await f.seed('workspace-deadline')
  const token = await f.tokens.createToken(f.sender.id, 'short workspace read', ['public-safety:read'], { expiresAt: new Date(Date.now() + 6000), withRefreshToken: false })
  const resolved = await f.tokens.findToken(token.plainTextToken); assert(resolved?.expiresAt)
  const tokenDeadline = resolved.expiresAt.getTime()
  const current = await f.as(token.plainTextToken, () => readIncidentWorkspace(stable.key))
  assert.equal(Date.parse(current.availableUntil), tokenDeadline)
  let commits = 0
  f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    if (++commits !== 2) return
    assert(Date.now() < tokenDeadline, 'Final read COMMIT precedes the actual token expiry')
    await Bun.sleep(Math.max(1, tokenDeadline - Date.now() + 20))
  } })
  try { await assert.rejects(() => f.as(token.plainTextToken, () => readIncidentWorkspace(stable.key, { sourceDigest: stable.source.digest })), f.status(404)) }
  finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
  assert.equal(commits, 2)

  const streamToken = await f.tokens.createToken(f.sender.id, 'short stream authority', ['public-safety:read'], { expiresAt: new Date(Date.now() + 1500), withRefreshToken: false })
  const streamResolved = await f.tokens.findToken(streamToken.plainTextToken); assert(streamResolved?.expiresAt)
  f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    assert(Date.now() < streamResolved.expiresAt!.getTime())
    await Bun.sleep(Math.max(1, streamResolved.expiresAt!.getTime() - Date.now() + 20))
  } })
  try { await assert.rejects(() => f.as(streamToken.plainTextToken, () => readWorkspaceAccess(stable.key)), f.status(404)) }
  finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }

  const expiring = await f.seed('workspace-incident-expiry', 8000)
  const incidentDeadline = Date.parse(expiring.config.retention.expiresAt)
  commits = 0
  f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    if (++commits !== 2) return
    assert(Date.now() < incidentDeadline)
    await Bun.sleep(Math.max(1, incidentDeadline - Date.now() + 20))
  } })
  try { await assert.rejects(() => f.as(f.senderToken, () => readIncidentWorkspace(expiring.key, { sourceDigest: expiring.source.digest })), f.status(404)) }
  finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
  assert.equal(commits, 2)
  await assert.rejects(() => f.as(f.senderToken, () => readWorkspaceAccess(expiring.key)), f.status(404))

  const pending = await f.seed('workspace-offer-expiry')
  const offered = await f.as(f.senderToken, () => f.handover.offerIncidentCoordination(pending.key, { ...pending.input, expiresInSeconds: 30 }))
  const offerDeadline = Date.parse(offered.offer.expiresAt)
  commits = 0
  f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    if (++commits !== 2) return
    assert(Date.now() < offerDeadline)
    await Bun.sleep(Math.max(1, offerDeadline - Date.now() + 20))
  } })
  try { await assert.rejects(() => f.as(f.recipientToken, () => readIncidentWorkspace(pending.key)), f.status(404)) }
  finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
  assert.equal(commits, 2)
  const expired = await f.as(f.recipientToken, () => readIncidentWorkspace(pending.key))
  assert.equal(expired.handover.offer, null)
  assert.equal(expired.handover.briefing, null)
  assert(!Object.values(expired.handover.actionability).some(Boolean))
  console.log('PASS native workspace actual token, incident and offer COMMIT expiry')
}
finally { await f.database.closeDatabaseConnection() }
