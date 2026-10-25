import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runBoundedHostProcess } from '../../resources/functions/host/process'

/** A fresh process may load the copied Action, its own manifest and platform builtins only. */
export async function qualifyPortableNativeStreamAction(artifact: string, originalEntry: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'drone-native-stream-portable-'))
  let completed = false
  try {
    await cp(artifact, join(directory, 'probe.mjs'))
    const config = join(directory, 'bunfig.toml')
    await writeFile(config, 'preload=[]\n[install]\nauto="disable"\n')
    await writeFile(join(directory, 'package.json'), '{"type":"module","private":true}')
    const entry = join(directory, 'qualify.mjs')
    await writeFile(entry, `import assert from 'node:assert/strict'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
const watchdog = setTimeout(() => { console.error('Portable Action fixture exceeded its local bound'); process.exit(97) }, 12000)
const artifact = fileURLToPath(new URL('./probe.mjs', import.meta.url))
const manifest = fileURLToPath(new URL('./package.json', import.meta.url))
const denied = []
Bun.plugin({ name: 'native-artifact-only', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => {
    if (args.path.startsWith('node:') || args.path.startsWith('bun:') || args.path === 'bun' || builtinModules.includes(args.path)) return
    if (args.path === './probe.mjs' || args.path === artifact) return { path: artifact }
    if (args.path === './package.json' || args.path === manifest) return { path: manifest }
    denied.push(args.path)
    throw new Error('Portable Action module fallback denied: ' + args.path)
  })
} })
// Bare package names can bypass runtime plugin hooks. Actual lookup must also
// fail in this dependency-free directory with installation disabled.
const forbiddenPackage = '@stacksjs/realtime/stream'
await assert.rejects(import(forbiddenPackage), error => (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error).includes("'@stacksjs/realtime'")) || String(error).includes('Portable Action module fallback denied:'))
const source = ${JSON.stringify(originalEntry)}
await assert.rejects(import(source), error => String(error).includes('Portable Action module fallback denied:'))
assert(denied.includes(source), 'The runtime guard must deny the actual original Action source file')
const deniedBeforeArtifact = denied.length
const loaded = await import(artifact)
assert.equal(loaded.default.name, 'NativeStreamProbe')
let deniedEnqueues = 0
const rejected = await loaded.open({ channels: ['private-portable-denied'], authorize: () => false, onEnqueue() { deniedEnqueues++ } })
assert.equal(rejected.status, 401)
assert.equal(deniedEnqueues, 0)
let authorized = true, closed = 0
const observed = []
const options = {
  channels: ['private-portable-native'], maxPending: 2, heartbeatMs: 10000,
  authorize() { assert.equal(this, options); return authorized },
  onEnqueue(chunk, metadata) { assert.equal(this, options); observed.push({ chunk, metadata }) },
  onClose() { assert.equal(this, options); closed++ },
}
const response = await loaded.open(options)
assert.equal(response.status, 200)
const reader = response.body.getReader()
try {
  const connected = await reader.read()
  assert.equal(connected.value, observed[0].chunk)
  assert.equal(observed[0].metadata, null)
  const original = { view: 'copied-native-action' }
  loaded.publish('private-portable-native', 'execution', original)
  const event = await reader.read()
  assert.equal(event.value, observed[1].chunk)
  assert.equal(observed[1].metadata.data, original)
  authorized = false
  loaded.publish('private-portable-native', 'execution', { denied: true })
  assert.equal((await reader.read()).done, true)
  assert.equal(closed, 1)
  loaded.publish('private-portable-native', 'execution', { afterClose: true })
  assert.equal(observed.length, 2)
  await reader.cancel()
  assert.equal(closed, 1)
  assert.equal(denied.length, deniedBeforeArtifact, 'The copied Action must not import source or installed dependencies')
}
finally { await reader.cancel() }
clearTimeout(watchdog)
console.log('PASS portable native Action module fallback denial, authority and close cleanup')
`)
    const result = await runBoundedHostProcess([process.execPath, '--no-install', `--config=${config}`, '--no-env-file', entry], {
      cwd: directory,
      env: { PATH: dirname(process.execPath), TMPDIR: directory, APP_ENV: 'test', NODE_ENV: 'test', BUN_INSTALL_CACHE_DIR: join(directory, 'empty-cache') },
      timeoutMs: 15000, stdoutBytes: 16384, stderrBytes: 8192, strictUtf8: true, label: 'Portable native Action',
    })
    await writeFile(join(directory, 'original.stdout'), result.stdout)
    await writeFile(join(directory, 'original.stderr'), result.stderr)
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`)
    assert(result.stdout.includes('PASS portable native Action module fallback denial, authority and close cleanup'))
    console.log(result.stdout.trim())
    completed = true
  }
  catch (error) {
    await writeFile(join(directory, 'failure.txt'), String(error)).catch(() => {})
    console.error(`NATIVE_STREAM_PORTABLE_RETAINED ${directory}`)
    throw error
  }
  finally { if (completed) await rm(directory, { recursive: true }) }
}
