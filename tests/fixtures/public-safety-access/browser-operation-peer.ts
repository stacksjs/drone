import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

// Controlled external HTTP/WebSocket peer, not a Chrome implementation.
const root = process.cwd(), mode = process.env.BROWSER_PEER_MODE
assert(basename(root).startsWith('drone-incident-access-browser-operation-'))
assert(['version-fetch', 'version-json', 'target-fetch', 'target-json', 'browser-socket', 'page-socket', 'control-fetch', 'control-json', 'control-ok', 'ok'].includes(mode!))
const profile = Bun.argv.find(value => value.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
assert.equal(profile, join(root, 'browser-profile'))
const stalledBody = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }), { headers: { 'content-type': 'application/json' } })
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request, owner): Response | Promise<Response> | undefined {
    const path = new URL(request.url).pathname
    if (path === '/browser' || path === '/page') {
      if ((path === '/browser' && mode === 'browser-socket') || (path === '/page' && mode === 'page-socket')) return new Promise<Response>(() => {})
      assert(owner.upgrade(request)); return
    }
    if (path === '/__fixture/status') {
      assert.equal(request.headers.get('x-fixture-control'), 'synthetic-peer-control')
      if (mode === 'control-fetch') return new Promise<Response>(() => {})
      if (mode === 'control-json') return stalledBody()
      return Response.json({ ok: true })
    }
    if (path === '/json/version' || path === '/json/new') {
      const operation = path === '/json/version' ? 'version' : 'target'
      if (mode === `${operation}-fetch`) return new Promise<Response>(() => {})
      if (mode === `${operation}-json`) return stalledBody()
      return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/${operation === 'version' ? 'browser' : 'page'}` })
    }
    return new Response(null, { status: 404 })
  },
  websocket: { message() {} },
})
process.on('SIGTERM', () => { void server.stop(true).then(() => process.exit(0)) })
await writeFile(join(root, 'peer.pid'), String(process.pid), { mode: 0o600, flag: 'wx' })
await writeFile(join(profile!, 'DevToolsActivePort'), `${server.port}\n/browser\n`, { mode: 0o600, flag: 'wx' })
