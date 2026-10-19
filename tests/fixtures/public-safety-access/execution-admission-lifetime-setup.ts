import assert from 'node:assert/strict'
import { setupHandoverFixture } from './handover-setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'

export interface AdmissionLifetimeSlot {
  admission: string, phase: string, producer: string, finishedAck: boolean,
  metadataDeadline: number, recording: string | null,
  completion: { digest: string } | null, candidate: unknown, latestEvent: unknown,
  pendingEvent: unknown, owner: unknown, subscriber: unknown,
  binding: { authorityUntil: number, retainUntil: string },
  control: Int32Array, worker: Worker | null,
}
export async function setupAdmissionLifetime(mode: string) {
  const f = await setupHandoverFixture()
  const core = await import('../../../resources/functions/drone/public-safety/execution/service')
  const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
  const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const limits = (await import('../../../config/execution')).default
  assert.equal(limits.retainedMs, 60000)
  assert.equal(limits.stopGraceMs, 2000)
  const config = examplePublicSafetyConfig()
  config.id = `execution-admit-${mode}`
  config.revision = 'r1'; config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const key = config.id
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const before = await f.snapshot(key)
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(key))).scope
  const fresh = <T>(work: (context: ReturnType<typeof core.captureExecutionContext>) => Promise<T>) => f.as(f.senderToken, () => work(core.captureExecutionContext(key)))
  const context = await fresh(async captured => captured)
  const startInput = () => ({ intent: crypto.randomUUID(), scope, scenario: 'nominal' as const, seconds: 8 })
  const workerUrl = new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url)
  const started = await core.startIncidentExecution(context, startInput(), workerUrl)
  const slot = executionOwner().slot as AdmissionLifetimeSlot
  assert(slot.worker)
  const locator = { execution: started.execution, scope }
  const wait = async (predicate: () => boolean, message: string, timeoutMs = 5000) => {
    const until = performance.now() + timeoutMs
    while (!predicate() && performance.now() < until) await Bun.sleep(20)
    assert(predicate(), message)
  }
  let attachment: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
  try {
    let last = 0
    attachment = await fresh(captured => core.attachIncidentExecution(captured, locator, value => {
      if (!value.latestEvent || value.latestEvent.sequence === last) return
      assert.equal(value.latestEvent.sequence, ++last)
    }))
    await attachment.activate()
    await wait(() => slot.phase === 'completed', 'The actual eight-second Worker must finish', 20000)
    assert.equal(slot.producer, 'finished')
    assert.equal(slot.finishedAck, true)
    assert.equal(Atomics.load(slot.control, executionWords.returned), 1)
    assert(slot.recording && slot.completion)
  }
  finally { attachment?.release() }
  const input = { ...locator, digest: slot.completion!.digest, expectedVersion: Number(before.incident!.version) }
  const untilWall = async (at: number) => {
    while (Date.now() < at) await Bun.sleep(Math.min(1000, Math.max(1, at - Date.now())))
  }
  const sourceCount = async () => (await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))).entries.length
  const unchanged = async () => {
    assert.equal(await sourceCount(), 0)
    assert.deepEqual(await f.snapshot(key), before, 'No source admission means no incident CAS or audit mutation')
  }
  await unchanged()
  const close = async () => {
    // Call only after the owned admission promise and any held genuine Gate settle.
    if (executionOwner().slot === slot) await fresh(captured => core.closeIncidentExecution(captured, locator)).catch(() => {})
    await wait(() => executionOwner().pendingChecks === 0, 'Native checks must really settle before database close')
    await f.database.closeDatabaseConnection()
  }
  return { f, core, executionOwner, limits, key, scope, context, fresh, locator, slot, input, before, wait, untilWall, sourceCount, unchanged, close, newStart: () => fresh(captured => core.startIncidentExecution(captured, startInput(), workerUrl)) }
}
