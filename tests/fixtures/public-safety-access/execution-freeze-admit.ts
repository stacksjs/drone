/* eslint-disable ts/no-top-level-await, no-console */
// Actual native sole mutation must reread enrolled freeze before source writes.
import assert from 'node:assert/strict'
import { setupFreezeExecution } from './execution-freeze-setup'

const h = await setupFreezeExecution('admit')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { isInTransaction } = await import('@stacksjs/database/runtime')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let unhook: (() => void) | undefined
try {
  attachment = await h.f.as(h.f.recipientToken, async () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), h.locator, () => {}))
  await attachment.activate()
  const until = Date.parse(h.started.availableUntil) + 5000
  while (['waiting-for-consumer', 'running'].includes(h.slot.phase) && Date.now() < until) await Bun.sleep(20)
  assert.equal(h.slot.phase, 'completed')
  assert.equal(h.slot.producer, 'finished')
  attachment.release()
  const completed = await h.core.readIncidentExecution(h.context, { scope: h.scope })
  assert(completed?.completion)
  assert.equal((await h.f.snapshot(h.key)).incident!.version, h.expectedVersion)
  const recording = h.slot.recording; assert(recording)
  let changed = 0, freezeReads = 0, mutationMemberReads = 0, loneCreatedAtReads = 0, executionWrites = 0
  let initialAuthorityCommits = 0, postActorCommits = 0, postActorRollbacks = 0, rollbackStatus: number | null = null
  let actorError: unknown, afterActor: ReturnType<typeof h.freeze> | undefined
  const order: string[] = [], rollbackFrames: string[] = []
  h.f.database.db.primary.setTransactionDefaults({
    afterCommit: () => { if (changed) { postActorCommits++; order.push('post-actor-native-commit') } else { initialAuthorityCommits++; order.push('initial-native-authority-commit') } },
    onRollback: error => {
      if (!changed) return
      postActorRollbacks++
      rollbackStatus = error instanceof h.f.access.PublicSafetyAccessError ? error.status : null
      order.push('post-actor-native-rollback')
      if (error instanceof Error) for (const line of (error.stack ?? '').split('\n')) if (line.includes('/resources/functions/drone/public-safety/')) rollbackFrames.push(line.trim())
    },
  })
  unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (!changed && !isInTransaction() && sql.startsWith('select') && sql.includes('from public_safety_incident_members')) {
      changed++
      order.push('outside-transaction-preflight-members')
      try {
        assert.equal(initialAuthorityCommits, 1, 'Actual core authority COMMIT precedes existing source preflight')
        afterActor = h.freeze()
        order.push('only-existing-scope-freeze-state-changed')
      }
      catch (error) { actorError = error }
      return
    }
    if (!changed || !isInTransaction()) return
    if (/^(?:insert|update|delete)\b/.test(sql)) executionWrites++
    if (sql.startsWith('select') && sql.includes('from public_safety_retention_scopes')) freezeReads++
    if (sql.startsWith('select') && sql.includes('from public_safety_incident_members')) mutationMemberReads++
    if (/^select (?:[a-z_]+\.)?created_at from public_safety_incidents\b/.test(sql)) loneCreatedAtReads++
  } })
  await assert.rejects(() => h.f.as(h.f.recipientToken, async () => h.core.admitIncidentExecution(h.core.captureExecutionContext(h.key), { ...h.locator, digest: completed.completion!.digest, expectedVersion: h.expectedVersion })), h.freezeConflict)
  unhook(); unhook = undefined
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  if (actorError) throw actorError
  console.log(`FREEZE_ADMISSION_NATIVE_ORDER ${JSON.stringify({ initialAuthorityCommits, postActorCommits, postActorRollbacks, rollbackStatus, order, rollbackFrames, freezeReads, mutationMemberReads, loneCreatedAtReads, executionWrites })}`)
  assert.equal(changed, 1)
  assert.equal(initialAuthorityCommits, 1)
  assert.equal(postActorCommits, 0)
  assert.equal(postActorRollbacks, 1, 'Require actual mutation rollback, not just earlier preflight refusal')
  assert.equal(rollbackStatus, 409)
  assert(rollbackFrames.some(frame => frame.includes('requireIncidentUnfrozen') && frame.includes('/access/policy.ts:')), 'Actual current freeze policy refused')
  assert(rollbackFrames.some(frame => frame.includes('/access/mutations.ts:')), 'Actual sole mutation callback rolled back')
  assert(freezeReads > 0, 'Known native query-builder freeze-state SELECT supplements lifecycle/stack evidence')
  assert.equal(mutationMemberReads, 0, 'Freeze policy runs before the mutation member SELECT')
  assert.equal(loneCreatedAtReads, 0)
  assert.equal(executionWrites, 0)
  assert.equal(h.slot.admission, 'unsubmitted')
  assert.equal(h.slot.reason, null)
  assert.equal(h.slot.recording, recording)
  assert(afterActor)
  assert.equal(afterActor.snapshot.incident.version, h.expectedVersion)
  await h.assertCurrentFrozen()
  h.unchanged(afterActor)
  console.log(`FREEZE_AUTHORITY ${JSON.stringify({ phase: 'admit', genuinelyEnrolledFutureScope: true, incidentCas: h.expectedVersion, scopeVersion: 1, onlyFreezeStateChanged: true, outsideTransactionAdversary: changed, initialAuthorityCommits, postActorRollbacks, rollbackStatus, freezeReads, mutationMemberReads, rawLockAndTokenReadsCoveredByQueryHooks: false, checkedBindingClaim: false, acceptedPurgeWorkflowClaim: false, executionWrites, admission: h.slot.admission, refusal: 'actual-sole-mutation-native-requireIncidentUnfrozen409-before-checked-guard', sourceCount: 0 })}`)
  console.log('PASS native enrolled freeze refuses actual source admission before checked execution guard')
}
finally { h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined }); unhook?.(); attachment?.release(); await h.close() }
