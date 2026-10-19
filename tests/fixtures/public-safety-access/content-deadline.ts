import assert from 'node:assert/strict'
import { actor, as, seed, database, access, records, status } from './managed-context'

// Real service/Auth/SQLite release boundary. Normal wall time crosses the admitted deadline
// after actual COMMIT; this does not qualify bytes already released to a client.
const coordinator = await actor('content-deadline-coordinator')
const member = await actor('content-deadline-member')
try {
  await as(coordinator.token.plainTextToken, async () => {
    const failures: string[] = []
    for (const kind of ['incident', 'audit', 'source', 'sources', 'observation', 'observations', 'reviews', 'close', 'membership'] as const) {
      const key = `cd-${kind}`, seeded = await seed(key, 4000)
      const capture = seeded.run.survey.captures[0]!, support = seeded.run.captures[0]!.support.findIndex(value => value === 1)
      assert(support >= 0)
      const appended = await records.appendPublicSafetyObservation(key, { expectedVersion: 3, sourceDigest: seeded.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: support % capture.width, y: Math.floor(support / capture.width) }, note: 'private deadline observation', uncertaintyNote: 'explicit simulator declaration' })
      const reviewed = await records.appendPublicSafetyReview(key, appended.observation.id, { expectedVersion: 4, sourceDigest: seeded.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'private deadline review' })
      const deadline = Date.parse(seeded.config.retention.expiresAt)
      const work = {
        incident: () => access.readPublicSafetyIncident(key), audit: () => access.readPublicSafetyAudit(key),
        source: () => records.readPublicSafetySource(key, seeded.source.digest), sources: () => records.listPublicSafetySources(key),
        observation: () => records.readPublicSafetyObservation(key, appended.observation.id), observations: () => records.listPublicSafetyObservations(key),
        reviews: () => records.listPublicSafetyReviews(key, appended.observation.id),
        close: () => access.closePublicSafetyIncident(key, { expectedVersion: reviewed.incident.version }),
        membership: () => access.changePublicSafetyMembership(key, { expectedVersion: reviewed.incident.version, userId: member.user.id, role: 'observer' }),
      }[kind]
      let committed = false
      database.db.primary.setTransactionDefaults({ afterCommit: async () => {
        committed = true
        assert(Date.now() < deadline, 'Actual COMMIT must finish before the admitted content deadline')
        await Bun.sleep(Math.max(1, deadline - Date.now() + 10))
      } })
      try { await assert.rejects(work(), status(404)) }
      catch (error) { if (!committed) throw error; failures.push(kind); console.log(`FAIL actual ${kind} content returned past native COMMIT retention deadline`) }
      finally { database.db.primary.setTransactionDefaults({ afterCommit: undefined }) }
      assert(committed, 'The real transaction must have committed before its release crosses expiry')
      if (!failures.includes(kind)) console.log(`PASS actual ${kind} content refuses release after native COMMIT crosses retention`)
    }
    assert.deepEqual(failures, [], 'Content must be denied at release after actual native COMMIT')
    console.log('PASS actual incident content refuses release after native COMMIT crosses retention')
  })
}
finally { await database.closeDatabaseConnection() }
