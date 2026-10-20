import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { Gate } from '@stacksjs/auth/gate'
import { isInTransaction } from '@stacksjs/database/runtime'
import { registerPersistentQueryHooks } from '@stacksjs/query-builder'
import { openNativeFixture, intent, uuid } from './http-fixture'

// A real independent SQLite writer after native preflight, not an Auth or DB stand-in.
async function main() {
  const context = await openNativeFixture()
  const writer = new Database(process.env.DB_DATABASE_PATH!)
  let held = false
  try {
    const { token, userId } = await context.owner()
    const endpoint = '/api/patrol/reviews'
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, intent)).status, 201)
    const path = `${endpoint}/${intent.scheduleKey}`
    const baseline = (await context.call('GET', path, token.plainTextToken)).data
    let allowedGates = 0, writeErrors = 0, rollbacks = 0
    const identities: { isError: boolean, code: string | null, errno: number | null }[] = []
    const observe = (error: unknown) => {
      if (identities.length >= 4) return
      try {
        const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null
        const errno = error && typeof error === 'object' ? Reflect.get(error, 'errno') : null
        identities.push({ isError: error instanceof Error, code: typeof code === 'string' && code.length <= 64 ? code : null, errno: typeof errno === 'number' && Number.isFinite(errno) ? errno : null })
      }
      catch { identities.push({ isError: false, code: null, errno: null }) }
    }
    const unhook = registerPersistentQueryHooks({ onQueryError(event) {
      if (/^UPDATE\b.*\bpatrol_review_schedules\b/is.test(event.sql)) {
        writeErrors++
        observe(event.error)
      }
    } })
    context.database.db.primary.setTransactionDefaults({ onRollback(error) {
      rollbacks++
      observe(error)
    } })
    Gate.after((user, ability, allowed) => {
      if (ability !== 'patrol:approve' || held) return
      assert.equal(allowed, true)
      assert.equal(user?.id, userId)
      assert.equal(isInTransaction(), false)
      allowedGates++
      writer.exec('BEGIN IMMEDIATE')
      held = true
    })
    const approval = { expectedVersion: 1, requestId: uuid(2), scopeDigest: baseline.occurrences[0].scopeDigest, decision: 'approve' }
    try {
      const result = await context.call('POST', `${path}/occurrences/1767225600000/decision`, token.plainTextToken, approval)
      assert.equal(result.status, 503)
      assert.deepEqual(result.data, { error: 'Patrol review is temporarily unavailable' })
      assert.equal(allowedGates, 1)
      assert.equal(writeErrors, 1)
      assert.equal(rollbacks, 1)
      assert.deepEqual(identities, [
        { isError: true, code: 'SQLITE_BUSY', errno: 5 },
        { isError: true, code: 'SQLITE_BUSY', errno: 5 },
      ])
    }
    finally {
      unhook()
      context.database.db.primary.setTransactionDefaults({ onRollback: undefined })
      if (held) writer.exec('ROLLBACK')
    }
    assert.deepEqual((await context.call('GET', path, token.plainTextToken)).data, baseline)
    // A separate explicit HTTP request after unlocking, never an automatic service retry.
    assert.equal((await context.call('POST', `${path}/occurrences/1767225600000/decision`, token.plainTextToken, approval)).status, 200)
    assert.equal((await context.call('GET', path, token.plainTextToken)).data.scheduleVersion, 2)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ label: 'actual-native-patrol-cas-busy', allowedGates, writeErrors, rollbacks, identities, refusalStatus: 503 }))
    // eslint-disable-next-line no-console
    console.log('PASS actual patrol CAS writer contention refuses once with native busy503 and rolls back unchanged')
  }
  finally {
    writer.close()
    await context.close()
  }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
