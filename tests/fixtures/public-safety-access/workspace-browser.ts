import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setupHandoverFixture } from './handover-setup'
import { randomUUID } from 'node:crypto'

// The native setup guard precedes every write/import that can open an application DB.
const fixture = await setupHandoverFixture()
const root = process.cwd(), source = resolve(import.meta.dir, '../../..')
const seeded = await fixture.seed('workspace-browser')
await writeFile(join(root, 'app/Gates.ts'), `export { default } from ${JSON.stringify(join(source, 'app/Gates.ts'))}`)
const { initializeAuthorization } = await import('@stacksjs/auth/policy')
await initializeAuthorization()
const { route } = await import('@stacksjs/router')
await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
const { renderTemplate } = await import('@stacksjs/stx')
console.log('QA native accounts seeded; compiling actual STX')
const html = await renderTemplate(join(source, 'resources/views/incidents.stx'), { injectCSS: true, options: { root: join(source, 'resources'), componentsDir: join(source, 'resources/components'), composablesDir: join(root, 'empty-composables'), storesDir: join(root, 'empty-stores'), stateDir: join(root, 'stx'), debug: false, envFile: false, strict: { enabled: true, bundlerFallback: 'error' } } })
if (process.env.WORKSPACE_BROWSER_EVIDENCE) { await mkdir(process.env.WORKSPACE_BROWSER_EVIDENCE, { recursive: true }); await writeFile(join(process.env.WORKSPACE_BROWSER_EVIDENCE, 'compiled.html'), html) }
assert(!html.includes('<IncidentWorkspace'), 'Native component must compile')
assert(!html.includes(fixture.senderToken), 'HTML must not hydrate a credential')
let recipientStreams = 0
const recipientStreamStarts: number[] = []
let delayObservation = true, releaseObservation: (() => void) | undefined
const secret = randomUUID()
let readOnlyToken: string | undefined
const controlRequest = async (request: Request) => {
  if (new URL(request.url).pathname.startsWith('/__fixture/')) {
    if (request.headers.get('x-fixture-control') !== secret) return new Response(null, { status: 404 })
    const action = new URL(request.url).pathname.slice('/__fixture/'.length)
    if (action === 'status') return Response.json({ releaseReady: !!releaseObservation, recipientStreams, recipientStreamStarts })
    if (action === 'release') { releaseObservation?.(); return Response.json({ ok: true }) }
    if (action === 'verify') {
      const committed = await fixture.snapshot(seeded.key)
      assert.equal(committed.incident!.coordinator_id, fixture.recipient.id)
      for (const [kind, count] of [['observation-created', 2], ['review-appended', 1], ['handover-accepted', 1]] as const) assert.equal(committed.audits.filter(audit => audit.action === kind).length, count)
      return Response.json({ ok: true })
    }
    else if (action === 'read-only') { readOnlyToken = await fixture.credential(fixture.recipient.id, ['public-safety:read']); return Response.json({ token: readOnlyToken }) }
    else if (action === 'revoke') { if (readOnlyToken) await fixture.tokens.revokeToken(readOnlyToken); await fixture.tokens.revokeToken(fixture.recipientToken) }
    else return new Response(null, { status: 404 })
    return Response.json({ ok: true })
  }
  return new Response(null, { status: 404 })
}
route.use(async (request: Request, next: () => Promise<Response | null> | Response | null) => {
  if (new URL(request.url).pathname.startsWith('/api/')) {
    if (new URL(request.url).pathname.endsWith('/workspace/events') && request.headers.get('authorization') === `Bearer ${fixture.recipientToken}`) { recipientStreams++; recipientStreamStarts.push(Date.now()) }
    const response = await next()
    if (delayObservation && request.method === 'POST' && new URL(request.url).pathname.endsWith('/observations') && response?.ok) {
      delayObservation = false
      await new Promise<void>(resolve => { releaseObservation = resolve })
    }
    return response
  }
  return next()
})
const page = () => {
  return new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })
}
route.get('/incidents', page)
route.post('/incidents', page)
for (const action of ['status', 'release', 'verify', 'read-only', 'revoke']) route.get(`/__fixture/${action}`, controlRequest)
const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: false })
const capture = seeded.run.survey.captures.find((_capture, index) => seeded.run.captures[index]?.support.includes(1))!
const captureIndex = seeded.run.survey.captures.indexOf(capture), pixel = seeded.run.captures[captureIndex]!.support.indexOf(1)
await writeFile(join(root, 'credentials.json'), JSON.stringify({ url: `http://127.0.0.1:${server.port}`, key: seeded.key, sourceDigest: seeded.source.digest, senderToken: fixture.senderToken, recipientToken: fixture.recipientToken, recipientId: fixture.recipient.id, control: secret, capture: { id: capture.id, width: capture.width }, pixel }), { mode: 0o600 })
let drift = 0, previous = Date.now()
const monitor = setInterval(() => { const now = Date.now(); drift = Math.max(drift, now - previous - 100); previous = now }, 100)
try {
  if (process.env.WORKSPACE_BROWSER_CONTROL_ONLY === 'true') {
    const observation = { sourceDigest: seeded.source.digest, captureId: capture.id, modality: 'visible', pixel: { x: pixel % capture.width, y: Math.floor(pixel / capture.width) }, note: 'Native fixture original', uncertaintyNote: 'Native fixture uncertainty' }
    await fixture.as(fixture.senderToken, () => fixture.records.appendPublicSafetyObservation(seeded.key, { ...observation, expectedVersion: 4 }))
    const second = await fixture.as(fixture.senderToken, () => fixture.records.appendPublicSafetyObservation(seeded.key, { ...observation, expectedVersion: 5 }))
    await fixture.as(fixture.recipientToken, () => fixture.records.appendPublicSafetyReview(seeded.key, second.observation.id, { expectedVersion: 6, sourceDigest: seeded.source.digest, previousReviewId: null, disposition: 'unresolved', note: 'Native fixture review' }))
    const offer = await fixture.offer(seeded)
    await fixture.as(fixture.recipientToken, () => fixture.handover.decideIncidentHandover(seeded.key, fixture.decision(offer)))
    const url = `http://127.0.0.1:${server.port}/__fixture/verify`
    assert.equal((await fetch(url)).status, 404)
    const verified = await fetch(url, { headers: { 'x-fixture-control': secret } })
    assert.equal(verified.status, 200)
    assert.deepEqual(await verified.json(), { ok: true })
    console.log('PASS native workspace browser verify control')
  }
  else {
  const child = Bun.spawn([process.execPath, `--config=${join(root, 'bunfig.toml')}`, '--no-env-file', join(source, 'tests/helpers/workspace-browser-driver.ts')], { cwd: root, env: process.env, stdout: 'inherit', stderr: 'inherit' })
  assert.equal(await child.exited, 0, 'Isolated native browser driver must pass')
  }
}
finally { clearInterval(monitor); console.log(`QA native server maximum100ms timer drift ms: ${drift}`); releaseObservation?.(); await server.stop(true); await fixture.database.closeDatabaseConnection() }
