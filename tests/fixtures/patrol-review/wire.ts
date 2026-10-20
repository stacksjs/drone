import assert from 'node:assert/strict'
import { openNativeFixture, intent, uuid } from './http-fixture'

// Real HTTP byte/media validation and SQLite rollback, not transport loss or vehicle execution.
async function main() {
  const context = await openNativeFixture()
  try {
    const { token } = await context.owner()
    const endpoint = '/api/patrol/reviews'
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, intent)).status, 201)
    const path = `${endpoint}/${intent.scheduleKey}`
    const baseline = (await context.call('GET', path, token.plainTextToken)).data
    const padded = (value: unknown, bytes: number) => {
      const text = JSON.stringify(value)
      assert(Buffer.byteLength(text) <= bytes)
      return text + ' '.repeat(bytes - Buffer.byteLength(text))
    }
    const exact = { ...intent, scheduleKey: 'wire-exact', requestId: uuid(2) }
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, padded(exact, 8192))).status, 201)
    const oversized = { ...intent, scheduleKey: 'wire-oversized', requestId: uuid(3) }
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, padded(oversized, 8193))).status, 413)
    assert.equal((await context.call('GET', `${endpoint}/wire-oversized`, token.plainTextToken)).status, 404)
    for (const media of ['text/plain', 'application/problem+json', 'application/jsonx']) {
      assert.equal((await context.call('POST', endpoint, token.plainTextToken, intent, { 'content-type': media })).status, 415)
    }
    const charset = { ...intent, scheduleKey: 'wire-charset', requestId: uuid(4) }
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, charset, { 'content-type': 'Application/JSON; charset=utf-8' })).status, 201)
    for (const invalid of ['{', '', '{"input":', 'not-json']) {
      assert.equal((await context.call('POST', endpoint, token.plainTextToken, invalid)).status, 400)
    }
    for (const invalid of [null, false, [], 1, { ...intent, ownerUserId: 1 }]) {
      assert.equal((await context.call('POST', endpoint, token.plainTextToken, invalid)).status, 422)
    }
    const multibyte = { ...intent, scheduleKey: 'wire-unicode', extra: 'é'.repeat(3000) }
    const encoded = padded(multibyte, 8192)
    assert.equal(Buffer.byteLength(encoded), 8192)
    assert(encoded.length < 8192)
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, encoded)).status, 422)
    assert.equal((await context.call('POST', endpoint, token.plainTextToken, `${encoded} `)).status, 413)
    const headers = { authorization: `Bearer ${token.plainTextToken}`, accept: 'application/json', 'content-type': 'application/json' }
    const raw = async (body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array<ArrayBuffer>>, status: number) => {
      const response = await fetch(`http://127.0.0.1:${context.server.port}${endpoint}`, { method: 'POST', headers, body })
      assert.equal(response.status, status)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      const text = await response.text()
      assert(text.endsWith('\n'))
      assert(!text.includes(token.plainTextToken))
      assert.deepEqual(Object.keys(JSON.parse(text)), ['error'])
    }
    await raw(new Uint8Array([123, 255, 125]), 400)
    const streamBytes = new TextEncoder().encode(padded(oversized, 8193))
    await raw(new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(streamBytes.slice(0, 4096))
        controller.enqueue(streamBytes.slice(4096))
        controller.close()
      },
    }), 413)
    // Fail the second child insertion after the parent and first child were written.
    await context.database.db.unsafe("CREATE TRIGGER fixture_reject_second_patrol_occurrence BEFORE INSERT ON patrol_review_occurrences WHEN NEW.due_utc_ms = 1767225660000 BEGIN SELECT RAISE(ABORT, 'fixture occurrence failure'); END")
    const refused = await context.call('POST', endpoint, token.plainTextToken, { ...intent, scheduleKey: 'wire-child-rollback', requestId: uuid(5) })
    assert.equal(refused.status, 500)
    assert.deepEqual(refused.data, { error: 'Patrol request failed' })
    await context.database.db.unsafe('DROP TRIGGER fixture_reject_second_patrol_occurrence')
    assert.equal((await context.call('GET', `${endpoint}/wire-child-rollback`, token.plainTextToken)).status, 404)
    assert.deepEqual((await context.call('GET', path, token.plainTextToken)).data, baseline)
    const { asRows } = await import('@stacksjs/database/runtime')
    for (const [table, count] of [['patrol_review_schedules', 3], ['patrol_review_occurrences', 6], ['patrol_review_audits', 3]] as const) {
      assert.equal(asRows(await context.database.db.primary.selectFrom(table).selectAll().execute()).length, count)
    }
    // eslint-disable-next-line no-console
    console.log('PASS native exact wire byte media UTF8 refusals and second occurrence rollback preserve the ledger')
  }
  finally { await context.close() }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
