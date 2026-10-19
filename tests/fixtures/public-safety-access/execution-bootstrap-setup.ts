import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import type { PublicSafetyConfig } from '../../../resources/functions/drone/public-safety/types'

/** Real native preload, authority and production Worker; private fields are only oracles. */
export async function setupExecutionBootstrap(mode: string) {
  const { Auth } = await import('@stacksjs/auth/authentication')
  const { db } = await import('@stacksjs/database/runtime')
  const { getCurrentRequest } = await import('@stacksjs/router')
  const parent = Reflect.get(globalThis, '__droneExecutionBootstrapParent') as { Auth: typeof Auth, db: typeof db, getCurrentRequest: typeof getCurrentRequest, hostWorker: typeof Worker } | undefined
  assert(parent, 'A positive actual native preload must run before the fixture')
  assert.equal(parent.Auth, Auth); assert.equal(parent.db, db)
  assert.equal(parent.getCurrentRequest, getCurrentRequest)
  assert.equal(parent.hostWorker, globalThis.Worker)
  assert.equal(process.env.DRONE_EXECUTION_BOOTSTRAP_MARKER, 'nonsecret-native-parent-marker')
  const f = await setupHandoverFixture()
  const key = `execution-bootstrap-${mode}`
  await f.seed(key)
  const core = await import('../../../resources/functions/drone/public-safety/execution/service')
  const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
  const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const before = await f.snapshot(key)
  const config = JSON.parse(String(before.incident!.config_json)) as PublicSafetyConfig
  const ordinary = simulatePublicSafety({ config, scenario: 'nominal', seconds: 8 })
  const canonical = publicSafetyRecordingData(ordinary)
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(key))).scope
  type Slot = { control: Int32Array, phase: string, reason: string | null, producer: string, recording: string | null, finishedAck: boolean, worker: Worker | null }
  let context: ReturnType<typeof core.captureExecutionContext> | undefined
  let locator: { execution: string, scope: string } | undefined
  let slot: Slot | undefined
  let attachment: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
  const start = async () => {
    const value = await f.as(f.senderToken, async () => {
      context = core.captureExecutionContext(key)
      assert.equal((await Auth.user())?.id, f.sender.id)
      const request = getCurrentRequest(); assert(request)
      assert.equal(parent.getCurrentRequest(), request)
      return core.startIncidentExecution(context, { intent: crypto.randomUUID(), scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
    })
    locator = { execution: value.execution, scope }
    slot = executionOwner().slot as Slot
    assert(slot.worker)
    return { value, slot }
  }
  const complete = async () => {
    assert(slot && locator && context)
    let events = 0
    attachment = await f.as(f.senderToken, async () => {
      const subscriber = core.captureExecutionContext(key)
      return core.attachIncidentExecution(subscriber, locator!, value => {
        if (!value.latestEvent || value.latestEvent.sequence === events) return
        assert.equal(value.latestEvent.sequence, ++events)
        if (events === 1) assert.equal(Atomics.load(slot!.control, executionWords.returned), 0)
      })
    })
    await attachment.activate()
    const until = Date.now() + 20000
    while (['waiting-for-consumer', 'running', 'stopping'].includes(slot.phase) && Date.now() < until) await Bun.sleep(20)
    const value = await core.readIncidentExecution(context, { scope })
    assert.equal(value?.phase, 'completed', `Actual production result: ${slot.phase}/${slot.reason}`)
    assert.equal(value.producer, 'finished')
    assert.equal(slot.finishedAck, true)
    assert.equal(Atomics.load(slot.control, executionWords.returned), 1)
    assert.equal(value.completion!.eventCount, ordinary.events.length)
    assert.equal(events, ordinary.events.length)
    assert.equal(slot.recording, canonical, 'The complete actual production result equals ordinary canonical bytes')
    assert.equal(value.completion!.byteLength, new TextEncoder().encode(canonical).byteLength)
    assert.equal(value.completion!.digest, createHash('sha256').update(canonical, 'utf8').digest('hex'))
    assert.deepEqual(await f.snapshot(key), before, 'Actual completion performs no source/version/audit write')
    return { events, canonicalBytes: value.completion!.byteLength, digest: value.completion!.digest }
  }
  const close = async () => {
    attachment?.release()
    if (context && locator && executionOwner().slot) {
      await core.closeIncidentExecution(context, locator).catch(() => {})
      const until = Date.now() + 4000
      while (slot?.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
      if (slot?.producer === 'pending') slot.worker?.terminate()
      assert.equal(slot?.producer, 'finished', 'Actual Worker must finish owned work before fixture cleanup')
      if (executionOwner().slot) await core.closeIncidentExecution(context, locator)
    }
    const until = Date.now() + 5000
    while (executionOwner().pendingChecks && Date.now() < until) await Bun.sleep(10)
    assert.equal(executionOwner().pendingChecks, 0)
    await f.database.closeDatabaseConnection()
  }
  return { f, key, scope, core, executionOwner, readWorkspaceAccess, start, complete, close }
}
