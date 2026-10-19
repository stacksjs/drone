/* eslint-disable ts/no-top-level-await, no-console */
// Actual sole writer: native existing config comparison can refuse before its checked guard.
import assert from 'node:assert/strict'
import { setupConfigExecution } from './execution-config-setup'

const h = await setupConfigExecution('admit')
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
      if (changed) { postActorCommits++; order.push('post-actor-native-commit') }
      else { initialAuthorityCommits++; order.push('initial-native-authority-commit') }
    },
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
        assert.equal(initialAuthorityCommits, 1, 'Actual initial authority COMMIT precedes source registration preflight')
        for (const line of (new Error('Actual native config preflight origin').stack ?? '').split('\n')) if (line.includes('/resources/functions/drone/public-safety/')) preflightFrames.push(line.trim())
        afterActor = h.replace()
        order.push('valid-full-config-replacement-complete')
      }
      catch (error) { actorError = error }
      return
    }
    if (!changed || !isInTransaction()) return
    if (/^(?:insert|update|delete)\b/.test(sql)) { executionWrites++; order.push('unexpected-mutation-write') }
    if (sql.startsWith('select') && sql.includes('from public_safety_incidents')) {
      mutationIncidentReads++
      if (/^select (?:[a-z_]+\.)?created_at from public_safety_incidents\b/.test(sql)) loneCreatedAtReads++
    }
    if (sql.startsWith('select') && sql.includes('from public_safety_incident_members')) mutationMemberReads++
  } })
  await assert.rejects(() => h.f.as(h.f.recipientToken, async () => {
    const caller = h.core.captureExecutionContext(h.key)
    return h.core.admitIncidentExecution(caller, { ...h.locator, digest: completed.completion!.digest, expectedVersion: 2 })
  }), h.sourceConfigConflict)
  unhook(); unhook = undefined
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  if (actorError) throw actorError
  console.log(`CONFIG_ADMISSION_NATIVE_ORDER ${JSON.stringify({ initialAuthorityCommits, postActorCommits, postActorRollbacks, rollbackStatus, order, preflightFrames, rollbackFrames, mutationIncidentReads, mutationMemberReads, loneCreatedAtReads, executionWrites })}`)
  assert.equal(changed, 1)
  assert.equal(initialAuthorityCommits, 1)
  assert.equal(postActorCommits, 0)
  assert.equal(postActorRollbacks, 1, 'Require actual mutation rollback rather than earlier native preflight refusal')
  assert.equal(rollbackStatus, 422)
  assert(rollbackFrames.some(frame => frame.includes('/access/mutations.ts:')), 'The real sole source mutation callback rolled back')
  assert(rollbackFrames.some(frame => frame.includes('matchConfig') && frame.includes('/access/records.ts:')), 'The existing source/config comparison refused on the actual mutation handle')
  assert(afterActor)
  assert.equal(afterActor.snapshot.incident.version, 2, 'Full config replacement preserves the native CAS')
  assert(mutationMemberReads > 0, 'Actual native source membership was reread inside the real mutation')
  assert.equal(loneCreatedAtReads, 0, 'Existing config mismatch refuses before the later checked executionAccess created_at read')
  assert.equal(executionWrites, 0)
  assert.equal(h.slot.admission, 'unsubmitted')
  assert.equal(h.slot.reason, null)
  assert.equal(h.slot.recording, recording, 'Pre-write native config refusal is not ambiguous durable COMMIT')
  await h.currentEligibility()
  h.unchanged(afterActor)
  console.log(`CONFIG_AUTHORITY ${JSON.stringify({ phase: 'admit', validPrivacyPolygonChanged: true, sameIdentityPurposeRetentionCas: true, outsideTransactionAdversary: changed, initialAuthorityCommits, postActorRollbacks, rollbackStatus, mutationIncidentReads, mutationMemberReads, rawLockAndTokenReadsCoveredByQueryHooks: false, loneCreatedAtReads, checkedExecutionGuardClaim: false, executionWrites, admission: h.slot.admission, refusal: 'actual-sole-writer-existing-source-config-comparison422-before-checked-execution-guard', sourceCount: 0 })}`)
  console.log('PASS native full configuration refuses actual source admission before checked execution guard')
}
finally {
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  unhook?.()
  attachment?.release()
  await h.close()
}
