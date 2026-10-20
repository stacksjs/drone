import type { ExecutionView } from '../../../resources/functions/drone/public-safety/execution/types'
import { publicSafetyScenarios } from '../../../resources/functions/drone/public-safety/runtime-types'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setupHandoverFixture } from './handover-setup'

// Real native setup owns the guarded disposable SQLite file before any application boot.
const fixture = await setupHandoverFixture()
const root = process.cwd(), source = resolve(import.meta.dir, '../../..')
const seeded = await fixture.seed('execution-browser')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { route, getCurrentRequest } = await import('@stacksjs/router')
const { Gate } = await import('@stacksjs/auth/gate')
const { publicSafetyIncidentGate } = await import('../../../resources/functions/drone/public-safety/access/policy')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { executionWords: words } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
let holdArmed = false, holdUsed = false, held = false, releaseCredit: (() => void) | undefined
let delayStart = true, releaseStart: (() => void) | undefined
let streamStarts = 0, startRequests = 0, admissionRequests = 0, closeStream: (() => Promise<void>) | undefined

// Diagnostic state belongs only to this disposable fixture, never the execution controller.
type RouteClass = 'execution-start' | 'execution-close' | 'execution-admission' | 'execution-events' | 'execution-status' | 'workspace-read'
interface ResponseObservation { route: RouteClass, method: 'GET' | 'HEAD' | 'POST', status: number | null, elapsedMs: number | null }
interface MutationObservation { ordinal: number, settled: boolean, status: number | null, elapsedMs: number | null }
let lastStart: MutationObservation | null = null, lastAdmission: MutationObservation | null = null
const responses: ResponseObservation[] = [], ordinals = new WeakMap<object, number>()
let nextOrdinal = 0
const scalar = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null
const field = (value: unknown, name: string): unknown => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined
const choice = <T extends string>(value: unknown, values: readonly T[]): T | null => values.find(item => item === value) ?? null
const ordinal = (slot: object) => {
  const existing = ordinals.get(slot)
  if (existing !== undefined) return existing
  const created = ++nextOrdinal
  ordinals.set(slot, created)
  return created
}
function diagnosticSnapshot() {
  const owner = executionOwner(), slot = owner.slot
  if (slot !== null && (typeof slot !== 'object' || Object.getPrototypeOf(slot) !== Object.prototype)) throw new Error('Diagnostic slot unavailable')
  const control = field(slot, 'control')
  if (slot !== null && (!(control instanceof Int32Array) || control.length !== words.length || !(control.buffer instanceof SharedArrayBuffer))) throw new Error('Diagnostic control unavailable')
  const now = Date.now(), event = field(slot, 'latestEvent'), subscriber = field(slot, 'subscriber'), startedAt = field(slot, 'startedAt')
  const relative = (name: string) => {
    const value = field(slot, name)
    return typeof value === 'number' ? scalar(value - now) : null
  }
  return {
    available: true, pendingChecks: scalar(owner.pendingChecks),
    fixture: { startRequests, admissionRequests, streamStarts, holdArmed, held, holdUsed }, lastStart, lastAdmission, responses: responses.slice(),
    slot: slot === null ? null : {
      ordinal: ordinal(slot),
      phase: choice(field(slot, 'phase'), ['waiting-for-consumer', 'running', 'stopping', 'completed', 'canceled', 'failed', 'discarded'] satisfies ExecutionView['phase'][]),
      reason: choice(field(slot, 'reason'), ['consumer-absent', 'authority-unavailable', 'deadline-expired', 'producer-failed', 'protocol-refused', 'stopped-by-owner', 'discarded-by-owner', 'consumer-failed', 'stop-unconfirmed', 'admission-outcome-unknown'] satisfies NonNullable<ExecutionView['reason']>[]),
      producer: choice(field(slot, 'producer'), ['pending', 'finished', 'unconfirmed'] satisfies ExecutionView['producer'][]),
      admission: choice(field(slot, 'admission'), ['unsubmitted', 'submitting', 'confirmed', 'unknown'] satisfies ExecutionView['admission'][]),
      scenario: choice(field(slot, 'scenario'), publicSafetyScenarios), requestedSeconds: scalar(field(slot, 'seconds')),
      lastSequence: scalar(field(slot, 'lastSequence')), eventSequence: scalar(field(event, 'sequence')), eventAtMs: scalar(field(event, 'atMs')),
      hasSubscriber: !!subscriber, subscriberActive: field(subscriber, 'active') === true,
      processing: field(slot, 'processing') === true, ownerCheckBusy: field(slot, 'ownerCheckBusy') === true,
      resultSeen: field(slot, 'resultSeen') === true, hasCandidate: !!field(slot, 'candidate'), finishedAck: field(slot, 'finishedAck') === true,
      finalizing: field(slot, 'finalizing') === true, hasCompletion: !!field(slot, 'completion'), hasRecording: typeof field(slot, 'recording') === 'string',
      elapsedMs: typeof startedAt === 'number' ? scalar(now - startedAt) : null,
      wallRemainingMs: relative('wallDeadline'), metadataRemainingMs: relative('metadataDeadline'),
      control: control instanceof Int32Array ? { credit: Atomics.load(control, words.credit), cancel: Atomics.load(control, words.cancel), emitted: Atomics.load(control, words.emitted), returned: Atomics.load(control, words.returned), stage: Atomics.load(control, words.stage) } : null,
    },
  }
}
function routeClass(path: string, method: string): RouteClass | null {
  if (method === 'POST' && path.endsWith('/workspace/execution')) return 'execution-start'
  if (method === 'POST' && path.endsWith('/workspace/execution/close')) return 'execution-close'
  if (method === 'POST' && path.endsWith('/workspace/execution/admission')) return 'execution-admission'
  if (method !== 'GET' && method !== 'HEAD') return null
  if (/\/workspace\/execution\/[a-f0-9-]+\/events$/.test(path)) return 'execution-events'
  if (path.endsWith('/workspace/execution')) return 'execution-status'
  return path.endsWith('/workspace') ? 'workspace-read' : null
}
Gate.define('public-safety:source-register', async (user, key) => {
  const allowed = await publicSafetyIncidentGate(user, key, 'source-register')
  const request = getCurrentRequest(), slot = executionOwner().slot as { control: Int32Array, processing: boolean, ownerCheckBusy: boolean } | null
  if (allowed && holdArmed && request?.method === 'POST' && new URL(request.url).pathname.endsWith('/workspace/execution') && slot?.processing && !slot.ownerCheckBusy && Atomics.load(slot.control, words.emitted) >= 2 && Atomics.load(slot.control, words.credit) < Atomics.load(slot.control, words.emitted) && Atomics.load(slot.control, words.returned) === 0) {
    holdArmed = false; holdUsed = true; held = true
    // processing plus no active owner heartbeat identifies an actual pump credit check.
    // This holds a genuine later original-owner eligibility decision, never producer code.
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => { held = false; resolve() }, 1500)
      releaseCredit = () => { clearTimeout(timeout); held = false; resolve() }
    })
  }
  return allowed
})
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const { renderTemplate } = await import('@stacksjs/stx')
const html = await renderTemplate(join(source, 'resources/views/incidents.stx'), { injectCSS: true, options: { root: join(source, 'resources'), componentsDir: join(source, 'resources/components'), composablesDir: join(root, 'empty-composables'), storesDir: join(root, 'empty-stores'), stateDir: join(root, 'stx'), debug: false, envFile: false, strict: { enabled: true, bundlerFallback: 'error' } } })
assert(!html.includes('<IncidentWorkspace'))
assert(!html.includes(fixture.senderToken))
const secret = randomUUID()
const sources = () => fixture.database.db.primary.selectFrom('public_safety_sources').selectAll().execute()
const control = async (request: Request) => {
  if (request.headers.get('x-fixture-control') !== secret) return new Response(null, { status: 404 })
  const action = new URL(request.url).pathname.slice('/__fixture/'.length)
  if (action === 'status') return Response.json({ held, streamStarts, startRequests, startResponseReady: !!releaseStart })
  if (action === 'diagnostics') {
    try {
      const text = `${JSON.stringify(diagnosticSnapshot())}\n`
      if (Buffer.byteLength(text, 'utf8') > 8192) throw new Error('Diagnostic snapshot unavailable')
      return new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
    }
    catch { return Response.json({ available: false }) }
  }
  if (action === 'release-start') { releaseStart?.(); return Response.json({ ok: true }) }
  if (action === 'arm-before-return') {
    assert(!holdArmed && !holdUsed, 'Arm only after the browser has rendered an earlier genuine event')
    const slot = executionOwner().slot as { control: Int32Array } | null
    assert(slot && Atomics.load(slot.control, words.returned) === 0)
    holdArmed = true
    return Response.json({ ok: true })
  }
  if (action === 'before-return') {
    const slot = executionOwner().slot as { control: Int32Array } | null
    assert(held && slot, 'Real original-owner Gate must still be held')
    assert.equal(Atomics.load(slot.control, words.returned), 0, 'Actual simulator has not returned')
    assert(Atomics.load(slot.control, words.emitted) >= 2)
    assert(Atomics.load(slot.control, words.credit) < Atomics.load(slot.control, words.emitted))
    // No SQL or stream pull while this original-owner transaction is held.
    releaseCredit?.()
    return Response.json({ ok: true })
  }
  if (action === 'release-and-renew') { releaseCredit?.(); await closeStream?.(); return Response.json({ ok: true }) }
  if (action === 'before-admission') { assert.equal((await sources()).length, 1, 'Completion does not write a durable source'); return Response.json({ ok: true }) }
  if (action === 'verify-admitted') {
    const rows = await sources()
    assert.equal(rows.length, 2)
    assert(rows.some(row => row.digest !== seeded.source.digest))
    const committed = await fixture.snapshot(seeded.key)
    assert.equal(committed.audits.filter(audit => audit.action === 'source-registered').length, 2)
    return Response.json({ ok: true })
  }
  if (action === 'read-only') return Response.json({ token: await fixture.credential(fixture.sender.id, ['public-safety:read']) })
  if (action === 'revoke') { await fixture.tokens.revokeToken(fixture.senderToken); return Response.json({ ok: true }) }
  return new Response(null, { status: 404 })
}
route.use(async (request: Request, next: () => Promise<Response | null> | Response | null) => {
  const pathname = new URL(request.url).pathname
  const kind = routeClass(pathname, request.method), began = performance.now()
  const startOrdinal = kind === 'execution-start' ? ++startRequests : null
  const admissionOrdinal = kind === 'execution-admission' ? ++admissionRequests : null
  if (startOrdinal !== null) lastStart = { ordinal: startOrdinal, settled: false, status: null, elapsedMs: null }
  if (admissionOrdinal !== null) lastAdmission = { ordinal: admissionOrdinal, settled: false, status: null, elapsedMs: null }
  let status: number | null = null
  try {
    const response = await next()
    status = response?.status ?? null
    if (delayStart && request.method === 'POST' && pathname.endsWith('/workspace/execution') && response?.ok) { delayStart = false; await new Promise<void>(resolve => { releaseStart = resolve }) }
    if (request.method !== 'GET' || !/\/workspace\/execution\/[a-f0-9-]+\/events$/.test(pathname) || !response?.ok || !response.body) return response
    streamStarts++
    const reader = response.body.getReader()
    let closed = false, output: ReadableStreamDefaultController<Uint8Array> | undefined
    const close = async () => { if (closed) return; closed = true; output?.close(); await reader.cancel().catch(() => {}) }
    closeStream = close
    // Opaque native chunks pass unchanged. Only the private fixture can end a connection.
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller },
      async pull(controller) { const value = await reader.read(); if (closed) return; if (value.done) { closed = true; controller.close() } else controller.enqueue(value.value) },
      async cancel(reason) { if (closed) return; closed = true; await reader.cancel(reason) },
    })
    return new Response(body, { status: response.status, headers: response.headers })
  }
  finally {
    try {
      // Never inspect response bodies or let observational evidence replace an original error.
      if (kind && (request.method === 'GET' || request.method === 'HEAD' || request.method === 'POST')) {
        const elapsedMs = scalar(performance.now() - began)
        responses.push({ route: kind, method: request.method, status, elapsedMs })
        if (responses.length > 16) responses.shift()
        if (startOrdinal !== null && lastStart?.ordinal === startOrdinal) lastStart = { ordinal: startOrdinal, settled: true, status, elapsedMs }
        if (admissionOrdinal !== null && lastAdmission?.ordinal === admissionOrdinal) lastAdmission = { ordinal: admissionOrdinal, settled: true, status, elapsedMs }
        const slot = executionOwner().slot
        if (startOrdinal !== null && status === 202 && slot && typeof slot === 'object') ordinal(slot)
      }
    }
    catch { /* Diagnostic observation never changes the route outcome. */ }
  }
})
const page = () => new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })
route.get('/incidents', page)
for (const action of ['status', 'diagnostics', 'release-start', 'arm-before-return', 'before-return', 'release-and-renew', 'before-admission', 'verify-admitted', 'read-only', 'revoke']) route.get(`/__fixture/${action}`, control)
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: false })
if (process.env.EXECUTION_BROWSER_EVIDENCE) { await mkdir(process.env.EXECUTION_BROWSER_EVIDENCE, { recursive: true }); await writeFile(join(process.env.EXECUTION_BROWSER_EVIDENCE, 'compiled.html'), html) }
await writeFile(join(root, 'execution-credentials.json'), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, key: seeded.key, sourceDigest: seeded.source.digest, token: fixture.senderToken, control: secret }), { mode: 0o600 })
try {
  const child = Bun.spawn([process.execPath, `--config=${join(root, 'bunfig.toml')}`, '--no-env-file', join(source, 'tests/helpers/execution-browser-driver.ts')], { cwd: root, env: process.env, stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await child.exited, 0, 'Isolated real execution browser driver must pass')
}
finally {
  releaseStart?.(); releaseCredit?.()
  await closeStream?.(); await server.stop(true)
  const slot = executionOwner().slot as { execution: string, binding: { scope: string }, producer: string, worker: Worker | null } | null
  if (slot?.producer === 'pending') {
    const core = await import('../../../resources/functions/drone/public-safety/execution/service')
    // Cleanup uses real original-token policy. Revocation is never rewound.
    await fixture.as(fixture.senderToken, () => core.closeIncidentExecution(core.captureExecutionContext(seeded.key), { execution: slot.execution, scope: slot.binding.scope })).catch(() => {})
    const until = Date.now() + 5000
    while (slot.producer === 'pending' && Date.now() < until) await Bun.sleep(10)
    if (slot.producer === 'pending') slot.worker?.terminate()
  }
  const until = Date.now() + 5000
  while (executionOwner().pendingChecks && Date.now() < until) await Bun.sleep(10)
  assert.equal(executionOwner().pendingChecks, 0, 'Actual native checks settle before the disposable database closes')
  await fixture.database.closeDatabaseConnection()
  assert(slot?.producer !== 'pending', 'Producer cleanup must finish or remain explicitly failed; termination is not a finished ACK')
}
