import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'
import { setupIncidentDatabase } from './setup'
import { examplePublicSafetyConfig } from '../../../resources/functions/drone/public-safety/fixtures'
import type { ExecutionView } from '../../../resources/functions/drone/public-safety/execution/types'

// The public route seam uses real native auth/Gates/SQLite and the actual file Worker.
// It does not qualify hardware, arbitrary bundled deployment or individual OS thread join.
const { root, database, User } = await setupIncidentDatabase()
const source = resolve(import.meta.dir, '../../..')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { Rbac } = await import('@stacksjs/auth/rbac')
const { createToken } = await import('@stacksjs/auth/tokens')
const { route, getCurrentRequest } = await import('@stacksjs/router')
const { Gate } = await import('@stacksjs/auth/gate')
const { executionOwner } = await import('../../../resources/functions/drone/public-safety/execution/state')
const { executionWords } = await import('../../../resources/functions/drone/public-safety/execution/protocol')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const nativeRoutes = process.env.INCIDENT_NATIVE_ROUTES === 'true'
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes })
const base = `http://127.0.0.1:${server.port}/api/public-safety/incidents`
try {
  const owner = await User.create({ name: 'Execution owner', email: 'execution-owner@example.invalid', password: 'temporary-fixture-password' })
  for (const permission of ['public-safety:access', 'public-safety:create']) {
    await Rbac.createPermission(permission, 'web')
    await Rbac.givePermission(owner.id, permission, 'web')
  }
  const credential = (await createToken(owner.id, 'execution fixture', ['public-safety:read', 'public-safety:coordinate'], { withRefreshToken: false })).plainTextToken
  const send = async (method: string, path: string, body?: unknown, token: string | null = credential, extra: Record<string, string> = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const vary = response.headers.get('vary')!.toLowerCase()
    assert(vary.includes('authorization') && vary.includes('cookie'))
    if (response.status >= 400 && method !== 'HEAD') {
      const value = await response.clone().json() as object
      assert.deepEqual(Object.keys(value), ['error'])
      for (const secret of [credential, root, 'SELECT', 'temporary-fixture-password']) assert(!JSON.stringify(value).includes(secret))
    }
    return response
  }
  const config = examplePublicSafetyConfig(); config.id = 'execution-wire'; config.retention.expiresAt = new Date(Date.now() + 86400000).toISOString()
  assert.equal((await send('POST', '', { config })).status, 201)
  const workspace = await send('GET', '/execution-wire/workspace')
  assert.equal(workspace.status, 200)
  const { scope } = await workspace.json() as { scope: string }
  const path = `/execution-wire/workspace/execution?scope=${scope}`
  const empty = await send('GET', path)
  assert.equal(empty.status, 200, 'Execution status route exists under real native authority')
  assert.equal(await empty.json(), null)
  const head = await send('HEAD', path)
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal(await (await send('GET', path)).json(), null, 'GET/HEAD do not start execution')
  for (const query of ['', '?scope=x', `?scope=${scope}&scope=${scope}`, `?scope=${scope}&token=x`, '?scope=' + 'a'.repeat(4097)]) assert.equal((await send('GET', `/execution-wire/workspace/execution${query}`)).status, 422)
  assert.equal((await send('GET', path, undefined, null)).status, 401)
  const readOnly = (await createToken(owner.id, 'read-only execution fixture', ['public-safety:read'], { withRefreshToken: false })).plainTextToken
  assert.equal((await send('GET', path, undefined, readOnly)).status, 403)
  const startPath = `${base}/execution-wire/workspace/execution`
  const rawJson = async (text: string, status: number, extra: Record<string, string> = {}) => {
    const response = await fetch(startPath, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...extra }, body: text })
    assert.equal(response.status, status, `Strict execution JSON ${text.slice(0, 40)}`)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(Object.keys(await response.json() as object), ['error'])
  }
  await rawJson('{', 400)
  await rawJson(`{"scope":"${scope}","\\u0073cope":"${scope}"}`, 400)
  await rawJson(' '.repeat(8193), 413)
  await rawJson('{}', 415, { 'content-type': 'text/plain' })
  for (const invalid of [null, [], {}, { intent: crypto.randomUUID(), scope, scenario: 'nominal', seconds: 8, extra: true }, { intent: crypto.randomUUID(), scope, scenario: 'nominal', seconds: 0 }]) assert.equal((await send('POST', '/execution-wire/workspace/execution', invalid)).status, 422)
  assert.equal((await send('POST', `/execution-wire/workspace/execution?scope=${scope}`, {})).status, 422)
  assert.equal((await send('GET', `/execution-wire/workspace/execution/not-a-uuid/events?scope=${scope}`)).status, 422)
  assert.equal(executionOwner().slot, null, 'Rejected starts and GET/HEAD never reserve a producer')
  // Fetch forbids GET bodies, so actual loopback wire framing uses an owned socket.
  const framed = (method: 'GET' | 'HEAD', token: string | null, chunked: boolean) => new Promise<number>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: server.port! })
    let response = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('Execution framing response timed out')))
    socket.on('error', reject)
    socket.on('data', bytes => { response += bytes.toString() })
    socket.on('end', () => { const status = /^HTTP\/1\.1 (\d+)/.exec(response); assert(status); resolve(Number(status[1])) })
    socket.on('connect', () => socket.write(`${method} /api/public-safety/incidents${path} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nConnection: close\r\n${token ? `Authorization: Bearer ${token}\r\n` : ''}${chunked ? 'Transfer-Encoding: chunked' : 'Content-Length: 1'}\r\n\r\n${chunked ? '1\r\nx\r\n0\r\n\r\n' : 'x'}`))
  })
  for (const method of ['GET', 'HEAD'] as const) for (const chunked of [false, true]) {
    assert.equal(await framed(method, credential, chunked), 422)
    assert.equal(await framed(method, null, chunked), 401)
  }
  const intent = crypto.randomUUID(), input = { intent, scope, scenario: 'nominal', seconds: 8 }
  const startedResponse = await send('POST', '/execution-wire/workspace/execution', input, credential, { 'x-fixture-original': 'owner' })
  assert.equal(startedResponse.status, 202)
  const started = await startedResponse.json() as ExecutionView
  assert.equal(started.intent, intent)
  assert.equal(started.phase, 'waiting-for-consumer')
  assert.equal(started.latestEvent, null)
  assert.equal((await send('POST', '/execution-wire/workspace/execution', input)).status, 409)
  const waiting = await (await send('GET', path)).json() as ExecutionView
  assert.equal(waiting.execution, started.execution, 'Current status reconciles the original one-shot start')
  assert.equal(waiting.latestEvent, null)
  const eventsPath = `/execution-wire/workspace/execution/${started.execution}/events?scope=${scope}`
  assert.equal((await send('HEAD', eventsPath)).status, 200)
  assert.equal(((await (await send('GET', path)).json()) as ExecutionView).latestEvent, null, 'HEAD events never attaches or grants producer credit')
  assert.equal((await send('GET', eventsPath, undefined, readOnly)).status, 403)
  const abort = new AbortController()
  const streamResponse = await fetch(base + eventsPath, { headers: { authorization: `Bearer ${credential}`, 'accept-encoding': 'gzip' }, signal: abort.signal })
  assert.equal(streamResponse.status, 200)
  assert.equal(streamResponse.headers.get('content-type'), 'text/event-stream')
  assert.equal(streamResponse.headers.get('content-encoding'), null)
  const reader = streamResponse.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const nextView = async (): Promise<ExecutionView> => {
    for (;;) {
      const end = text.indexOf('\n\n')
      if (end >= 0) {
        const frame = text.slice(0, end); text = text.slice(end + 2)
        if (!frame.startsWith('data: ')) continue
        const value = JSON.parse(frame.slice(6)) as { event: string, data: ExecutionView }
        assert.equal(value.event, 'execution')
        for (const field of ['recording', 'configJson', 'tokenId', 'accountId', 'rgba', 'thermalCentiKelvin', 'support']) assert(!frame.includes(`"${field}"`))
        return value.data
      }
      const chunk = await reader.read()
      assert.equal(chunk.done, false, 'Native progress stream remains available')
      text += decoder.decode(chunk.value, { stream: true })
    }
  }
  try {
    const first = await nextView()
    assert.equal(first.latestEvent?.sequence, 1)
    assert.equal(first.producer, 'pending')
    // Read the first actual public frame BEFORE holding a later native credit.
    // Holding SQLite before that read would block the subscriber's own policy.
    let hold = true, resume!: () => void, reached!: () => void
    const released = new Promise<void>(resolve => { resume = resolve })
    const held = new Promise<void>(resolve => { reached = resolve })
    Gate.after(async (user, ability) => {
      void user
      if (hold && ability === 'public-safety:source-register' && getCurrentRequest()?.headers.has('x-fixture-original')) { hold = false; reached(); await released }
    })
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([held, new Promise<never>((resolve, reject) => { void resolve; timer = setTimeout(() => reject(new Error('Later actual owner credit did not reach native Gate')), 5000) })]) }
      finally { clearTimeout(timer) }
      // Supplemental private protocol oracle, never substituted for HTTP/Auth.
      const slot = executionOwner().slot as { control: Int32Array }
      assert(slot.control instanceof Int32Array)
      assert.equal(Atomics.load(slot.control, executionWords.returned), 0, 'A genuine public progress frame was read before the producer returned')
    }
    finally { resume() }
    let complete = first
    while (complete.phase !== 'completed') {
      complete = await nextView()
      assert(!['failed', 'canceled', 'discarded'].includes(complete.phase), `Execution ended ${complete.phase}/${complete.reason}`)
    }
    assert.equal(complete.execution, started.execution)
    assert.equal(complete.producer, 'finished')
    assert(complete.completion && complete.completion.byteLength > 0)
    assert.equal(complete.admission, 'unsubmitted')
    // Terminal reconnect attaches to the same retained execution without Worker
    // construction, replay or implicit source admission, and returns its Response.
    abort.abort(); await reader.cancel().catch(() => {})
    const retainedSlot = executionOwner().slot
    const reconnectAbort = new AbortController()
    const reconnect = await fetch(base + eventsPath, { headers: { authorization: `Bearer ${credential}` }, signal: reconnectAbort.signal })
    assert.equal(reconnect.status, 200)
    const reconnected = reconnect.body!.getReader()
    try {
      let terminal = ''
      do { const chunk = await reconnected.read(); assert(!chunk.done); terminal += decoder.decode(chunk.value) } while (!terminal.includes('"phase":"completed"'))
      assert.equal(executionOwner().slot, retainedSlot, 'Reconnect never constructs or restarts the producer')
    }
    finally { reconnectAbort.abort(); await reconnected.cancel().catch(() => {}) }
    const sourcesBefore = await send('GET', '/execution-wire/sources')
    assert.equal(((await sourcesBefore.json()) as { entries: unknown[] }).entries.length, 0, 'Completion never auto-registers a source')
    const admission = await send('POST', '/execution-wire/workspace/execution/admission', { execution: started.execution, scope, digest: complete.completion.digest, expectedVersion: 1 })
    assert.equal(admission.status, 201)
    const registered = await admission.json() as { source: { digest: string, uploaderId: number }, incident: { version: number } }
    assert.equal(registered.source.digest, complete.completion.digest)
    assert.equal(registered.source.uploaderId, owner.id)
    assert.equal(registered.incident.version, 2)
    assert.equal(((await (await send('GET', path)).json()) as ExecutionView).admission, 'confirmed')
    assert.equal((await send('POST', '/execution-wire/workspace/execution/admission', { execution: started.execution, scope, digest: complete.completion.digest, expectedVersion: 2 })).status, 409)
    const discarded = await send('POST', '/execution-wire/workspace/execution/close', { execution: started.execution, scope })
    assert.equal(discarded.status, 200)
    assert.equal(((await discarded.json()) as ExecutionView).phase, 'discarded')
    assert.equal(await (await send('GET', path)).json(), null)
  }
  finally { abort.abort(); await reader.cancel().catch(() => {}) }
  console.log(`PASS native execution HTTP nativeRoutes=${nativeRoutes}`)
}
finally { await server.stop(true); await database.closeDatabaseConnection() }
