import assert from 'node:assert/strict'
import { closeSync, openSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { startWorkspaceBrowser } from '../../helpers/workspace-browser'
import { requestWorkspaceControl } from '../../helpers/workspace-control'

const root = process.cwd(), mode = process.env.BROWSER_PEER_MODE
assert(basename(root).startsWith('drone-incident-access-browser-operation-'))
const unwritable = process.env.BROWSER_OPERATION_UNWRITABLE_DIAGNOSTIC === 'true'
if (unwritable) {
  closeSync(2)
  assert.equal(openSync('/dev/null', 'r'), 2, 'Keep descriptor two reserved and read-only')
  assert.throws(() => writeSync(2, 'probe'), { code: 'EBADF' })
}
let browser: Awaited<ReturnType<typeof startWorkspaceBrowser>> | undefined
let caught: unknown
const began = performance.now()
try {
  browser = await startWorkspaceBrowser(root)
  if (mode?.startsWith('target-') || mode === 'page-socket') await browser.page('http://fixture.invalid/incidents')
  if (mode?.startsWith('control-')) {
    const port = (await readFile(join(root, 'browser-profile/DevToolsActivePort'), 'utf8')).split('\n')[0]
    const result = await requestWorkspaceControl({ url: `http://127.0.0.1:${port}`, control: 'synthetic-peer-control' }, 'status')
    assert.deepEqual(result, { ok: true })
  }
}
catch (error) { caught = error }
finally { await browser?.close() }
if (unwritable) assert.throws(() => writeSync(2, 'probe'), { code: 'EBADF' })
if (mode === 'ok' || mode === 'control-ok') assert.equal(caught, undefined)
else {
  assert(caught instanceof Error)
  if (mode?.endsWith('-socket')) { assert.equal(caught.name, 'Error'); assert.match(caught.message, /^Browser socket /) }
  else assert(['TimeoutError', 'AbortError'].includes(caught.name), 'Preserve the native abort exception instead of replacing it')
  assert(performance.now() - began >= 5000, 'Exercise the original five-second native fetch timeout')
}
const peer = Number(await readFile(join(root, 'peer.pid'), 'utf8'))
assert(Number.isSafeInteger(peer) && peer > 1)
assert.throws(() => process.kill(peer, 0), 'Owned peer must actually exit before files are removed')
console.log(JSON.stringify({ oracle: 'browser-operation-peer-result', mode, nativeError: caught instanceof Error ? caught.name : null, elapsedMs: performance.now() - began, peerReaped: true }))
