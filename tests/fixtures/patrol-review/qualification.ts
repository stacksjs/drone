import assert from 'node:assert/strict'
import { openNativeFixture, intent, uuid } from './http-fixture'

async function main() {
  const context = await openNativeFixture()
  try {
    const { token, userId } = await context.owner(Number.MAX_SAFE_INTEGER)
    const maximal = structuredClone(intent)
    maximal.scheduleKey = 'k'.repeat(40)
    maximal.binding.sessionId = '18446744073709551615'
    maximal.binding.bootId = '18446744073709551615'
    maximal.binding.reference = '18446744073709551615:9007199254740991,9007199254740991,9007199254740991,9007199254740991,9007199254740991'
    maximal.input.decisions[0]!.id = 'a'.repeat(40)
    maximal.input.decisions[1]!.id = 'b'.repeat(40)
    const created = await context.call('POST', '/api/patrol/reviews', token.plainTextToken, maximal)
    assert.equal(created.status, 201)
    const path = `/api/patrol/reviews/${maximal.scheduleKey}`
    let schedule = (await context.call('GET', path, token.plainTextToken)).data
    let maxReceiptBytes = Buffer.byteLength(created.text)
    for (let n = 0; n < 2; n++) {
      const occurrence = schedule.occurrences[n]
      const base = `${path}/occurrences/${occurrence.dueUtcMs}`
      const decision = { expectedVersion: n * 2 + 1, requestId: uuid(n * 2 + 2), scopeDigest: occurrence.scopeDigest, decision: 'approve' }
      const reviewed = await context.call('POST', `${base}/decision`, token.plainTextToken, decision)
      assert.equal(reviewed.status, 200)
      const consumed = await context.call('POST', `${base}/consume`, token.plainTextToken, { expectedVersion: n * 2 + 2, requestId: uuid(n * 2 + 3), scopeDigest: occurrence.scopeDigest })
      assert.equal(consumed.status, 200)
      assert.equal(consumed.data.consumedNow, true)
      maxReceiptBytes = Math.max(maxReceiptBytes, Buffer.byteLength(reviewed.text), Buffer.byteLength(consumed.text))
    }
    const read = await context.call('GET', path, token.plainTextToken)
    schedule = read.data
    assert.equal(schedule.ownerUserId, userId)
    assert.equal(schedule.scheduleVersion, 5)
    assert.equal(schedule.audit.length, 5)
    assert.equal(schedule.occurrences.length, 2)
    assert.equal(schedule.binding.reference.length, 105)
    assert.equal(Buffer.byteLength(JSON.stringify(schedule.binding)), 385)
    assert(maxReceiptBytes <= 2048)
    assert(Buffer.byteLength(read.text) <= 16384)
    for (const item of schedule.audit) assert.equal(Object.hasOwn(item, 'tokenId'), false)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ label: 'actual-maximal-patrol-projections', receiptBytes: maxReceiptBytes, getBytes: Buffer.byteLength(read.text), ownerId: userId, audits: 5, occurrences: 2 }))
    // eslint-disable-next-line no-console
    console.log('PASS bounded native maximal patrol receipt and five-audit private projection')
  }
  finally { await context.close() }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
})
