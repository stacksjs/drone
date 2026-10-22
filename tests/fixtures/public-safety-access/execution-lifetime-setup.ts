import assert from 'node:assert/strict'
import type { FixturePhaseObserver } from './handover-setup'
import { setupHandoverFixture } from './handover-setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'

export interface LifetimeSlot {
  control: Int32Array, phase: string, reason: string | null, producer: string,
  metadataDeadline: number, owner: unknown, subscriber: unknown,
  recording: string | null, completion: unknown, latestEvent: unknown,
  candidate: unknown, pendingEvent: unknown, worker: Worker | null,
}
export async function setupExecutionLifetime(mode: string, observe?: FixturePhaseObserver) {
  const f = await setupHandoverFixture(observe)
  const core = await import('../../../resources/functions/drone/public-safety/execution/service')
  const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
  const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const limits = (await import('../../../config/execution')).default
  assert.equal(limits.retainedMs, 60000)
  assert.equal(limits.stopGraceMs, 2000)
  const key = `execution-lifetime-${mode === 'quarantine' ? 'lost-ack' : mode}`
  const config = examplePublicSafetyConfig()
  config.id = key
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const before = await f.snapshot(key)
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(key))).scope
  const context = await f.as(f.senderToken, async () => core.captureExecutionContext(key))
  const locator = (execution: string) => ({ execution, scope })
  let current: { execution: string, slot: LifetimeSlot } | undefined
  const restores = new Set<() => void>()
  const wait = async (predicate: () => boolean, message: string, timeoutMs = 5000) => {
    const until = performance.now() + timeoutMs
    while (!predicate() && performance.now() < until) await Bun.sleep(20)
    assert(predicate(), message)
  }
  const untilWall = async (at: number) => {
    while (Date.now() < at) await Bun.sleep(Math.min(1000, Math.max(1, at - Date.now())))
  }
  const start = async () => {
    const view = await core.startIncidentExecution(context, { intent: crypto.randomUUID(), scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
    const slot = executionOwner().slot as LifetimeSlot
    assert(slot.worker)
    current = { execution: view.execution, slot }
    return { view, slot, locator: locator(view.execution) }
  }
  const captureFinished = (slot: LifetimeSlot, lose: boolean) => {
    const worker = slot.worker; assert(worker)
    const delegate = worker.onmessage; assert(delegate)
    let captured: MessageEvent | undefined
    const wrapper = (event: MessageEvent) => {
      if (event.data?.kind === 'finished') { captured = event; if (lose) return }
      delegate.call(worker, event)
    }
    worker.onmessage = wrapper
    const restore = () => { if (worker.onmessage === wrapper) worker.onmessage = delegate }
    restores.add(restore)
    return { get event() { return captured }, forwardGenuine() { assert(captured); delegate.call(worker, captured) } }
  }
  const sourceZero = async () => {
    assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))).entries.length, 0)
    assert.deepEqual(await f.snapshot(key), before, 'Lifecycle alone cannot create source/version/audit writes')
  }
  const assertCleared = (slot: LifetimeSlot) => {
    for (const name of ['owner', 'subscriber', 'recording', 'completion', 'latestEvent', 'candidate', 'pendingEvent'] as const) assert.equal(slot[name], null, `${name} is released from the owned slot`)
  }
  const close = async () => {
    if (current && executionOwner().slot === current.slot && current.slot.producer !== 'unconfirmed') {
      await core.closeIncidentExecution(context, locator(current.execution)).catch(() => {})
      await wait(() => current!.slot.producer !== 'pending', 'Owned Worker must finish cleanup')
      if (current.slot.producer === 'finished' && executionOwner().slot === current.slot) await core.closeIncidentExecution(context, locator(current.execution))
    }
    for (const restore of restores) restore()
    await wait(() => executionOwner().pendingChecks === 0, 'Real native pending work must settle before database close')
    await f.database.closeDatabaseConnection()
  }
  return { f, core, executionOwner, executionWords, limits, key, scope, context, locator, start, captureFinished, sourceZero, wait, untilWall, assertCleared, close }
}
