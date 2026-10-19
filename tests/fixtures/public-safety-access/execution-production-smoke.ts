/* eslint-disable ts/no-top-level-await, no-console */
// Standalone native child: ordered awaited boot and scalar stdout are intentional.
import type { PublicSafetyRun, PublicSafetyScenario } from '../../../resources/functions/drone/public-safety/runtime-types'
import { publicSafetyScenarios } from '../../../resources/functions/drone/public-safety/runtime-types'
import { simulatePublicSafety } from '../../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../../resources/functions/drone/public-safety/evidence'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

const seconds = Number(Bun.argv[2])
assert(seconds === 100 || seconds === 120, 'Only the two accepted production qualification durations are accepted')
const scenario = (Bun.argv[3] ?? 'nominal') as PublicSafetyScenario
assert(publicSafetyScenarios.includes(scenario), 'Only existing public-safety scenarios are accepted')
const f = await setupHandoverFixture()
const core = await import('../../../resources/functions/drone/public-safety/execution/service')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
const { examplePublicSafetyConfig } = await import('../../../resources/functions/drone/public-safety/fixtures')
const { Gate } = await import('@stacksjs/auth/gate')
const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { enhanceRequest, getCurrentRequest, runWithRequest } = await import('@stacksjs/router')
const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
const limits = (await import('../../../config/execution')).default
const asRequest = <T>(method: string, operation: string, work: () => Promise<T>) => runWithRequest(enhanceRequest(new Request(`https://incident.invalid/api/public-safety/incidents/production/execution/${operation}`, { method, headers: { authorization: `Bearer ${f.senderToken}` } }) as Parameters<typeof enhanceRequest>[0]), work)
type DiagnosticSlot = { worker: Worker | null, control: Int32Array, ownerCheckBusy: boolean, phase: string, reason: string | null, producer: string, admission: string, recording: string | null }
type ReplayBracket = { elapsedMs: number, pendingBefore: number, pendingAfter: number, ownerHeartbeatBefore: boolean, ownerHeartbeatAfter: boolean, queries: number }
let slot: DiagnosticSlot | undefined, captured: ReturnType<typeof core.captureExecutionContext> | undefined
let locator: { execution: string, scope: string } | undefined, attachment: Awaited<ReturnType<typeof core.attachIncidentExecution>> | undefined
let sampler: ReturnType<typeof setInterval> | undefined, subscriberTimer: ReturnType<typeof setInterval> | undefined
const pendingSubscriber = new Set<Promise<void>>()
let queries = 0, ownerGateChecks = 0, subscriberGateChecks = 0, otherGateChecks = 0, gateMaxMs = 0
let events = 0, lastEvent = 0, maxPending = 0, maxTimerGapMs = 0, peakSampledRss = 0, subscriberChecks = 0
let admissionMs: number | null = null, completionMs: number | null = null, replayBracket: ReplayBracket | null = null
let canonicalBytes: number | null = null, digest: string | null = null, faultDemonstrated: boolean | null = null, surveyStatus: string | null = null
const subscriberFailures: { elapsedMs: number, status: number | null }[] = []
const began = performance.now()
const unhook = registerPersistentQueryHooks({ onQueryEnd() { queries++ } })
try {
  const key = `execution-production-${scenario}-${seconds}`
  const config = examplePublicSafetyConfig()
  config.id = key
  config.revision = 'r1'
  config.visitId = 'v1'
  config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  await f.as(f.senderToken, () => f.access.createPublicSafetyIncident({ config }))
  const before = await f.snapshot(key)
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))).entries.length, 0)
  // Independent unchanged runtime oracle is computed before the live controller starts.
  // This avoids adding synchronous replay work to a pending native check's lifetime.
  const ordinaryCanonical = publicSafetyRecordingData(simulatePublicSafety({ config: JSON.parse(String(before.incident!.config_json)), scenario, seconds }))
  const scope = (await f.as(f.senderToken, () => readWorkspaceAccess(key))).scope
  Gate.define('public-safety:source-register', async (user, incident) => {
    const request = getCurrentRequest(), at = performance.now()
    if (request?.method === 'POST' && request.url.endsWith('/start')) ownerGateChecks++
    else if (request?.method === 'GET' && request.url.endsWith('/events')) subscriberGateChecks++
    else otherGateChecks++
    try { return await publicSafetyIncidentGate(user, incident, 'source-register') }
    finally { gateMaxMs = Math.max(gateMaxMs, performance.now() - at) }
  })
  const started = await asRequest('POST', 'start', () => {
    captured = core.captureExecutionContext(key)
    return core.startIncidentExecution(captured, { intent: randomUUID(), scope, scenario, seconds }, new URL('../../../app/Workers/PublicSafetySimulation.ts', import.meta.url))
  })
  const runBegan = performance.now()
  locator = { execution: started.execution, scope }
  slot = executionOwner().slot as DiagnosticSlot
  assert(slot.worker)
  // Private observation delegates the exact production handler without injecting messages,
  // holding native policy, changing clocks, or changing replay/credit/retention behavior.
  const worker = slot.worker, observe = worker.onmessage
  assert(observe)
  worker.onmessage = event => {
    const isResult = event.data?.kind === 'result'
    const at = performance.now(), queryAt = queries, pendingBefore = executionOwner().pendingChecks, ownerHeartbeatBefore = slot!.ownerCheckBusy
    try { observe.call(worker, event) }
    finally {
      if (isResult) replayBracket = { elapsedMs: performance.now() - at, pendingBefore, pendingAfter: executionOwner().pendingChecks, ownerHeartbeatBefore, ownerHeartbeatAfter: slot!.ownerCheckBusy, queries: queries - queryAt }
    }
  }
  let previous = performance.now()
  sampler = setInterval(() => {
    const now = performance.now()
    maxTimerGapMs = Math.max(maxTimerGapMs, now - previous)
    previous = now
    maxPending = Math.max(maxPending, executionOwner().pendingChecks)
    peakSampledRss = Math.max(peakSampledRss, process.memoryUsage().rss)
  }, 20)
  attachment = await asRequest('GET', 'events', () => {
    const subscriber = core.captureExecutionContext(key)
    return core.attachIncidentExecution(subscriber, locator!, value => {
      if (value.latestEvent && value.latestEvent.sequence > lastEvent) {
        assert.equal(value.latestEvent.sequence, lastEvent + 1)
        if (events === 0) assert.equal(value.producer, 'pending', 'First actual progress precedes producer completion')
        lastEvent = value.latestEvent.sequence
        events++
      }
    })
  })
  // Natural periodic native subscriber checks supplement the real core owner heartbeat.
  // This is core qualification, not an HTTP/SSE/browser-delivery assertion.
  subscriberTimer = setInterval(() => {
    if (pendingSubscriber.size) return
    const at = performance.now()
    const pending = attachment!.check().then(() => { subscriberChecks++ }, error => {
      subscriberFailures.push({ elapsedMs: performance.now() - at, status: error instanceof f.access.PublicSafetyAccessError ? error.status : null })
      attachment!.release()
    }).finally(() => { pendingSubscriber.delete(pending) })
    pendingSubscriber.add(pending)
  }, limits.heartbeatMs)
  await attachment.activate()
  const until = Date.parse(started.availableUntil) + limits.stopGraceMs + 5000
  while (['waiting-for-consumer', 'running', 'stopping'].includes(slot.phase) && Date.now() < until) await Bun.sleep(20)
  completionMs = performance.now() - runBegan
  const current = await asRequest('GET', 'current', () => core.readIncidentExecution(core.captureExecutionContext(key), { scope }))
  assert.equal(current?.phase, 'completed', `Actual terminal reason: ${slot.reason}`)
  assert.equal(current.producer, 'finished')
  assert.equal(current.admission, 'unsubmitted')
  assert.equal(Atomics.load(slot.control, executionWords.returned), 1)
  assert.equal(Atomics.load(slot.control, executionWords.credit), events)
  assert.equal(current.completion!.eventCount, events)
  assert(replayBracket, 'The actual production parent handled the complete transferred result')
  assert(slot.recording)
  const recording = slot.recording
  const run = JSON.parse(recording) as PublicSafetyRun
  assert.equal(run.seconds, seconds)
  assert.equal(run.scenario, scenario)
  assert(recording === ordinaryCanonical, 'Actual full production recording equals the unchanged ordinary runtime canonical bytes')
  assert.equal(run.events.length, events)
  assert.equal(current.completion!.epochCount, run.epochs.length)
  assert.equal(current.completion!.captureCount, run.captures.length)
  assert.equal(current.completion!.digest, createHash('sha256').update(recording, 'utf8').digest('hex'))
  assert.equal(current.completion!.byteLength, new TextEncoder().encode(recording).length)
  assert.equal(current.completion!.surveyStatus, run.survey.status)
  assert.equal(current.completion!.faultDemonstrated, scenario !== 'nominal')
  canonicalBytes = current.completion!.byteLength
  digest = current.completion!.digest
  faultDemonstrated = current.completion!.faultDemonstrated
  surveyStatus = current.completion!.surveyStatus
  assert.equal(run.survey.boardNeutral, true)
  if (scenario === 'nominal') assert.equal(run.survey.status, 'completed')
  else assert(['blocked', 'aborted'].includes(run.survey.status), 'Actual loss scenario stops collection with neutral outputs')
  assert.deepEqual(await f.snapshot(key), before, 'Actual completion writes no source, version or audit')
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))).entries.length, 0)
  const admissionBegan = performance.now()
  const registered = await asRequest('POST', 'admit', () => core.admitIncidentExecution(core.captureExecutionContext(key), { ...locator!, digest: current.completion!.digest, expectedVersion: 1 }))
  admissionMs = performance.now() - admissionBegan
  assert.equal(registered.source.digest, current.completion!.digest)
  assert.equal(registered.source.uploaderId, f.sender.id)
  assert.equal(registered.incident.version, 2)
  const admitted = await asRequest('GET', 'current', () => core.readIncidentExecution(core.captureExecutionContext(key), { scope }))
  assert.equal(admitted!.admission, 'confirmed')
  assert.equal((await f.as(f.senderToken, () => f.records.listPublicSafetySources(key))).entries.length, 1)
  const after = await f.snapshot(key)
  assert.equal(after.audits.length, before.audits.length + 1)
  assert.equal(subscriberFailures.length, 0, 'Natural periodic subscriber authority remained usable across actual replay/admission')
  attachment.release()
  assert.equal((await core.closeIncidentExecution(captured!, locator)).phase, 'discarded')
  assert.equal(await core.readIncidentExecution(captured!, { scope }), null)
  console.log(`PASS native production ${scenario} ${seconds} actual completion and explicit admission`)
}
finally {
  clearInterval(subscriberTimer)
  clearInterval(sampler)
  await Promise.allSettled([...pendingSubscriber])
  attachment?.release()
  console.log(`EXECUTION_SMOKE ${JSON.stringify({ scenario, seconds, elapsedMs: performance.now() - began, completionMs, admissionMs, events, canonicalBytes, digest, faultDemonstrated, surveyStatus, queries, ownerGateChecks, subscriberGateChecks, otherGateChecks, gateMaxMs, subscriberChecks, subscriberFailures, maxPending, maxTimerGapMs, peakSampledRss, replayBracket, finalPhase: slot?.phase, finalReason: slot?.reason, finalProducer: slot?.producer, finalAdmission: slot?.admission })}`)
  if (captured && locator && executionOwner().slot) {
    await core.closeIncidentExecution(captured, locator).catch(() => {})
    const stopUntil = Date.now() + limits.stopGraceMs + 1000
    while (slot?.producer === 'pending' && Date.now() < stopUntil) await Bun.sleep(20)
    if (slot?.producer === 'pending') slot.worker?.terminate()
  }
  unhook()
  await f.database.closeDatabaseConnection()
}
