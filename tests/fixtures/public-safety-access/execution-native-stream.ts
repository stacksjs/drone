import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createBroadcastHub } from '@stacksjs/realtime'
import { emit } from '@stacksjs/realtime/emit'
import type { BroadcastStreamMetadata, BroadcastStreamOptions } from '@stacksjs/realtime/stream'
import { setupHandoverFixture } from './handover-setup'
import { qualifyPortableNativeStreamAction } from '../../helpers/public-safety-native-stream-artifact'

const mode = Bun.argv[2]
assert(mode === 'source' || mode === 'artifact')
const f = await setupHandoverFixture()
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
let closed = 0
try {
  let module = '@stacksjs/realtime/stream'
  let publish = emit
  if (mode === 'artifact') {
    // Native app packaging options: app root, ESM/Bun, no splitting, only SWC
    // external. A benign private fixture Action calls the released stream export.
    // This is bounded transport packaging, not authenticated server acceptance.
    const outdir = join(process.cwd(), 'native-stream-build')
    const copied = join(process.cwd(), 'relocated-native-stream')
    const entry = join(process.cwd(), 'app/Actions/NativeStreamProbe.ts')
    await mkdir(join(process.cwd(), 'app/Actions'), { recursive: true })
    await writeFile(entry, `import { Action } from '@stacksjs/actions'
import { createBroadcastHub } from '@stacksjs/realtime'
import { emit } from '@stacksjs/realtime/emit'
import { enhanceRequest, getCurrentRequest, runWithRequest } from '@stacksjs/router'
import { createBroadcastResponse } from '@stacksjs/realtime/stream'
let selected
const action = new Action({ name: 'NativeStreamProbe', method: 'GET', handle: request => {
  const original = selected
  const current = () => { if (getCurrentRequest() !== request) throw new Error('Compiled native subscriber request context was lost') }
  return createBroadcastResponse({ ...original,
    authorize() { current(); return original.authorize.call(original) },
    onEnqueue(chunk, metadata) { current(); original.onEnqueue.call(original, chunk, metadata) },
    onClose() { current(); original.onClose.call(original) },
  })
} })
export default action
export function open(options) {
  selected = options
  createBroadcastHub()
  const request = enhanceRequest(new Request('https://native-stream.invalid/subscriber'))
  return runWithRequest(request, () => action.handle(request))
}
export function publish(channel, event, data) {
  const request = enhanceRequest(new Request('https://native-stream.invalid/publisher'))
  return runWithRequest(request, () => emit(channel, event, data))
}
`)
    const built = await Bun.build({ root: join(process.cwd(), 'app'), entrypoints: [entry], outdir, target: 'bun', format: 'esm', splitting: false, external: ['@swc/wasm'] })
    assert(built.success, built.logs.map(String).join('\n'))
    await cp(outdir, copied, { recursive: true })
    module = join(copied, 'Actions/NativeStreamProbe.js')
    await qualifyPortableNativeStreamAction(module, entry)
  }
  const loaded = await import(module) as typeof import('@stacksjs/realtime/stream') & { open: typeof import('@stacksjs/realtime/stream').createBroadcastResponse, publish: typeof emit, default: { name: string } }
  const createBroadcastResponse = mode === 'artifact' ? loaded.open : loaded.createBroadcastResponse
  if (mode === 'artifact') { assert.equal(loaded.default.name, 'NativeStreamProbe'); publish = loaded.publish }
  const core = await import('../../../resources/functions/drone/public-safety/execution/service')
  const { runExecutionCheck } = await import('../../../resources/functions/drone/public-safety/execution/policy')
  const { readWorkspaceAccess } = await import('../../../resources/functions/drone/public-safety/workspace/policy')
  const seeded = await f.seed(`native-stream-${mode}`)
  const context = await f.as(f.senderToken, async () => core.captureExecutionContext(seeded.key))
  const observed: { chunk: Uint8Array, metadata: BroadcastStreamMetadata | null }[] = []
  const identities = new AsyncLocalStorage<string>()
  const callbacks: string[] = []
  if (mode === 'source') createBroadcastHub()
  const options: BroadcastStreamOptions = {
    channels: ['private-native-stream-fixture'], maxPending: 2, heartbeatMs: 20,
    async authorize() {
      assert.equal(this, options)
      callbacks.push(identities.getStore()!)
      await runExecutionCheck(context, () => readWorkspaceAccess(seeded.key))
      return true
    },
    onEnqueue(chunk, metadata) { assert.equal(this, options); callbacks.push(identities.getStore()!); observed.push({ chunk, metadata }) },
    onClose() { assert.equal(this, options); callbacks.push(identities.getStore()!); closed++ },
  }
  const response = await identities.run('subscriber', () => createBroadcastResponse(options))
  assert.equal(response.status, 200)
  reader = response.body!.getReader()
  const connected = await reader.read()
  assert.equal(observed[0]!.chunk, connected.value)
  assert.equal(observed[0]!.metadata, null)
  const original = { view: 'same-installed-hub' }
  identities.run('publisher', () => publish('private-native-stream-fixture', 'execution', original))
  const application = await reader.read()
  assert.equal(observed[1]!.chunk, application.value)
  assert.equal(observed[1]!.metadata!.data, original)
  assert.equal(observed[1]!.metadata!.channel, 'private-native-stream-fixture')
  assert.equal(observed[1]!.metadata!.event, 'execution')
  const heartbeat = await reader.read()
  assert.equal(observed[2]!.chunk, heartbeat.value)
  assert.equal(observed[2]!.metadata, null)
  await identities.run('canceller', () => reader!.cancel())
  await reader.cancel()
  assert.equal(closed, 1)
  assert(callbacks.length >= 7)
  assert(callbacks.every(value => value === 'subscriber'), 'Real native authorization and observers retain subscriber ALS across installed publisher/canceller contexts')
  console.log(`PASS native execution stream compatibility ${mode} same hub and subscriber context`)
}
finally {
  await reader?.cancel().catch(() => {})
  await f.database.closeDatabaseConnection()
}
