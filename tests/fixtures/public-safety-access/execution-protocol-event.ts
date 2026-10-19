/* eslint-disable ts/no-top-level-await, no-console */
// Artificial boundary corruption, not a naturally malformed production Worker message.
import assert from 'node:assert/strict'
import { setupProtocolExecution } from './execution-protocol-setup'

const mode = process.argv[2]!
assert(['descriptor', 'extra-field', 'sequence', 'duplicate'].includes(mode))
const h = await setupProtocolExecution(mode)
let injected = false, accessorCalls = 0, refusalCredit = -1
try {
  h.worker.onmessage = event => {
    h.receive(event)
    if (event.data?.kind !== 'event' || injected) { h.forward(event); return }
    injected = true
    assert.equal(event.data.event.sequence, 1)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
    assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
    if (mode === 'descriptor') {
      const malformed = { ...event.data.event }
      Object.defineProperty(malformed, 'sequence', { enumerable: true, get: () => { accessorCalls++; return 1 } })
      h.deliver({ ...event.data, event: malformed })
    }
    else if (mode === 'extra-field') h.deliver({ ...event.data, unexpected: true })
    else if (mode === 'sequence') h.deliver({ ...event.data, event: { ...event.data.event, sequence: 2 } })
    else {
      h.forward(event)
      // No observer exists: the first real event is still uncredited when duplicated.
      assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), 0)
      h.forward(event)
    }
    assert.equal(h.slot.phase, 'stopping')
    assert.equal(h.slot.reason, 'protocol-refused')
    refusalCredit = Atomics.load(h.slot.control, h.executionWords.credit)
  }
  await h.wait(() => h.slot.producer !== 'pending', 'Actual producer cooperatively finishes after supplemental event refusal')
  assert(injected)
  assert.equal(h.counts().finishedMessages, 1, 'One genuine cooperative ACK arrives from the actual Worker')
  assert.equal(h.slot.producer, 'finished')
  assert.equal(h.slot.phase, 'failed')
  assert.equal(h.slot.reason, 'protocol-refused')
  assert.equal(accessorCalls, 0, 'The protocol never invokes an untrusted accessor')
  assert.equal(refusalCredit, 0)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.credit), refusalCredit)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.emitted), 1)
  assert.equal(Atomics.load(h.slot.control, h.executionWords.returned), 0)
  await h.unchanged()
  console.log(`EXECUTION_PROTOCOL ${JSON.stringify({ mode, supplemental: true, genuineFinishedMessages: h.counts().finishedMessages, accessorCalls, emitted: 1, credit: refusalCredit, returned: 0, sourceCount: 0, completedViews: 0 })}`)
  console.log(`PASS supplemental execution protocol ${mode}`)
}
finally { await h.close() }
