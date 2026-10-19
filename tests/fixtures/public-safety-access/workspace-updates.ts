import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const { createBroadcastHub, setServer } = await import('@stacksjs/realtime/server-instance')
const { setReplayBuffer, debugSnapshot } = await import('@stacksjs/realtime/replay-buffer')
const { workspaceRefreshChannel } = await import('../../../resources/functions/drone/public-safety/workspace/updates')
const hub = createBroadcastHub()
const hints: Array<{ channel: string, event: string, data: unknown }> = []
const remove = hub.addBroadcastHook(({ channel, event, data }) => { hints.push({ channel, event, data: structuredClone(data) }) })
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
try {
  const seeded = await f.seed('workspace-hints')
  assert.equal(hints.length, 4, 'Create, both memberships and source each publish only their committed change')
  const incident = (await f.snapshot(seeded.key)).incident!
  const channel = workspaceRefreshChannel(incident.id as number)
  assert(hints.every(hint => hint.channel === channel && hint.event === 'refresh'))
  assert(hints.every(hint => JSON.stringify(hint.data) === '{"refresh":true}'))
  const capture = seeded.run.survey.captures[0]!, support = seeded.run.captures[0]!.support.findIndex(value => value === 1)
  const append = () => f.as(f.senderToken, async () => {
    const current = await f.access.readPublicSafetyIncident(seeded.key)
    return f.records.appendPublicSafetyObservation(seeded.key, { expectedVersion: current.version, sourceDigest: seeded.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'Commit-qualified workspace observation', uncertaintyNote: 'Original uncertain synthetic observation' })
  })
  const before = hints.length
  writer.exec(`CREATE TRIGGER reject_workspace_audit BEFORE INSERT ON public_safety_audits WHEN NEW.incident_id = ${incident.id} BEGIN SELECT RAISE(ABORT, 'workspace audit failure'); END`)
  try { await assert.rejects(append, /workspace audit failure/); assert.equal(hints.length, before) }
  finally { writer.exec('DROP TRIGGER reject_workspace_audit') }
  const observation = await append(); assert.equal(hints.length, before + 1)
  await f.as(f.recipientToken, () => f.records.appendPublicSafetyReview(seeded.key, observation.observation.id, { expectedVersion: observation.incident.version, sourceDigest: seeded.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Human review' }))
  assert.equal(hints.length, before + 2)
  const offered = await f.offer(seeded), afterOffer = hints.length
  assert.equal(afterOffer, before + 3)
  assert.equal((await f.offer(seeded)).replayed, true); assert.equal(hints.length, afterOffer)
  const decision = f.decision(offered)
  await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, decision))
  assert.equal(hints.length, afterOffer + 1, 'Acceptance manual pointer CAS publishes exactly once')
  await f.as(f.recipientToken, () => f.handover.decideIncidentHandover(seeded.key, decision))
  assert.equal(hints.length, afterOffer + 1)

  for (const pattern of ['*', channel, `${channel.slice(0, channel.lastIndexOf('.'))}.*`]) {
    setReplayBuffer({ channels: [pattern] })
    const count: number = hints.length
    await f.as(f.recipientToken, async () => {
      const current = await f.access.readPublicSafetyIncident(seeded.key)
      await f.access.changePublicSafetyMembership(seeded.key, { expectedVersion: current.version, userId: f.unrelated.id, role: 'observer' })
    })
    assert.equal(hints.length, count, 'A matching native replay configuration prevents hint publication')
    assert.deepEqual(debugSnapshot(), {})
  }
  setReplayBuffer({ channels: ['unrelated.*'] })
  const count = hints.length
  await append(); assert.equal(hints.length, count + 1)
  assert.deepEqual(debugSnapshot(), {})
  setReplayBuffer(null)
  const throwing = hub.addBroadcastHook(() => { throw new Error('broadcast listener failure after committed SQL') })
  try { await append() }
  finally { throwing() }
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetyObservations(seeded.key))).entries.length, 3, 'A broadcaster failure cannot undo committed SQL or change its success outcome')

  const expiring = await f.seed('workspace-withheld-hint', 8000)
  const expiringId = (await f.snapshot(expiring.key)).incident!.id as number
  const deadline = Date.parse(expiring.config.retention.expiresAt)
  let actualCommit = false
  f.database.db.primary.setTransactionDefaults({ afterCommit: async () => {
    actualCommit = true
    assert(Date.now() < deadline, 'Real SQL COMMIT must finish before expiry')
    await Bun.sleep(Math.max(1, deadline - Date.now() + 20))
  } })
  const countBeforeWithheld = hints.length
  try {
    await assert.rejects(() => f.as(f.senderToken, () => f.access.changePublicSafetyMembership(expiring.key, { expectedVersion: 4, userId: f.unrelated.id, role: 'reviewer' })), f.status(404))
  }
  finally { f.database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
  assert(actualCommit)
  assert.equal(hints.length, countBeforeWithheld + 1)
  assert.equal(hints.at(-1)!.channel, workspaceRefreshChannel(expiringId))
  assert.equal((await f.snapshot(expiring.key)).incident!.version, 5, 'Response withholding does not undo the already committed mutation')
  console.log('PASS native workspace after-COMMIT hints, rollback, exact replay and replay-buffer refusal')
}
finally { remove(); setReplayBuffer(null); setServer(null); writer.close(); await f.database.closeDatabaseConnection() }
