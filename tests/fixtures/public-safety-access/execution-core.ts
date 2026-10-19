import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const f = await setupHandoverFixture()
try {
  const seeded = await f.seed('execution-native')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const beforeMessageHandler = Reflect.get(globalThis, 'onmessage')
  const workerModule = await import('../../../resources/functions/drone/public-safety/execution/worker')
  assert.equal(typeof workerModule.runPublicSafetyWorker, 'function')
  assert.equal(Reflect.get(globalThis, 'onmessage'), beforeMessageHandler, 'Ordinary parent import installs no Worker message handler')
  const core = await import('../../../resources/functions/drone/public-safety/execution/service')
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(seeded.key))).scope
  const before = await f.snapshot(seeded.key)
  await f.as(f.senderToken, async () => {
    const context = core.captureExecutionContext(seeded.key)
    assert.equal(await core.readIncidentExecution(context, { scope }), null)
  })
  await assert.rejects(() => f.as('invalid-fixture-token', () => core.readIncidentExecution(core.captureExecutionContext(seeded.key), { scope })), f.status(401))
  const readOnly = await f.credential(f.sender.id, ['public-safety:read'])
  await assert.rejects(() => f.as(readOnly, () => core.readIncidentExecution(core.captureExecutionContext(seeded.key), { scope })), f.status(403))
  assert.deepEqual(await f.snapshot(seeded.key), before)
  const workerUrl = new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url)
  await f.as(f.senderToken, async () => {
    const context = core.captureExecutionContext(seeded.key)
    const input = { intent: randomUUID(), scope, scenario: 'nominal' as const, seconds: 8 }
    const started = await core.startIncidentExecution(context, input, workerUrl)
    assert.equal(started.phase, 'waiting-for-consumer')
    assert.equal(started.producer, 'pending')
    assert.equal(started.latestEvent, null)
    await assert.rejects(() => core.startIncidentExecution(context, input, workerUrl), f.status(409))
    await Bun.sleep(100)
    const waiting = await core.readIncidentExecution(context, { scope })
    assert.equal(waiting!.phase, 'waiting-for-consumer')
    assert.equal(waiting!.latestEvent, null, 'No producer credit or publication before an activated observer')
    const closed = await core.closeIncidentExecution(context, { execution: started.execution, scope })
    assert(['stopping', 'canceled'].includes(closed.phase))
    const until = Date.now() + 5000
    let terminal = await core.readIncidentExecution(context, { scope })
    while (terminal!.producer === 'pending' && Date.now() < until) { await Bun.sleep(20); terminal = await core.readIncidentExecution(context, { scope }) }
    assert.equal(terminal!.producer, 'finished')
    assert.equal(terminal!.phase, 'canceled')
    assert.equal(terminal!.completion, null)
    assert.equal((await f.records.listPublicSafetySources(seeded.key)).entries.length, 1)
    await core.closeIncidentExecution(context, { execution: started.execution, scope })
    assert.equal(await core.readIncidentExecution(context, { scope }), null)
  })
  assert.deepEqual(await f.snapshot(seeded.key), before)
  await f.as(f.senderToken, async () => {
    const context = core.captureExecutionContext(seeded.key)
    const started = await core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 8 }, workerUrl)
    const received: import('../../../resources/functions/drone/public-safety/execution/types').ExecutionView[] = []
    const observer = await core.attachIncidentExecution(context, { execution: started.execution, scope }, value => { received.push(value) })
    await Bun.sleep(100)
    assert.equal(received.length, 0, 'Reservation alone cannot credit or emit before native observer readiness')
    assert.equal((await f.records.listPublicSafetySources(seeded.key)).entries.length, 1)
    await observer.activate()
    const until = Date.parse(started.availableUntil) + 5000
    let current = await core.readIncidentExecution(context, { scope })
    while (current!.phase !== 'completed' && !['failed', 'canceled'].includes(current!.phase) && Date.now() < until) { await Bun.sleep(20); current = await core.readIncidentExecution(context, { scope }) }
    assert.equal(current!.phase, 'completed')
    assert.equal(current!.producer, 'finished')
    assert.equal(current!.admission, 'unsubmitted')
    assert(current!.completion!.byteLength > 0)
    assert.equal(current!.completion!.eventCount, current!.latestEvent!.sequence)
    assert(received.some(value => value.latestEvent?.sequence === 1 && value.producer === 'pending'), 'A genuine first event reaches the native observer before producer completion')
    assert(received.every(value => Object.isFrozen(value) && (!value.latestEvent || Object.isFrozen(value.latestEvent))))
    assert.equal((await f.records.listPublicSafetySources(seeded.key)).entries.length, 1, 'Completion alone never registers a source')
    const registered = await core.admitIncidentExecution(context, { execution: started.execution, scope, digest: current!.completion!.digest, expectedVersion: before.incident!.version as number })
    assert.equal(registered.source.digest, current!.completion!.digest)
    assert.equal(registered.source.uploaderId, f.sender.id)
    assert.equal((await core.readIncidentExecution(context, { scope }))!.admission, 'confirmed')
    assert.equal((await f.records.listPublicSafetySources(seeded.key)).entries.length, 2)
    await assert.rejects(() => core.admitIncidentExecution(context, { execution: started.execution, scope, digest: current!.completion!.digest, expectedVersion: registered.incident.version }), f.status(409))
    observer.release(); observer.release()
    await core.closeIncidentExecution(context, { execution: started.execution, scope })
    assert.equal(await core.readIncidentExecution(context, { scope }), null)
  })
  const afterAdmission = await f.snapshot(seeded.key)
  assert.equal(afterAdmission.incident!.version, (before.incident!.version as number) + 1)
  assert.equal(afterAdmission.audits.length, before.audits.length + 1)
  console.log('PASS native execution owner-bound lifecycle and explicit admission')
}
finally { await f.database.closeDatabaseConnection() }
