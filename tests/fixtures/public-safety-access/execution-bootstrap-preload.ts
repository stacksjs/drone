import assert from 'node:assert/strict'

const hostWorker = globalThis.Worker
assert.equal(process.env.DRONE_EXECUTION_BOOTSTRAP_MARKER, 'nonsecret-native-parent-marker')
// Runtime preload uses vendored-source fallbacks that are absent in package apps.
// Load its actual file URL, as native boot does, without treating it as a typed API.
const nativePreload = new URL('../../../storage/framework/defaults/resources/plugins/preloader.ts', import.meta.url)
await import(nativePreload.href)
const { Auth } = await import('@stacksjs/auth/authentication')
const { db } = await import('@stacksjs/database/runtime')
const { getCurrentRequest } = await import('@stacksjs/router')
assert.equal(globalThis.Worker, hostWorker, 'Actual native auto-imports must preserve the host Bun Worker')
assert.equal(Reflect.get(globalThis, 'Auth'), Auth)
assert.equal(Reflect.get(globalThis, 'db'), db)
assert.equal(Reflect.get(globalThis, 'getCurrentRequest'), getCurrentRequest)
Reflect.set(globalThis, '__droneExecutionBootstrapParent', { Auth, db, getCurrentRequest, hostWorker })
