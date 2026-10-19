/* eslint-disable ts/no-top-level-await, no-console */
// Actual sole-writer race; raw SQLite is only the independent owned fixture adversary/oracle.
import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { setupMemberExecution } from './execution-member-setup'

const h = await setupMemberExecution('token-admit')
const originalToken = await h.f.tokens.findToken(h.f.recipientToken)
assert(originalToken)
assert.equal(originalToken.id, h.slot.binding.tokenId)
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const { isInTransaction } = await import('@stacksjs/database/runtime')
const writer = new Database(process.env.DB_DATABASE_PATH!, { strict: true })
writer.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100;')
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
  assert.equal(h.slot.admission, 'unsubmitted')
  attachment.release()
  const completion = await h.core.readIncidentExecution(h.context, { scope: h.scope })
  assert(completion?.completion)
  const before = await h.f.snapshot(h.key)
  assert.equal(before.incident!.version, 2)
  assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  const beforeHints = h.hints.length
  let changed = 0, mutationReads = 0, observedTokenReads = 0, guardCreatedAtReads = 0, executionWrites = 0
  let initialAuthorityCommits = 0, postActorCommits = 0, postActorRollbacks = 0, rollbackStatus: number | null = null
  const order: string[] = [], rollbackFrames: string[] = [], preflightFrames: string[] = []
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
  let actorError: unknown
  unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
    const sql = event.sql.replace(/["`]/g, '').toLowerCase()
    if (!changed && !isInTransaction() && sql.startsWith('select') && sql.includes('from public_safety_incident_members')) {
      changed++
      order.push('outside-transaction-preflight-member-read')
      try {
        assert.equal(initialAuthorityCommits, 1, 'Initial core authority committed before this source registration preflight')
        for (const line of (new Error('Native preflight query origin').stack ?? '').split('\n')) {
          if (line.includes('/resources/functions/drone/public-safety/')) preflightFrames.push(line.trim())
        }
        // Existing supported native token SQL fixture, after actual preflight has
        // read its prior principal and before unchanged replay/the sole mutation.
        writer.query('UPDATE oauth_access_tokens SET revoked = 1 WHERE id = ?').run(originalToken.id)
        const token = writer.query('SELECT revoked FROM oauth_access_tokens WHERE id = ?').get(originalToken.id) as { revoked: boolean | number }
        assert.equal(token.revoked === true || token.revoked === 1, true)
        order.push('original-native-token-revoked')
      }
      catch (error) { actorError = error }
      return
    }
    if (!changed || !isInTransaction()) return
    if (/^(?:insert|update|delete)\b/.test(sql)) executionWrites++
    if (sql.startsWith('select') && sql.includes('from oauth_access_tokens')) observedTokenReads++
    if (sql.startsWith('select') && sql.includes('from public_safety_incidents')) {
      mutationReads++
      // A zero count matters here: native principal revocation must refuse before
      // the private checked execution binding guard is reachable.
      if (/^select (?:[a-z_]+\.)?created_at from public_safety_incidents\b/.test(sql)) guardCreatedAtReads++
    }
  } })
  await assert.rejects(() => h.f.as(h.f.recipientToken, async () => {
    const caller = h.core.captureExecutionContext(h.key)
    return h.core.admitIncidentExecution(caller, { ...h.locator, digest: completion.completion!.digest, expectedVersion: 2 })
  }), h.f.status(401))
  unhook()
  unhook = undefined
  if (actorError) throw actorError
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  assert.equal(changed, 1)
  console.log(`TOKEN_ADMISSION_NATIVE_ORDER ${JSON.stringify({ initialAuthorityCommits, postActorCommits, postActorRollbacks, rollbackStatus, order, preflightFrames, rollbackFrames, observedTokenReads, mutationReads })}`)
  // Native lockRow and findToken both use db.unsafe, outside persistent QB hooks.
  // Require an actual post-actor transaction rollback, not absence of observed reads.
  assert.equal(initialAuthorityCommits, 1)
  assert.equal(postActorCommits, 0)
  assert.equal(postActorRollbacks, 1, 'An earlier preflight refusal without an actual mutation transaction does not qualify this case')
  assert.equal(rollbackStatus, 401)
  assert(rollbackFrames.some(frame => frame.includes('/access/mutations.ts:')), 'The actual source mutation callback refused, not merely its outside-transaction preflight')
  assert.equal(guardCreatedAtReads, 0, 'Native principal401 refused before the private original-binding guard')
  assert.equal(executionWrites, 0, 'No actual mutation advance/insert/audit statement was issued')
  assert.equal(await h.f.tokens.findToken(h.f.recipientToken), null)
  assert.equal(h.slot.binding.tokenId, originalToken.id)
  assert.equal(h.slot.binding.memberVersion, 1)
  assert.equal(h.slot.admission, 'unsubmitted', 'A pre-write native token refusal is not an ambiguous COMMIT')
  assert.equal(h.slot.reason, null)
  assert.deepEqual(await h.f.snapshot(h.key), before, 'Token revocation did not change incident CAS, membership or audits')
  assert.equal(h.hints.length, beforeHints)
  assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  console.log(`TOKEN_AUTHORITY ${JSON.stringify({ phase: 'admit', originalTokenRevoked: true, originalBindingUnchanged: true, incidentCas: before.incident!.version, outsideTransactionAdversary: changed, initialAuthorityCommits, postActorRollbacks, rollbackStatus, observedQueryBuilderTokenReads: observedTokenReads, observedQueryBuilderIncidentReads: mutationReads, rawLockAndTokenReadsCoveredByQueryHooks: false, actualGuardCreatedAtReads: guardCreatedAtReads, executionWrites, admission: h.slot.admission, refusal: 'actual-mutation-native-principal401-before-binding-guard', sourceCount: 0 })}`)
  console.log('PASS native original token revocation refuses actual source mutation before binding guard')
}
finally {
  h.f.database.db.primary.setTransactionDefaults({ afterCommit: undefined, onRollback: undefined })
  unhook?.()
  attachment?.release()
  writer.close()
  await h.close()
}
