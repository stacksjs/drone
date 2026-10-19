import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { ExecutionView } from '../../../resources/functions/drone/public-safety/execution/types'
import { setupMemberExecution } from './execution-member-setup'

/** Supplemental message faults retain the actual native controller and production Worker. */
export async function setupProtocolExecution(mode: string) {
  const h = await setupMemberExecution(`protocol-${mode}`)
  const before = await h.f.snapshot(h.key), beforeHints = h.hints.length
  assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  const slot = h.slot as typeof h.slot & { lastSequence: number, processing: boolean, resultSeen: boolean }
  assert(slot.worker)
  const worker = slot.worker, original = worker.onmessage
  assert(original)
  let finishedMessages = 0, terminationRequests = 0, completedViews = 0, eventViews = 0
  const originalError = worker.onerror
  worker.onerror = event => {
    // Retain the actual Worker error payload and delegate the unchanged event.
    // eslint-disable-next-line no-console
    console.error('EXECUTION_PROTOCOL_WORKER_ERROR', JSON.stringify({ message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno, error: String(event.error), stack: event.error instanceof Error ? event.error.stack : null, ownProperties: Object.getOwnPropertyNames(event) }))
    return originalError?.call(worker, event)
  }
  const terminate = worker.terminate.bind(worker)
  worker.terminate = () => { terminationRequests++; return terminate() }
  const receive = (event: MessageEvent) => {
    if (event.data?.kind === 'finished') finishedMessages++
  }
  const deliver = (data: unknown) => original.call(worker, { data } as MessageEvent)
  const forward = (event: MessageEvent) => original.call(worker, event)
  const observer = (value: ExecutionView) => {
    if (value.phase === 'completed' || value.completion) completedViews++
    if (value.latestEvent) eventViews++
  }
  const wait = async (predicate: () => boolean, description: string, timeoutMs = 8000) => {
    const until = Date.now() + timeoutMs
    while (!predicate() && Date.now() < until) await Bun.sleep(10)
    assert(predicate(), description)
  }
  const settle = async () => {
    await wait(() => h.executionOwner().pendingChecks === 0, 'Actual native checks settle before inspecting final state')
  }
  const unchanged = async () => {
    assert.equal(completedViews, 0)
    assert.equal(slot.candidate, null)
    assert.equal(slot.completion, null)
    assert.equal(slot.recording, null)
    assert.equal(slot.admission, 'unsubmitted')
    await assert.rejects(() => h.core.admitIncidentExecution(h.context, { ...h.locator, digest: '0'.repeat(64), expectedVersion: before.incident!.version as number }), h.f.status(409))
    await settle()
    assert.deepEqual(await h.f.snapshot(h.key), before, 'Execution faults do not change incident version, members or audit rows')
    assert.equal(h.hints.length, beforeHints)
    assert.equal((await h.f.as(h.f.senderToken, () => h.f.records.listPublicSafetySources(h.key))).entries.length, 0)
  }
  const assertQuarantined = async () => {
    assert.equal(slot.producer, 'unconfirmed')
    assert.equal(slot.reason, 'stop-unconfirmed')
    assert.equal(slot.finishedAck, false)
    assert(terminationRequests > 0, 'Real controller requested termination of the actual Worker')
    assert.equal((await h.core.closeIncidentExecution(h.context, h.locator)).producer, 'unconfirmed')
    assert.equal(h.executionOwner().slot, slot, 'Ordinary close cannot free an unconfirmed reservation')
    await assert.rejects(() => h.core.startIncidentExecution(h.context, { intent: randomUUID(), scope: h.scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url)), h.f.status(409))
  }
  return { ...h, slot, worker, receive, deliver, forward, observer, wait, settle, unchanged, assertQuarantined, counts: () => ({ finishedMessages, terminationRequests, completedViews, eventViews }) }
}
