/* eslint-disable ts/no-top-level-await, no-console */
// These are explicit supplemental delivery faults at a genuine full-result boundary.
// The Worker, native authority, event credits and controller validator remain real.
import assert from 'node:assert/strict'
import { publicSafetyEvidenceLimits, publicSafetyRecordingData, validatePublicSafetyRun } from '../../../resources/functions/drone/public-safety/evidence'
import { executionDigest, parseExecutionWorkerMessage } from '../../../resources/functions/drone/public-safety/execution/protocol'
import { setupProtocolExecution } from './execution-protocol-setup'

const mode = process.argv[2]!
assert(['oversize', 'shared', 'invalid-utf8', 'noncanonical', 'premature-ack', 'late'].includes(mode))
const h = await setupProtocolExecution(mode)
let attachment: Awaited<ReturnType<typeof h.core.attachIncidentExecution>> | undefined
let heldResult: MessageEvent | undefined, holding = false, injected = false, refusalCredit = -1
let actor: Promise<void> | undefined, actorError: unknown, genuineCanonicalBytes = 0
const pending: MessageEvent[] = []
const flush = () => {
  holding = false
  for (const event of pending.splice(0)) h.forward(event)
}
const replaceBytes = (bytes: Uint8Array) => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const message = { version: 1, kind: 'result', buffer, byteLength: bytes.byteLength, digest: executionDigest(bytes) }
  assert.equal(parseExecutionWorkerMessage(message).kind, 'result', 'Mutated bytes pass the outer protocol shape and digest format')
  return message
}
try {
  h.worker.onmessage = event => {
    h.receive(event)
    if (holding) { pending.push(event); return }
    if (mode === 'premature-ack' && heldResult && event.data?.kind === 'finished') {
      assert.equal(event.data.outcome, 'completed')
      assert.equal(event.data.transferred, true)
      assert.equal(h.slot.resultSeen, false)
      assert.equal(h.slot.finishedAck, false)
      // This is the original, genuinely received ACK, deliberately reordered once.
      h.forward(event)
      assert.equal(h.slot.phase, 'stopping')
      assert.equal(h.slot.reason, 'protocol-refused')
      refusalCredit = Atomics.load(h.slot.control, h.executionWords.credit)
      h.forward(heldResult)
      assert.equal(h.slot.candidate, null)
      injected = true
      return
    }
    if (event.data?.kind !== 'result') { h.forward(event); return }
    assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
    assert.equal(h.slot.processing, false)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), h.slot.lastSequence)
    assert.equal(h.slot.lastSequence, Atomics.load(h.slot.control, h.executionWords.emitted))
    assert.equal(h.slot.resultSeen, false)
    assert.equal(h.slot.finishedAck, false)
    assert.equal(h.slot.phase, 'running')
    const original = parseExecutionWorkerMessage(event.data)
    assert.equal(original.kind, 'result')
    if (original.kind !== 'result') throw new Error('Expected genuine full result')
    const bytes = new Uint8Array(original.buffer)
    assert.equal(executionDigest(bytes), original.digest)
    const canonical = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const run = validatePublicSafetyRun(JSON.parse(canonical))
    assert.equal(publicSafetyRecordingData(run), canonical, 'The actual Worker produced a complete canonical recording before supplemental corruption')
    assert.equal(run.events.length, h.slot.lastSequence)
    genuineCanonicalBytes = bytes.byteLength
    heldResult = event
    if (mode === 'premature-ack') return
    if (mode === 'late') {
      holding = true
      actor = (async () => {
        const closed = await h.core.closeIncidentExecution(h.context, h.locator)
        assert.equal(closed.phase, 'stopping')
        assert.equal(h.slot.reason, 'stopped-by-owner')
        refusalCredit = Atomics.load(h.slot.control, h.executionWords.credit)
        h.forward(event)
        assert.equal(h.slot.resultSeen, false, 'Late genuine result cannot restore result eligibility after owner close')
        assert.equal(h.slot.candidate, null)
        injected = true
        flush()
      })().catch(error => { actorError = error; flush() })
      return
    }
    let mutation: unknown
    if (mode === 'oversize') {
      assert.equal(publicSafetyEvidenceLimits.recordingBytes, 16 * 1024 * 1024)
      const buffer = new ArrayBuffer(publicSafetyEvidenceLimits.recordingBytes + 1)
      mutation = { ...original, buffer, byteLength: buffer.byteLength, digest: executionDigest(new Uint8Array(buffer)) }
      assert.throws(() => parseExecutionWorkerMessage(mutation), /Invalid execution result/)
    }
    else if (mode === 'shared') {
      const buffer = new SharedArrayBuffer(bytes.byteLength)
      new Uint8Array(buffer).set(bytes)
      // Even a spoofed ordinary-buffer prototype must fail the intrinsic brand check.
      Object.setPrototypeOf(buffer, ArrayBuffer.prototype)
      mutation = { ...original, buffer }
      assert.throws(() => parseExecutionWorkerMessage(mutation), /Invalid execution result buffer/)
    }
    else if (mode === 'invalid-utf8') {
      const invalid = bytes.slice()
      invalid[0] = 0xFF
      assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(invalid))
      mutation = replaceBytes(invalid)
    }
    else {
      const text = ` ${canonical}`
      assert.equal(publicSafetyRecordingData(validatePublicSafetyRun(JSON.parse(text))), canonical, 'Whitespace changes canonical bytes while retaining the complete valid run')
      mutation = replaceBytes(new TextEncoder().encode(text))
    }
    h.deliver(mutation)
    assert.equal(h.slot.phase, 'stopping')
    assert.equal(h.slot.reason, 'protocol-refused')
    assert.equal(h.slot.candidate, null)
    refusalCredit = Atomics.load(h.slot.control, h.executionWords.credit)
    injected = true
  }
  attachment = await h.f.as(h.f.recipientToken, () => h.core.attachIncidentExecution(h.core.captureExecutionContext(h.key), h.locator, h.observer))
  await attachment.activate()
  await h.wait(() => injected || !!actorError, 'Genuine full result reaches the selected supplemental fault', 65000)
  if (actor) await actor
  if (actorError) throw actorError
  await h.wait(() => h.slot.producer !== 'pending', 'Genuine ACK or rejected-order stop grace settles controller classification')
  await h.settle()
  assert(genuineCanonicalBytes > 0)
  assert.equal(h.counts().finishedMessages, 1, 'Exactly one genuine ACK is observed; none are fabricated or duplicated')
  assert(h.counts().eventViews > 0)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), refusalCredit, 'Refusal cannot grant another credit')
  assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 1)
  assert.equal(h.slot.finishedAck, false)
  if (mode === 'premature-ack') {
    // Actual owned work finished, but its sole ACK violated protocol order. The
    // controller cannot accept it as a valid final handshake and keeps capacity.
    await h.assertQuarantined()
  }
  else {
    assert.equal(h.slot.producer, 'finished')
    assert.equal(h.slot.phase, mode === 'late' ? 'canceled' : 'failed')
    assert.equal(h.slot.reason, mode === 'late' ? 'stopped-by-owner' : 'protocol-refused')
  }
  await h.unchanged()
  console.log(`EXECUTION_PROTOCOL ${JSON.stringify({ mode, supplemental: true, genuineCanonicalBytes, genuineFinishedMessages: h.counts().finishedMessages, genuineAckDuplicated: false, producer: h.slot.producer, refusalCredit, completedViews: h.counts().completedViews, sourceCount: 0, terminationRequests: h.counts().terminationRequests })}`)
  console.log(`PASS supplemental execution protocol ${mode}`)
}
finally {
  if (actor) await actor
  attachment?.release()
  flush()
  await h.close()
}
