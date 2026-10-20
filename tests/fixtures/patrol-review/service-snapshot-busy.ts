import assert from 'node:assert/strict'
import { Database } from 'bun:sqlite'
import { openNativeFixture, intent, uuid } from './http-fixture'

async function main() {
  const context = await openNativeFixture()
  const writer = new Database(process.env.DB_DATABASE_PATH!)
  try {
    const { isInTransaction } = await import('@stacksjs/database/runtime')
    const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
    writer.exec('PRAGMA journal_mode = WAL')
    assert.equal((writer.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
    writer.exec('CREATE TABLE patrol_snapshot_probe (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)')
    writer.exec('INSERT INTO patrol_snapshot_probe VALUES (1, 0)')
    const { token } = await context.owner()
    const endpoint = '/api/patrol/reviews', path = endpoint + '/' + intent.scheduleKey
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, intent)).status, 201)
    const created = (await context.call('GET', path, token.plainTextToken)).data
    assert.equal((await context.call('POST', path + '/occurrences/1767225600000/decision', token.plainTextToken, { expectedVersion: 1, requestId: uuid(2), scopeDigest: created.occurrences[0].scopeDigest, decision: 'approve' })).status, 200)
    const baseline = (await context.call('GET', path, token.plainTextToken)).data
    let writerCommits = 0, insideWrites = 0, rollbacks = 0, writeErrors = 0, hookEnabled = true
    const identities: { isError: boolean, code: string | null, errno: number | null }[] = []
    const observe = (error: unknown) => {
      if (identities.length >= 4) return
      const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : null
      const errno = error && typeof error === 'object' ? Reflect.get(error, 'errno') : null
      identities.push({ isError: error instanceof Error, code: typeof code === 'string' && code.length <= 64 ? code : null, errno: typeof errno === 'number' && Number.isFinite(errno) ? errno : null })
    }
    const unhook = registerPersistentQueryHooks({ onQueryStart(event) {
      if (!hookEnabled || !/^UPDATE\b.*\bpatrol_review_schedules\b/is.test(event.sql)) return
      insideWrites++
      assert.equal(isInTransaction(), true)
      // The native CAS is about to execute after the transaction established its read snapshot.
      // This independent WAL writer commits synchronously before that actual CAS is dispatched.
      writer.exec('UPDATE patrol_snapshot_probe SET value = value + 1 WHERE id = 1')
      writerCommits++
    }, onQueryError(event) {
      if (/^UPDATE\b.*\bpatrol_review_schedules\b/is.test(event.sql)) { writeErrors++; observe(event.error) }
    } })
    context.database.db.primary.setTransactionDefaults({ onRollback(error) { rollbacks++; observe(error) } })
    const request = { expectedVersion: 2, requestId: uuid(3), scopeDigest: baseline.occurrences[0].scopeDigest }
    try {
      const result = await context.call('POST', path + '/occurrences/1767225600000/consume', token.plainTextToken, request)
      hookEnabled = false
      const unchanged = JSON.stringify((await context.call('GET', path, token.plainTextToken)).data) === JSON.stringify(baseline)
      const marker = (writer.query('SELECT value FROM patrol_snapshot_probe WHERE id = 1').get() as { value: number }).value
      // Closed native facts precede the response oracle, so the first failure retains the actual extended error.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ label: 'actual-native-patrol-snapshot-busy', status: result.status, insideWrites, writerCommits, marker, writeErrors, rollbacks, identities, unchanged }))
      assert.equal(insideWrites, 1)
      assert.equal(writerCommits, 1)
      assert.equal(marker, 1)
      assert.equal(writeErrors, 1)
      assert.equal(rollbacks, 1)
      assert.deepEqual(identities, [
        { isError: true, code: 'SQLITE_BUSY_SNAPSHOT', errno: 517 },
        { isError: true, code: 'SQLITE_BUSY_SNAPSHOT', errno: 517 },
      ])
      assert.equal(unchanged, true)
      assert.equal(result.status, 503)
      assert.deepEqual(result.data, { error: 'Patrol review is temporarily unavailable' })
    }
    finally {
      hookEnabled = false
      unhook()
      context.database.db.primary.setTransactionDefaults({ onRollback: undefined })
    }
    // This new explicit request is not a retry by the failed transaction or service.
    const consumed = await context.call('POST', path + '/occurrences/1767225600000/consume', token.plainTextToken, request)
    assert.equal(consumed.status, 200)
    assert.equal(consumed.data.consumedNow, true)
    assert.equal((await context.call('GET', path, token.plainTextToken)).data.scheduleVersion, 3)
    // eslint-disable-next-line no-console
    console.log('PASS actual native WAL snapshot contention refuses once and leaves the patrol ledger unchanged')
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
