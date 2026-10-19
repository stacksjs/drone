/* eslint-disable ts/no-top-level-await, no-console */
// Supplemental BOM corruption at a genuine result boundary, not natural serializer output.
import assert from 'node:assert/strict'
import { publicSafetyRecordingData, validatePublicSafetyRun } from '../../../resources/functions/drone/public-safety/evidence'
import { executionDigest, parseExecutionWorkerMessage } from '../../../resources/functions/drone/public-safety/execution/protocol'
import { setupProtocolExecution } from './execution-protocol-setup'

const h = await setupProtocolExecution('bom')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let injected = false, originalBytes = 0, submittedBytes = 0, submittedDigest = '', refusalCredit = -1
const domainWrites: string[] = []
const unhook = registerPersistentQueryHooks({ onQueryEnd(event) {
  const sql = event.sql.replace(/["`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
  const write = /^(insert into|update|delete from) (public_safety_[a-z_]+)\b/.exec(sql)
  if (write) domainWrites.push(`${write[1]}:${write[2]}`)
} })
try {
  h.worker.onmessage = event => {
    h.receive(event)
    if (event.data?.kind !== 'result') { h.forward(event); return }
    assert.equal(injected, false)
    assert.equal(h.slot.phase, 'running')
    assert.equal(h.slot.processing, false)
    assert.equal(h.slot.finishedAck, false)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), h.slot.lastSequence)
    assert.equal(h.slot.lastSequence, Atomics.load(h.slot.control, h.executionWords.emitted))
    const original = parseExecutionWorkerMessage(event.data)
    assert.equal(original.kind, 'result')
    if (original.kind !== 'result') throw new Error('Expected genuine complete Worker result')
    const bytes = new Uint8Array(original.buffer)
    assert.equal(executionDigest(bytes), original.digest)
    const canonical = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const run = validatePublicSafetyRun(JSON.parse(canonical))
    assert.equal(publicSafetyRecordingData(run), canonical)
    assert.equal(run.events.length, h.slot.lastSequence)
    assert.equal(new TextEncoder().encode(canonical).byteLength, bytes.byteLength)
    originalBytes = bytes.byteLength
    const prefixed = new Uint8Array(bytes.byteLength + 3)
    prefixed.set([0xEF, 0xBB, 0xBF])
    prefixed.set(bytes, 3)
    const buffer = new ArrayBuffer(prefixed.byteLength)
    new Uint8Array(buffer).set(prefixed)
    submittedBytes = buffer.byteLength
    submittedDigest = executionDigest(prefixed)
    const mutation = { ...original, buffer, byteLength: submittedBytes, digest: submittedDigest }
    assert.equal(parseExecutionWorkerMessage(mutation).kind, 'result')
    refusalCredit = Atomics.load(h.slot.control, h.executionWords.credit)
    injected = true
    // Delegate the exact real controller handler. Subsequent genuine ACK is forwarded
    // once by the normal branch, even on RED when the candidate is wrongly accepted.
    h.deliver(mutation)
  }
  attachment = await h.f.as(h.f.recipientToken, () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), h.locator, h.observer))
  await attachment.activate()
  await h.wait(() => h.slot.producer !== 'pending', 'Actual producer ACK settles BOM result classification', Math.max(1, Date.parse(h.started.availableUntil) - Date.now() + 5000))
  await h.settle()
  assert(injected)
  assert.equal(h.counts().finishedMessages, 1, 'The real finished ACK is neither fabricated nor duplicated')
  const completion = h.slot.completion as { digest: string, byteLength: number } | null
  const retainedCanonicalDigest = h.slot.recording === null ? null : executionDigest(new TextEncoder().encode(h.slot.recording))
  const sourceCount = (await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length
  assert.equal(sourceCount, 0)
  assert.deepEqual(domainWrites, [])
  // Scalar-only RED diagnostic: no credential, raw plane or recording is logged.
  console.log(`EXECUTION_BOM ${JSON.stringify({ supplemental: true, originalBytes, submittedBytes, prefixBytes: submittedBytes - originalBytes, actualPhase: h.slot.phase, actualReason: h.slot.reason, actualProducer: h.slot.producer, genuineFinishedMessages: h.counts().finishedMessages, completedViews: h.counts().completedViews, completionMatchesSubmittedDigest: completion?.digest === submittedDigest, retainedCanonicalMatchesCompletionDigest: completion === null ? null : retainedCanonicalDigest === completion.digest, sourceCount, domainWrites, nativePending: h.executionOwner().pendingChecks })}`)
  assert.equal(h.slot.phase, 'failed', 'A UTF8 BOM must be refused rather than accepted as canonical result bytes')
  assert.equal(h.slot.reason, 'protocol-refused')
  assert.equal(h.slot.producer, 'finished')
  assert.equal(h.slot.finishedAck, false)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), refusalCredit)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
  assert.deepEqual(domainWrites, [])
  await h.unchanged()
  console.log('PASS supplemental BOM-prefixed genuine result is refused without admission')
}
finally {
  unhook()
  attachment?.release()
  await h.close()
}
