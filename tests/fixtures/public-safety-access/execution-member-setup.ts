import type { ExecutionBinding } from '../../../resources/functions/drone/public-safety/execution/policy'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

export interface MemberExecutionOracle {
  binding: ExecutionBinding
  control: Int32Array
  worker: Worker | null
  producer: string
  phase: string
  reason: string | null
  candidate: object | null
  recording: string | null
  completion: object | null
  finishedAck: boolean
  admission: string
}
export async function setupMemberExecution(suffix: string) {
  const f = await setupHandoverFixture()
  const core = await import('../../../resources/functions/drone/public-safety/execution/service')
  const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
  const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const { examplePublicSafetyConfig } = await import('../../../resources/functions/drone/public-safety/fixtures')
  const { requireIncidentAccess, publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
  const { Gate } = await import('@stacksjs/auth/gate')
  const { createBroadcastHub, setServer } = await import('@stacksjs/realtime/server-instance')
  const hints: unknown[] = []
  const unhookHints = createBroadcastHub().addBroadcastHook(hint => { hints.push(hint) })
  const config = examplePublicSafetyConfig()
  config.id = `execution-member-${suffix}`
  config.revision = 'r1'
  config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  const key = config.id
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  await f.as(f.senderToken, () => f.access.changePublicSafetyMembership(key, { expectedVersion: 1, userId: f.recipient.id, role: 'pilot' }))
  const original = await f.as(f.recipientToken, () => requireIncidentAccess(key, 'source-register'))
  assert.equal(original.member.version, 1)
  const scope = (await f.as(f.recipientToken, () => readWorkspaceAccess(key))).scope
  let context!: ReturnType<typeof core.captureExecutionContext>
  const started = await f.as(f.recipientToken, async () => {
    context = core.captureExecutionContext(key)
    return core.startIncidentExecution(context, { intent: randomUUID(), scope, scenario: 'nominal', seconds: 8 }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
  })
  const locator = { execution: started.execution, scope }
  const slot = executionOwner().slot as MemberExecutionOracle
  let actorFinished = false, postActorAllows = 0
  Gate.define('public-safety:source-register', async (user, incident) => {
    const allowed = await publicSafetyIncidentGate(user, incident, 'source-register')
    if (actorFinished && allowed) postActorAllows++
    return allowed
  })
  const nativeABA = async () => {
    await f.as(f.senderToken, () => f.access.changePublicSafetyMembership(key, { expectedVersion: 2, userId: f.recipient.id, role: null }))
    await f.as(f.senderToken, () => f.access.changePublicSafetyMembership(key, { expectedVersion: 3, userId: f.recipient.id, role: 'pilot' }))
    actorFinished = true
    const current = await f.as(f.recipientToken, () => requireIncidentAccess(key, 'source-register'))
    assert.equal(current.member.id, original.member.id)
    assert.equal(current.member.role, original.member.role)
    assert.equal(current.member.active === true || current.member.active === 1, true)
    assert.equal(current.member.version, original.member.version + 2)
    assert.equal((await f.as(f.recipientToken, () => readWorkspaceAccess(key))).scope, scope, 'Incident sequence changes alone preserve the full-config scope')
    return { snapshot: await f.snapshot(key), hints: hints.length }
  }
  const waitProducer = async () => {
    const until = Date.now() + 8000
    while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
    assert.equal(slot.producer, 'finished', 'Actual producer acknowledged all owned work finished')
  }
  const bindingConflict = (error: unknown) => error instanceof f.access.PublicSafetyAccessError && error.status === 409 && error.message === 'Original execution authority has changed'
  const close = async () => {
    unhookHints()
    setServer(null)
    // An ABA invalidates every original-binding operation, including close. The actual
    // controller must already stop itself; cleanup never rewinds membership or credentials.
    if (slot.producer === 'pending') {
      await core.closeIncidentExecution(context, locator).catch(() => {})
      const until = Date.now() + 3000
      while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(20)
      if (slot.producer === 'pending') slot.worker?.terminate()
    }
    const until = Date.now() + 5000
    while (executionOwner().pendingChecks && Date.now() < until) await Bun.sleep(10)
    assert.equal(executionOwner().pendingChecks, 0, 'Actual native checks settled before database close')
    await f.database.closeDatabaseConnection()
  }
  return { f, core, executionOwner, executionWords, key, scope, original, context, started, locator, slot, hints, nativeABA, waitProducer, bindingConflict, markActorFinished: () => { actorFinished = true }, postActorAllows: () => postActorAllows, close }
}
