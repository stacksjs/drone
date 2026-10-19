/* eslint-disable ts/no-top-level-await, no-console */
// Genuine direct-core ownership regression, not an asserted HTTP subscriber leak.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
const core = await import('../../../resources/functions/drone/public-safety/execution/service')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
const { examplePublicSafetyConfig } = await import('../../../resources/functions/drone/public-safety/fixtures')
const limits = (await import('../../../config/execution')).default
try {
  const config = examplePublicSafetyConfig()
  config.id = 'execution-terminal-activation'
  config.revision = 'r1'
  config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const before = await f.snapshot(config.id)
  await f.as(f.senderToken, async () => {
    const context = core.captureExecutionContext(config.id)
    const scope = (await readWorkspaceAccess(config.id)).scope
    const started = await core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
    const locator = { execution: started.execution, scope }
    let completedView = false
    const live = await core.attachIncidentExecution(context, locator, value => { if (value.phase === 'completed') completedView = true })
    await live.activate()
    const until = Date.parse(started.availableUntil) + 5000
    while (!completedView && Date.now() < until) await Bun.sleep(20)
    assert(completedView)
    live.release()
    await Bun.sleep(0)
    const completed = await core.readIncidentExecution(context, { scope })
    assert.equal(completed!.phase, 'completed')
    assert.equal(completed!.producer, 'finished')
    const retainedSlot = executionOwner().slot as { recording: string | null }
    const recording = retainedSlot.recording
    assert(recording)
    const observations: { kind: string, activationStatus: number | null, firstReplacementAttached: boolean, firstReplacementStatus: number | null, callbackCalls: number, elapsedMs: number, fallbackCleanupNeeded: boolean }[] = []
    for (const kind of ['throw', 'reject', 'timeout', 'current-check'] as const) {
      let callbackCalls = 0, finishCallback: (() => void) | undefined
      const failed = await core.attachIncidentExecution(context, locator, () => {
        callbackCalls++
        if (kind === 'throw') throw new Error('Actual terminal observer threw')
        if (kind === 'reject') return Promise.reject(new Error('Actual terminal observer rejected'))
        if (kind === 'timeout') return new Promise<void>(resolve => { finishCallback = resolve })
      })
      if (kind === 'current-check') await f.Rbac.revokePermission(f.sender.id, 'public-safety:access', 'web')
      let activationError: unknown
      const at = performance.now()
      try { await failed.activate() }
      catch (error) { activationError = error }
      finally {
        if (kind === 'current-check') await f.Rbac.givePermission(f.sender.id, 'public-safety:access', 'web')
      }
      const elapsedMs = performance.now() - at
      let replacement: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
      let firstReplacementError: unknown
      try { replacement = await core.attachIncidentExecution(context, locator, () => {}) }
      catch (error) { firstReplacementError = error }
      const firstReplacementAttached = !!replacement
      const fallbackCleanupNeeded = !replacement
      if (!replacement) {
        // RED-only cleanup after preserving the failed first attempt. This never
        // counts as automatic ownership release or a successful regression result.
        failed.release()
        replacement = await core.attachIncidentExecution(context, locator, () => {})
      }
      await replacement.activate()
      finishCallback?.()
      await Bun.sleep(0)
      failed.release()
      failed.release()
      await assert.rejects(() => failed.activate(), f.status(404))
      assert.equal((await replacement.check()).phase, 'completed', 'Old failure, late callback and idempotent release cannot remove the replacement')
      assert.equal(executionOwner().slot, retainedSlot, 'Observer failure preserves the reservation')
      assert.equal(retainedSlot.recording, recording, 'Observer failure preserves the full completed candidate')
      assert.equal((await core.readIncidentExecution(context, { scope }))!.completion!.digest, completed!.completion!.digest)
      replacement.release()
      replacement.release()
      const activationStatus = activationError instanceof f.access.PublicSafetyAccessError ? activationError.status : null
      const firstReplacementStatus = firstReplacementError instanceof f.access.PublicSafetyAccessError ? firstReplacementError.status : null
      observations.push({ kind, activationStatus, firstReplacementAttached, firstReplacementStatus, callbackCalls, elapsedMs, fallbackCleanupNeeded })
      if (kind === 'timeout') assert(elapsedMs >= limits.checkTimeoutMs, 'The real observer waited for the unchanged callback timeout')
      assert.equal(callbackCalls, kind === 'current-check' ? 0 : 1)
    }
    console.log(`TERMINAL_ACTIVATION ${JSON.stringify(observations)}`)
    assert.deepEqual(observations.map(({ kind, activationStatus, firstReplacementAttached, fallbackCleanupNeeded }) => ({ kind, activationStatus, firstReplacementAttached, fallbackCleanupNeeded })), ['throw', 'reject', 'timeout', 'current-check'].map(kind => ({ kind, activationStatus: kind === 'current-check' ? 403 : 404, firstReplacementAttached: true, fallbackCleanupNeeded: false })))
    assert.equal((await core.closeIncidentExecution(context, locator)).phase, 'discarded')
    assert.equal(await core.readIncidentExecution(context, { scope }), null)
  })
  assert.deepEqual(await f.snapshot(config.id), before)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(config.id))).entries.length, 0)
  console.log('PASS native terminal activation refuses failure and releases only its observer')
}
finally {
  const until = Date.now() + 5000
  while (executionOwner().pendingChecks && Date.now() < until) await Bun.sleep(10)
  assert.equal(executionOwner().pendingChecks, 0)
  await f.database.closeDatabaseConnection()
}
