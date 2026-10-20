import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { isInTransaction } from '@stacksjs/database/runtime'

interface Input { path: string, body: unknown, credential: string, ownerId: number, ability: string, gateCount: number }
let initialize!: (value: Input) => void, release!: () => void
const initial = new Promise<Input>(resolve => { initialize = resolve })
process.on('message', (message: { kind?: string, input?: Input }) => {
  if (message.kind === 'init') initialize(message.input!)
  if (message.kind === 'go') release()
})
process.send?.({ kind: 'ready-input', pid: process.pid })

async function main() {
  const input = await initial, root = process.cwd(), source = resolve(import.meta.dir, '../../..')
  assert(basename(root).startsWith('drone-patrol-review-'))
  assert.equal(realpathSync(process.env.DB_DATABASE_PATH!), join(realpathSync(root), 'review.sqlite'))
  // Parent already prepared the actual native model/config/middleware files once.
  // Children initialize independent native connections without racing filesystem rewrites/migrations.
  const { overridesReady } = await import('@stacksjs/config')
  await overridesReady
  const database = await import('@stacksjs/database')
  await database.ensureDatabaseConfigLoaded()
  database.initializeDbConfig({ app: { env: 'test' }, database: { default: 'sqlite', connections: { sqlite: { database: process.env.DB_DATABASE_PATH } }, queryLogging: { enabled: false } } })
  await (await import('@stacksjs/orm')).ormReady
  await (await import('@stacksjs/auth/policy')).initializeAuthorization()
  const nativeErrors: { source: string, name: string | null, code: string | null, errno: number | null, status: number | null }[] = []
  const observeError = (source: string, error: unknown) => {
    if (nativeErrors.length >= 8) return
    const field = (name: string) => error && typeof error === 'object' ? Reflect.get(error, name) : null
    const text = (value: unknown) => typeof value === 'string' && value.length <= 64 ? value : null
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
    nativeErrors.push({ source, name: text(field('name')), code: text(field('code')), errno: number(field('errno')), status: number(field('status')) })
  }
  database.db.primary.setTransactionDefaults({ onRollback: error => observeError('native-onRollback', error) })
  const { registerPersistentQueryHooks } = await import('@stacksjs/query-builder')
  const unhook = registerPersistentQueryHooks({ onQueryError: event => observeError('native-onQueryError', event.error) })
  const { Gate } = await import('@stacksjs/auth/gate')
  const { route } = await import('@stacksjs/router')
  await route.register(join(source, 'routes/api.ts'), { prefix: '/api' })
  let gates = 0, synchronized = false
  Gate.after(async (user, ability, allowed) => {
    if (ability !== input.ability) return
    gates++
    if (gates !== input.gateCount) return
    assert.equal(allowed, true)
    assert.equal(user?.id, input.ownerId)
    assert.equal(isInTransaction(), false)
    synchronized = true
    const go = new Promise<void>(resolve => { release = resolve })
    process.send?.({ kind: 'preflight', pid: process.pid, gates, beforeTransaction: true })
    await go
  })
  const server = await route.serve({ hostname: '127.0.0.1', port: 0, nativeRoutes: true })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}${input.path}`, { method: 'POST', headers: { authorization: `Bearer ${input.credential}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(input.body) })
    const text = await response.text()
    assert.equal(synchronized, true)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert(!text.includes(input.credential))
    // Only the bounded public receipt/error plus scalar synchronization facts.
    // eslint-disable-next-line no-console
    console.log(`RACE_RESULT ${JSON.stringify({ pid: process.pid, status: response.status, data: JSON.parse(text), gates, synchronized, nativeErrors })}`)
  }
  finally {
    await server.stop(true)
    unhook()
    database.db.primary.setTransactionDefaults({ onRollback: undefined })
    await database.closeDatabaseConnection()
    process.disconnect?.()
  }
}
void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error)
  process.exitCode = 1
  process.disconnect?.()
})
