/* eslint-disable ts/no-top-level-await, no-console */
// The actual source writer receives a new native token ID after its real preflight.
import assert from 'node:assert/strict'
import { setupTokenRowExecution } from './execution-token-row-setup'

const h = await setupTokenRowExecution('admit')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { isInTransaction } = await import('@stacksjs/database/runtime')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let unhook: (() => void) | undefined
try {
  attachment = await h.f.as(h.f.recipientToken, () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), h.locator, () => {}))
  await attachment.activate()
  const until = Date.parse(h.started.availableUntil) + 5000
  while (['waiting-for-consumer', 'running'].includes(h.slot.phase) && Date.now() < until) await Bun.sleep(20)
  assert.equal(h.slot.phase, 'completed')
  assert.equal(h.slot.producer, 'finished')
  assert.equal(h.slot.finishedAck, true)
  attachment.release()
  const completed = await h.core.readIncidentExecution(h.context, { scope: h.scope })
  assert(completed?.completion)
  const before = await h.f.snapshot(h.key), hints = h.hints.length, recording = h.slot.recording
  assert(recording)
  assert.equal(before.incident!.version, 2)
  let changed = 0, guardCreatedAtReads = 0, executionWrites = 0
  let initialAuthorityCommits = 0, postActorCommits = 0, postActorRollbacks = 0, rollbackStatus: number | null = null
  let actorError: unknown
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
      order.push('outside-transaction-final-source-preflight-member-read')
      try {
        assert.equal(initialAuthorityCommits, 1, 'The initial core authority transaction already committed')
        for (const line of (new Error('Native token-row preflight query origin').stack ?? '').split('\n')) if (line.includes('/resources/functions/drone/public-safety/')) preflightFrames.push(line.trim())
        h.replace()
        order.push('atomic-native-token-row-replacement')
      }
      catch (error) { actorError = error }
      return
    }
    if (!changed || !isInTransaction()) return
    if (/^(?:insert|update|delete)\b/.test(sql) && /\bpublic_safety_[a-z_]+\b/.test(sql)) executionWrites++
    if (/^select (?:[a-z_]+\.)?created_at from public_safety_incidents\b/.test(sql)) guardCreatedAtReads++
  } })
  await assert.rejects(() => h.f.as(h.f.recipientToken, () => h.core.admitIncidentExecution(h.core.captureExecutionContext(h.key), { ...h.locator, digest: completed.completion!.digest, expectedVersion: 2 })), h.bindingConflict)
  unhook()
  unhook = undefined
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  if (actorError) throw actorError
  assert.equal(changed, 1)
  assert.equal(initialAuthorityCommits, 1)
  assert.equal(postActorCommits, 0)
  assert.equal(postActorRollbacks, 1, 'An earlier preflight refusal without a real mutation rollback cannot qualify this case')
  assert.equal(rollbackStatus, 409)
  assert(rollbackFrames.some(frame => frame.includes('/access/mutations.ts:')))
  assert(rollbackFrames.some(frame => frame.includes('/execution/policy.ts:')))
  assert.equal(guardCreatedAtReads, 1, 'The actual checked execution binding guard reached its positive native query')
  assert.equal(executionWrites, 0)
  assert.equal(h.slot.phase, 'completed')
  assert.equal(h.slot.admission, 'unsubmitted')
  assert.equal(h.slot.reason, null)
  assert.equal(h.slot.recording, recording)
  await h.currentEligibility()
  await h.assertUnchanged(before, hints)
  console.log(`TOKEN_ROW ${JSON.stringify({ phase: 'admit', sqlRowIncarnation: true, nativeNewIdResolved: true, currentEligibilityAllowed: true, incidentCas: before.incident!.version, initialAuthorityCommits, postActorCommits, postActorRollbacks, rollbackStatus, guardCreatedAtReads, executionWrites, rawTokenAndLockReadsCoveredByQueryHooks: false, order, preflightFrames, rollbackFrames, originalBindingRetained: true, sourceCount: 0, schema: h.schemaEvidence })}`)
  console.log('PASS native token row incarnation refuses actual source admission binding guard')
}
finally {
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  unhook?.()
  attachment?.release()
  await h.close()
}
