/* eslint-disable ts/no-top-level-await, no-console */
// Real sole writer; independent SQLite is only the existing fixture adversary/oracle.
import assert from 'node:assert/strict'
import { setupIncarnationExecution } from './execution-incarnation-setup'

const h = await setupIncarnationExecution('admit')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { isInTransaction } = await import('@stacksjs/database/runtime')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let unhook: (() => void) | undefined
try {
  attachment = await h.f.as(h.f.recipientToken, async () => {
    const subscriber = h.core.captureExecutionContext(h.key)
    return h.core.attachIncidentExecution(subscriber, h.locator, () => {})
  })
  await attachment.activate()
  const until = Date.parse(h.started.availableUntil) + 5000
  while (['waiting-for-consumer', 'running'].includes(h.slot.phase) && Date.now() < until) await Bun.sleep(20)
  assert.equal(h.slot.phase, 'completed')
  assert.equal(h.slot.producer, 'finished')
  attachment.release()
  const completed = await h.core.readIncidentExecution(h.context, { scope: h.scope })
  assert(completed?.completion)
  const before = await h.f.snapshot(h.key)
  assert.equal(before.incident!.version, 2)
  const recording = h.slot.recording
  assert(recording)
  let changed = 0, mutationIncidentReads = 0, mutationMemberReads = 0, loneCreatedAtReads = 0, executionWrites = 0
  let initialAuthorityCommits = 0, postActorCommits = 0, postActorRollbacks = 0, rollbackStatus: number | null = null
  let actorError: unknown, afterActor: ReturnType<typeof h.replace> | undefined
  const order: string[] = [], preflightFrames: string[] = [], rollbackFrames: string[] = []
  h.f.database.db.primary.setTransactionDefaults({
    afterCommit: () => {
      if (changed) {
        postActorCommits++
        order.push('post-actor-native-commit')
      }
      else {
        initialAuthorityCommits++
        order.push('initial-native-authority-commit')
      }
    },
    onRollback: error => {
      if (!changed) return
      postActorRollbacks++
      rollbackStatus = error instanceof h.f.access.PublicSafetyAccessError ? error.status : null
      order.push('post-actor-native-rollback')
      if (error instanceof Error) {
        for (const line of (error.stack ?? '').split('\n')) {
          if (line.includes('/resources/functions/drone/public-safety/')) rollbackFrames.push(line.trim())
        }
      }
    },
  })
  unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (!changed && !isInTransaction() && sql.startsWith('select') && sql.includes('from public_safety_incident_members')) {
      changed++
      order.push('outside-transaction-preflight-members')
      try {
        assert.equal(initialAuthorityCommits, 1, 'Initial core authority committed before the actual source registration preflight')
        for (const line of (new Error('Native incarnation preflight query origin').stack ?? '').split('\n')) {
          if (line.includes('/resources/functions/drone/public-safety/')) preflightFrames.push(line.trim())
        }
        afterActor = h.replace()
        order.push('native-row-replacement-complete')
      }
      catch (error) { actorError = error }
      return
    }
    if (!changed || !isInTransaction()) return
    if (/^(?:insert|update|delete)\b/.test(sql)) {
      executionWrites++
      order.push('unexpected-mutation-write')
    }
    if (sql.startsWith('select') && sql.includes('from public_safety_incidents')) {
      mutationIncidentReads++
      order.push('mutation-incident-read')
      if (/^select (?:[a-z_]+\.)?created_at from public_safety_incidents\b/.test(sql)) loneCreatedAtReads++
    }
    if (sql.startsWith('select') && sql.includes('from public_safety_incident_members')) {
      mutationMemberReads++
      order.push('mutation-member-read')
    }
  } })
  await assert.rejects(() => h.f.as(h.f.recipientToken, async () => {
    const caller = h.core.captureExecutionContext(h.key)
    return h.core.admitIncidentExecution(caller, { ...h.locator, digest: completed.completion!.digest, expectedVersion: 2 })
  }), h.scopeConflict)
  unhook()
  unhook = undefined
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  if (actorError) throw actorError
  console.log(`INCARNATION_ADMISSION_NATIVE_ORDER ${JSON.stringify({ initialAuthorityCommits, postActorCommits, postActorRollbacks, rollbackStatus, order, preflightFrames, rollbackFrames, mutationIncidentReads, mutationMemberReads })}`)
  assert.equal(changed, 1)
  assert.equal(initialAuthorityCommits, 1)
  assert.equal(postActorCommits, 0)
  assert.equal(postActorRollbacks, 1, 'An earlier preflight scope refusal without an actual mutation rollback does not qualify this race')
  assert.equal(rollbackStatus, 409)
  assert(rollbackFrames.some(frame => frame.includes('/access/mutations.ts:')), 'The actual sole source mutation callback rolled back')
  assert(rollbackFrames.some(frame => frame.includes('/execution/policy.ts:')), 'The checked callback reached actual executionAccess')
  assert(rollbackFrames.some(frame => frame.includes('/workspace/policy.ts:')), 'The original workspace scope refused on the actual mutation handle')
  assert(afterActor)
  assert.equal(afterActor.snapshot.incident.version, 2, 'Actual native CAS was preserved through full row replacement')
  assert(mutationIncidentReads > 0)
  assert(mutationMemberReads > 0)
  // These positive QB reads supplement lifecycle/stack evidence. Native raw lock
  // and token lookups are not covered by these hooks and are never inferred absent.
  assert.equal(loneCreatedAtReads, 0, 'Workspace scope refuses before executionAccess reaches its lone created_at SELECT; this does not mean the checked callback was absent')
  assert.equal(executionWrites, 0)
  assert.equal(h.slot.admission, 'unsubmitted')
  assert.equal(h.slot.reason, null)
  assert.equal(h.slot.recording, recording, 'A pre-write scope refusal does not erase its completed candidate')
  await h.currentEligibility()
  h.unchanged(afterActor)
  console.log(`INCARNATION_AUTHORITY ${JSON.stringify({ phase: 'admit', nativeIncidentAndMembersReplaced: true, incidentCasBefore: before.incident!.version, incidentCasAfter: afterActor.snapshot.incident.version, outsideTransactionAdversary: changed, initialAuthorityCommits, postActorRollbacks, rollbackStatus, mutationIncidentReads, mutationMemberReads, rawLockAndTokenReadsCoveredByQueryHooks: false, loneCreatedAtReads, privateBindingComparisonClaim: false, order, executionWrites, admission: h.slot.admission, refusal: 'actual-sole-writer-native-workspace-scope409', sourceCount: 0 })}`)
  console.log('PASS native incident incarnation refuses actual source admission with preserved CAS')
}
finally {
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  unhook?.()
  attachment?.release()
  await h.close()
}
