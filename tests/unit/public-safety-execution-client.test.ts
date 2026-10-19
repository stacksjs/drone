import { expect, test } from 'bun:test'
import type { BroadcastStreamClientOptions } from '@stacksjs/stx/composables/use-broadcast-stream'
import type { ExecutionView } from '../../resources/functions/drone/public-safety/execution/types'
import { openIncidentExecution } from '../../resources/functions/drone/public-safety/execution/client'

// Controlled transport exercises caller generations and uncertain outcomes, not native policy.
const scope = 'a'.repeat(64)
const completed = (intent: string, phase: ExecutionView['phase'] = 'completed'): ExecutionView => ({ execution: '80000000-0000-4000-8000-000000000001', intent, scope, profile: 'owned-public-safety-collection-v1', phase, reason: null, producer: phase === 'completed' ? 'finished' : 'pending', scenario: 'nominal', requestedSeconds: 100, startedAt: new Date().toISOString(), availableUntil: new Date(Date.now() + 60000).toISOString(), latestEvent: null, completion: phase === 'completed' ? { digest: 'b'.repeat(64), byteLength: 4000, eventCount: 10, epochCount: 9, captureCount: 1, virtualTimeMs: 500, surveyStatus: 'completed', faultDemonstrated: false } : null, admission: 'unsubmitted', identityAuthenticated: true, sourceIdentityAuthenticated: false, physicalFlightEnabled: false, physicalThermalVerified: false })
const context = { available: true, scope, canMutate: true, version: 4, catalogDigests: [] as string[] }

test('an uncertain start reconciles its original intent through GET without retrying POST', async () => {
  let writes = 0, intent = '', found: ExecutionView | null = null
  const model = openIncidentExecution({ endpoint: () => '/api/public-safety/incidents/a/workspace/execution', request: async (_path, init) => {
    if (init?.method === 'POST') { writes++; intent = JSON.parse(String(init.body)).intent; throw new Error('response lost') }
    return Response.json(found)
  }, stream: () => ({ close() {} }), refreshWorkspace: async () => {} })
  model.sync(context)
  expect(await model.start('nominal', 100)).toBe(false)
  expect(model.get().error).toContain('Outcome unknown')
  expect(writes).toBe(1)
  expect(await model.start('nominal', 100)).toBe(false)
  found = completed(intent)
  await model.refresh()
  expect(model.get().execution?.intent).toBe(intent)
  expect(writes).toBe(1)
  expect(model.get().execution?.admission).toBe('unsubmitted')
  model.close()
})

test('late status and stream callbacks cannot restore cleared progress or recur on native close', async () => {
  let events!: BroadcastStreamClientOptions, resolveStatus!: (value: Response) => void, intent = '', closes = 0
  const model = openIncidentExecution({ endpoint: () => '/execution', request: async (_path, init) => {
    if (init?.method === 'POST') { intent = JSON.parse(String(init.body)).intent; return Response.json(completed(intent, 'running')) }
    return new Promise<Response>(resolve => { resolveStatus = resolve })
  }, stream: options => { events = options; return { close() { closes++; options.onStatus?.(false) } } }, refreshWorkspace: async () => {} })
  model.sync(context)
  expect(await model.start('nominal', 100)).toBe(true)
  const current = model.get().execution
  // The GET issued before the start must not replace its newer successful result.
  resolveStatus(Response.json(null)); await Bun.sleep(1)
  expect(model.get().execution).toEqual(current)
  model.clear()
  events.onConnected?.(); events.onMessage({ channel: 'server', event: 'execution', data: completed(intent) })
  expect(model.get().execution).toBeNull()
  expect(model.get().connected).toBe(false)
  expect(closes).toBe(1)
  model.close()
})

test('explicit admission uses the current click revision and uncertain outcomes only reconcile digest existence', async () => {
  let intent = '', writes = 0, refreshes = 0, body: any
  let latest = { ...context }
  const model = openIncidentExecution({ endpoint: () => '/execution', request: async (path, init) => {
    if (init?.method !== 'POST') return Response.json(intent ? completed(intent) : null)
    writes++
    if (path.endsWith('/admission')) { body = JSON.parse(String(init.body)); throw new Error('write response lost') }
    intent = JSON.parse(String(init.body)).intent; return Response.json(completed(intent))
  }, stream: () => ({ close() {} }), refreshWorkspace: async () => {
    refreshes++
    latest = { ...latest, version: 19, catalogDigests: refreshes > 1 ? ['b'.repeat(64)] : [] }
    model.sync(latest)
  } })
  try {
    model.sync(latest)
    expect(await model.start('nominal', 100)).toBe(true)
    expect(await model.admit()).toBe(false)
    expect(body.expectedVersion).toBe(19)
    expect(model.get().unknownAdmission).toBe(true)
    expect(model.get().sourceExists).toBe(true)
    expect(model.get().error).toContain('does not establish which request')
    expect(await model.admit()).toBe(false)
    expect(writes).toBe(2)
    expect(model.get().execution?.admission).toBe('unsubmitted')
  }
  finally { model.close() }
})

test('stream renewal only observes the same run and read-only contexts cannot mutate', async () => {
  const callbacks: BroadcastStreamClientOptions[] = []
  let intent = '', writes = 0, reads = 0
  const model = openIncidentExecution({ endpoint: () => '/execution', request: async (_path, init) => {
    if (init?.method === 'POST') { writes++; intent = JSON.parse(String(init.body)).intent; return Response.json(completed(intent, 'running')) }
    reads++; return Response.json(intent ? completed(intent, 'running') : null)
  }, stream: options => { callbacks.push(options); return { close() { options.onStatus?.(false) } } }, refreshWorkspace: async () => {} })
  try {
    model.sync(context)
    await model.start('nominal', 120)
    callbacks[0]!.onStatus?.(false); callbacks[0]!.onConnected?.()
    expect(writes).toBe(1)
    model.sync({ ...context, available: false })
    expect(model.get().execution).toBeNull()
    expect(model.get().hasReservation).toBe(true)
    callbacks[0]!.onMessage({ channel: 'server', event: 'execution', data: completed(intent) })
    expect(model.get().execution).toBeNull()
    model.sync(context); await model.refresh()
    expect(model.get().execution?.phase).toBe('running')
    expect(writes).toBe(1)
    expect(reads).toBe(2)
    model.sync({ ...context, canMutate: false })
    expect(await model.stop()).toBe(false)
    expect(await model.admit()).toBe(false)
    model.clear()
    expect(await model.start('nominal', 100)).toBe(false)
  }
  finally { model.close() }
})

test('a start response after disconnect cannot restore private results', async () => {
  let release!: (value: Response) => void, intent = ''
  const model = openIncidentExecution({ endpoint: () => '/execution', request: async (_path, init) => {
    if (init?.method !== 'POST') return Response.json(null)
    intent = JSON.parse(String(init.body)).intent
    return new Promise<Response>(resolve => { release = resolve })
  }, stream: () => ({ close() {} }), refreshWorkspace: async () => {} })
  try {
    model.sync(context)
    const request = model.start('nominal', 100)
    model.close()
    release(Response.json(completed(intent)))
    expect(await request).toBe(false)
    expect(model.get().execution).toBeNull()
    expect(model.get().busy).toBe(false)
    expect(JSON.stringify(model.get())).not.toContain(intent)
  }
  finally { model.close() }
})

test('acknowledged discarded finished work permits a new explicit intent, never an automatic start', async () => {
  const intents: string[] = []
  const model = openIncidentExecution({ endpoint: () => '/execution', request: async (path, init) => {
    if (init?.method !== 'POST') return Response.json(null)
    const body = JSON.parse(String(init.body))
    if (path.endsWith('/close')) return Response.json({ ...completed(intents[0]!), phase: 'discarded', completion: null })
    intents.push(body.intent); return Response.json(completed(body.intent))
  }, stream: () => ({ close() {} }), refreshWorkspace: async () => {} })
  try {
    model.sync(context)
    expect(await model.start('nominal', 100)).toBe(true)
    expect(await model.stop()).toBe(true)
    expect(model.get().execution).toBeNull()
    expect(intents).toHaveLength(1)
    expect(await model.start('camera-loss', 120)).toBe(true)
    expect(intents).toHaveLength(2)
    expect(intents[1]).not.toBe(intents[0])
  }
  finally { model.close() }
})

test('execution binding uses the parent volatile credential and preserves explicit source selection through completion', async () => {
  const { openIncidentWorkspace } = await import('../../resources/functions/drone/public-safety/workspace/client')
  const callbacks: BroadcastStreamClientOptions[] = []
  const selectedDigest = 'c'.repeat(64)
  const snapshot = { profile: 'incident-workspace-v1', scope, viewer: { accountId: 1, canCoordinate: true }, throughSequence: 4, availableUntil: new Date(Date.now() + 60000).toISOString(), incident: { key: 'incident-a', version: 4, status: 'active', membership: { role: 'pilot', version: 1 } }, sources: { entries: [{ digest: selectedDigest }], cursor: 0, hasMore: false }, selected: { source: { digest: selectedDigest } }, handover: { offer: null, briefing: null, actionability: {} }, recipients: null, actions: { canRegisterSource: true } }
  let intent = '', writes = 0
  const model = openIncidentWorkspace({ request: async (path, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-test-credential')
    expect(init?.cache).toBe('no-store')
    if (init?.method === 'POST') { writes++; intent = JSON.parse(String(init.body)).intent; return Response.json(completed(intent, 'running')) }
    if (path.includes('/execution?') && snapshot.incident.membership.version > 1) return Response.json({ error: 'Original owner generation unavailable' }, { status: 403 })
    return Response.json(path.includes('/execution?') ? intent ? completed(intent, 'running') : null : snapshot)
  }, stream: options => { callbacks.push(options); return { close() { options.onStatus?.(false) } } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private-test-credential'); callbacks[0]!.onConnected?.(); await Bun.sleep(10)
    expect(await model.execution.start('nominal', 100)).toBe(true)
    callbacks[1]!.onMessage({ channel: 'server', event: 'execution', data: completed(intent) })
    expect(model.execution.get().execution?.phase).toBe('completed')
    expect(model.get().snapshot?.selected?.source.digest).toBe(selectedDigest)
    expect(writes).toBe(1)
    expect(JSON.stringify(model.execution.get())).not.toContain('private-test-credential')
    snapshot.incident.membership.version++
    await model.refresh()
    expect(model.execution.get().execution).toBeNull()
    callbacks[1]!.onMessage({ channel: 'server', event: 'execution', data: completed(intent) })
    await Bun.sleep(10)
    expect(model.execution.get().execution).toBeNull()
    expect(model.get().status).toBe('refused')
  }
  finally { model.close() }
})

test('uncertain admission checks its digest beyond the currently paged catalog without moving selection', async () => {
  let intent = '', checked = '', checks = 0
  const model = openIncidentExecution({ endpoint: () => '/execution', request: async (path, init) => {
    if (init?.method !== 'POST') return Response.json(null)
    if (path.endsWith('/admission')) return Response.json({ error: 'Withheld' }, { status: 503 })
    intent = JSON.parse(String(init.body)).intent; return Response.json(completed(intent))
  }, stream: () => ({ close() {} }), refreshWorkspace: async () => {}, sourceExists: async hash => { checks++; checked = hash; return true } })
  try {
    model.sync(context); await model.start('nominal', 100)
    expect(await model.admit()).toBe(false)
    expect(model.get().sourceExists).toBe(true)
    expect(checked).toBe('b'.repeat(64))
    expect(checks).toBe(1)
    expect(model.get().unknownAdmission).toBe(true)
  }
  finally { model.close() }
})
