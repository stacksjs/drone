import assert from 'node:assert/strict'
import { Gate } from '@stacksjs/auth/gate'
import { isInTransaction, sqlDateTime } from '@stacksjs/database/runtime'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { makeHash } from '@stacksjs/security'
import { openNativeFixture, intent, uuid } from './http-fixture'

async function main() {
  const context = await openNativeFixture()
  try {
    const { token, userId } = await context.owner()
    const created = await context.call('POST', '/api/patrol/reviews', token.plainTextToken, intent)
    assert.equal(created.status, 201)
    const path = `/api/patrol/reviews/${intent.scheduleKey}`
    const baseline = (await context.call('GET', path, token.plainTextToken)).data
    const kind = process.env.PATROL_QUALIFICATION!
    const reviewed = await context.tokens.createToken(userId, 'revoked after allowed Gate', ['patrol:review', 'patrol:consume'], { withRefreshToken: false })
    // Native credential stamps use whole seconds. Make the old token genuinely earlier, never fake UTC.
    const newPassword = kind === 'after-password' ? await makeHash('changed-native-credential-password', { algorithm: 'bcrypt' }) : null
    if (kind === 'after-password') await Bun.sleep(1200)
    let afterCalls = 0, committed = false, transactionReads = 0, rollbacks = 0, rollbackStatus = 0
    let rollbackFrames: string[] = []
    context.database.db.primary.setTransactionDefaults({ onRollback(error) {
      if (!committed) return
      rollbacks++
      if (error instanceof Error) {
        rollbackStatus = 'status' in error && typeof error.status === 'number' ? error.status : 0
        rollbackFrames = (error.stack ?? '').split('\n').filter(frame => /navigation\/review\/(?:policy|service)\.ts:/.test(frame)).slice(0, 8)
      }
    } })
    const unhook = registerPersistentQueryHooks({ onQueryStart(event) {
      if (committed && isInTransaction() && /patrol_review_schedules/i.test(event.sql)) transactionReads++
    } })
    Gate.after(async (user, ability, allowed) => {
      if (ability !== 'patrol:approve' || afterCalls) return
      assert.equal(allowed, true)
      assert.equal(user?.id, userId)
      assert.equal(isInTransaction(), false, 'Actual successful service Gate is before the patrol mutation transaction')
      afterCalls++
      if (kind === 'after-token') await context.tokens.revokeToken(reviewed.plainTextToken)
      else if (kind === 'after-permission') await context.Rbac.revokePermission(userId, 'patrol:consume', 'web')
      else if (kind === 'after-password') {
        // Actual owned-account credential administration, native hash and native UTC stamp, no reset notification/email.
        await context.database.db.transaction(async tx => {
          await tx.updateTable('users').set({ password: newPassword!, password_changed_at: sqlDateTime(new Date()) }).where('id', '=', userId).execute()
        }, { retries: 0 })
      }
      else throw new Error('Unknown after-Gate fixture')
      committed = true
    })
    let failed
    try {
      failed = await context.call('POST', `${path}/occurrences/1767225600000/decision`, reviewed.plainTextToken, { expectedVersion: 1, requestId: uuid(2), scopeDigest: baseline.occurrences[0].scopeDigest, decision: 'approve' })
      assert.equal(failed.status, kind === 'after-permission' ? 403 : 401)
      assert.equal(afterCalls, 1)
      assert.equal(committed, true)
      assert.equal(rollbacks, 1, 'Actual patrol transaction rolled back after committed authority change')
      assert.equal(rollbackStatus, kind === 'after-permission' ? 403 : 401)
      assert(rollbackFrames.some(frame => frame.includes('/review/policy.ts:')), 'Fresh native principal refused inside the transaction')
      assert(rollbackFrames.some(frame => frame.includes('/review/service.ts:')), 'The actual patrol mutation callback was reached')
    }
    finally {
      unhook()
      context.database.db.primary.setTransactionDefaults({ onRollback: undefined })
    }
    // Password changes invalidate every preexisting token. Mint a fresh real read token; do not revive old credentials.
    const observer = kind === 'after-password' ? await context.tokens.createToken(userId, 'fresh post-change reader', ['patrol:read'], { withRefreshToken: false }) : token
    assert.deepEqual((await context.call('GET', path, observer.plainTextToken)).data, baseline)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ label: 'actual-after-Gate-authority-refusal', kind, allowedGates: afterCalls, changeCommittedBeforeTransaction: committed, observedQBScheduleReads: transactionReads, rawLockCoveredByQBHook: false, actualTransactionRollbacks: rollbacks, rollbackStatus, rollbackFrames, status: failed.status, protectedVersion: 1, auditCount: 1 }))
    // eslint-disable-next-line no-console
    console.log('PASS committed authority change after successful native Gate refuses in actual patrol transaction without protected writes')
  }
  finally { await context.close() }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
