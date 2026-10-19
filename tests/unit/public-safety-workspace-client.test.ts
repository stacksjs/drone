import { expect, test } from 'bun:test'
import { openIncidentWorkspace } from '../../resources/functions/drone/public-safety/workspace/client'
import type { WorkspaceSnapshot } from '../../resources/functions/drone/public-safety/workspace/types'
import type { BroadcastStreamClientOptions } from '@stacksjs/stx/composables/use-broadcast-stream'
import { workspaceCaptures, workspaceCapturePreview, workspacePixel } from '../../resources/functions/drone/public-safety/workspace/images'
import type { SourceRead } from '../../resources/functions/drone/public-safety/access/record-types'

// Controlled HTTP transport catches browser generation/retry behavior, not native Auth or SQL.
const snapshot = (accountId = 1, scope = 'scope-a') => ({ profile: 'incident-workspace-v1', scope, viewer: { accountId, canCoordinate: false }, throughSequence: 4, availableUntil: new Date(Date.now() + 60000).toISOString(), incident: { key: 'incident-a', version: 4, status: 'active', membership: { role: 'observer', version: 1 } }, sources: { entries: [], cursor: 0, hasMore: false }, selected: null, handover: { offer: null, briefing: null, actionability: { canOffer: false, canAccept: false, canDecline: false, canCancel: false } }, recipients: null, actions: { canObserve: false, canReview: false } }) as unknown as WorkspaceSnapshot
const settle = () => new Promise(resolve => setTimeout(resolve, 10))

test('workspace subscribes before reading and discards delayed old-identity responses', async () => {
  const callbacks: Array<{ onConnected?: () => void, onStatus?: (value: boolean) => void }> = []
  const pending: Array<(response: Response) => void> = []
  const paths: string[] = []
  const model = openIncidentWorkspace({ request: async (path, init) => {
    paths.push(String(path))
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /)
    return new Promise<Response>(resolve => pending.push(resolve))
  }, stream: options => { callbacks.push(options); return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'first-private-token')
    expect(paths).toEqual([])
    callbacks[0]!.onConnected?.()
    expect(paths).toHaveLength(1)
    model.connect('incident-a', 'second-private-token')
    callbacks[1]!.onConnected?.()
    pending[1]!(Response.json(snapshot(2)))
    await settle()
    expect(model.get().snapshot?.viewer.accountId).toBe(2)
    pending[0]!(Response.json(snapshot(1)))
    await settle()
    expect(model.get().snapshot?.viewer.accountId).toBe(2)
    expect(JSON.stringify(model.get())).not.toContain('private-token')
    model.disconnect()
    expect(model.get().snapshot).toBeNull()
  }
  finally { model.close() }
})

test('handover uses its own displayed source acknowledgement and retries only the exact scoped request', async () => {
  let events!: BroadcastStreamClientOptions, fail = true
  const writes: string[] = [], data = snapshot()
  const acknowledgement = { assignment: 'incident-coordination', offerDigest: 'b'.repeat(64), sourceDigest: 'c'.repeat(64), contextThroughSequence: 7, uncertaintyAcknowledged: true }
  data.viewer.canCoordinate = true
  data.selected = { source: { digest: 'a'.repeat(64) } } as unknown as WorkspaceSnapshot['selected']
  data.handover = { offer: { key: '80000000-0000-4000-8000-000000000001' }, actionability: { canAccept: true }, briefing: { acknowledgementRequired: acknowledgement } } as unknown as WorkspaceSnapshot['handover']
  const model = openIncidentWorkspace({ request: async (path, init) => {
    if (init?.method === 'POST') { writes.push(String(init.body)); if (fail) throw new Error('Unknown after possible commit'); return Response.json({ replayed: true }) }
    return Response.json(data)
  }, stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private'); events.onConnected?.(); await settle()
    expect(await model.decide('accept', false)).toBe(false)
    expect(writes).toHaveLength(0)
    expect(await model.decide('accept', true)).toBe(false)
    expect(JSON.parse(writes[0]!).acknowledgement).toEqual(acknowledgement)
    expect(model.get().canRetryHandover).toBe(true)
    fail = false
    expect(await model.retryHandover()).toBe(true)
    expect(writes[1]).toBe(writes[0])
    model.disconnect()
    expect(await model.retryHandover()).toBe(false)
  }
  finally { model.close() }
})

test('source previews preserve original support and refuse invented image dimensions', () => {
  const source = { recording: { evidence: 'owned-public-safety-physics-simulation', physicalFlightEnabled: false, physicalThermalVerified: false, identityAuthenticated: false, survey: { captures: [{ id: 'photo-0001', width: 3, height: 1, rgba: [2, 3, 4, 255, 0, 0, 0, 255, 0, 0, 0, 255] }] }, captures: [{ width: 3, height: 1, support: [1, 0, 2], thermalCentiKelvin: [30000, 0, 0] }] } } as unknown as SourceRead
  const capture = workspaceCaptures(source)[0]!
  expect(workspacePixel(capture, 0, 0)).toContain('Observed synthetic ground')
  expect(workspacePixel(capture, 1, 0)).toContain('Unknown or unobserved')
  expect(workspacePixel(capture, 2, 0)).toContain('Privacy masked')
  expect(workspaceCapturePreview(capture, 'visible')).toContain('data:image/svg+xml,')
  expect(workspaceCapturePreview(capture, 'thermal')).not.toBe(workspaceCapturePreview(capture, 'visible'))
  const bad = structuredClone(source) as any
  bad.recording.survey.captures[0].width = 900000
  expect(() => workspaceCaptures(bad)).toThrow('Invalid source image size')
})

test('workspace scope changes and refusals discard the active credential and private state', async () => {
  let events!: BroadcastStreamClientOptions, current = snapshot(), reads = 0
  const model = openIncidentWorkspace({ request: async () => { reads++; return Response.json(current) }, stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'volatile-credential'); events.onConnected?.(); await settle()
    expect(model.get().status).toBe('current')
    current = snapshot(1, 'another-incarnation')
    await model.refresh()
    expect(model.get().status).toBe('refused')
    expect(model.get().snapshot).toBeNull()
    const before = reads
    await model.refresh()
    expect(reads).toBe(before)
    expect(JSON.stringify(model.get())).not.toContain('volatile-credential')
  }
  finally { model.close() }
})

test('native refresh hints trigger immediate coalesced snapshots before periodic polling', async () => {
  let events!: BroadcastStreamClientOptions, reads = 0
  const pending: Array<(response: Response) => void> = []
  const model = openIncidentWorkspace({ request: async () => { reads++; return new Promise<Response>(resolve => pending.push(resolve)) }, stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private'); events.onConnected?.()
    pending[0]!(Response.json(snapshot())); await settle()
    expect(reads).toBe(1)
    events.onMessage({ channel: 'server-selected', event: 'refresh', data: { refresh: true } })
    expect(reads).toBe(2)
    for (let index = 0; index < 10; index++) events.onMessage({ channel: 'server-selected', event: 'refresh', data: { refresh: true } })
    expect(reads).toBe(2)
    pending[1]!(Response.json(snapshot())); await settle()
    expect(reads).toBe(3)
    pending[2]!(Response.json(snapshot())); await settle()
    expect(reads).toBe(3)
  }
  finally { model.close() }
})

test('observation outcome-unknown never retries and 409 requires a fresh explicit submission', async () => {
  let events!: BroadcastStreamClientOptions, writes = 0, conflict = false
  const data = snapshot()
  const digest = 'a'.repeat(64)
  data.viewer.canCoordinate = true
  data.actions.canObserve = true
  data.selected = { source: { digest }, entries: [], cursor: null, hasMore: false } as unknown as WorkspaceSnapshot['selected']
  const model = openIncidentWorkspace({ request: async (path, init) => {
    if (path.endsWith(`/sources/${digest}`)) return Response.json({ source: { digest }, recording: null })
    if (init?.method === 'POST') { writes++; if (conflict) return Response.json({ error: 'conflict' }, { status: 409 }); throw new Error('Connection ended after possible commit') }
    return Response.json(data)
  }, stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private'); events.onConnected?.(); await settle(); await model.loadSource()
    const draft = { captureId: 'photo-0001', modality: 'visible' as const, x: 1, y: 2, note: 'Human declaration', uncertaintyNote: 'Unresolved source uncertainty' }
    expect(await model.observe(draft)).toBe(false)
    expect(writes).toBe(1)
    expect(model.get().confirmationRequired).toBe(true)
    expect(model.get().canRetryHandover).toBe(false)
    await model.refresh()
    expect(writes).toBe(1)
    expect(await model.observe(draft)).toBe(false)
    model.confirmCurrentContext(); conflict = true
    expect(await model.observe(draft)).toBe(false)
    expect(writes).toBe(2)
    expect(model.get().confirmationRequired).toBe(true)
    expect(model.get().error).toContain('context changed')
  }
  finally { model.close() }
})


test('recipient selection binds the displayed membership generation and role', async () => {
  let events!: BroadcastStreamClientOptions, writes = 0
  const data = snapshot(), selected = { userId: 2, role: 'reviewer' as const, membershipVersion: 1 }
  data.selected = { source: { digest: 'a'.repeat(64) } } as unknown as WorkspaceSnapshot['selected']
  data.recipients = { entries: [selected], cursor: 2, hasMore: false }
  data.handover.actionability.canOffer = true
  const model = openIncidentWorkspace({ request: async (_path, init) => { if (init?.method === 'POST') writes++; return Response.json(init?.method === 'POST' ? {} : data) }, stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private'); events.onConnected?.(); await settle()
    expect(await model.offer(selected, 'observer', 300)).toBe(true)
    expect(writes).toBe(1)
    data.recipients.entries = [{ ...selected, membershipVersion: 3 }]
    await model.refresh()
    expect(await model.offer(selected, 'observer', 300)).toBe(false)
    expect(writes).toBe(1)
    expect(await model.offer(data.recipients.entries[0]!, 'observer', 300)).toBe(true)
    data.recipients.entries = [{ ...selected, membershipVersion: 3, role: 'observer' }]
    await model.refresh()
    expect(await model.offer({ ...selected, membershipVersion: 3 }, 'observer', 300)).toBe(false)
    expect(writes).toBe(2)
  }
  finally { model.close() }
})

test('ordinary refresh and stream renewal preserve drafts while changed viewer authority invalidates them', async () => {
  let events!: BroadcastStreamClientOptions
  const data = snapshot()
  const model = openIncidentWorkspace({ request: async () => Response.json(data), stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private'); events.onConnected?.(); await settle()
    const initial = model.get().reset
    data.incident.version++; data.throughSequence++
    await model.refresh()
    expect(model.get().reset).toBe(initial)
    events.onStatus?.(false)
    expect(model.get().snapshot).toBeNull()
    expect(model.get().reset).toBe(initial)
    events.onConnected?.(); await settle()
    expect(model.get().status).toBe('current')
    expect(model.get().reset).toBe(initial)
    data.incident.membership.version++
    await model.refresh()
    expect(model.get().reset).toBe(initial + 1)
    data.viewer.canCoordinate = true
    await model.refresh()
    expect(model.get().reset).toBe(initial + 2)
    model.disconnect()
    expect(model.get().reset).toBe(initial + 3)
  }
  finally { model.close() }
})

test('review drafts cannot move to another original or a different review head, including a pending target switch', async () => {
  let events!: BroadcastStreamClientOptions, writes = 0, head: number | null = null
  const data = snapshot(), digest = 'a'.repeat(64)
  data.selected = { source: { digest } } as unknown as WorkspaceSnapshot['selected']
  data.actions.canReview = true
  let release: (() => void) | undefined
  const model = openIncidentWorkspace({ request: async (path, init) => {
    if (init?.method === 'POST') { writes++; return Response.json({}) }
    if (path.endsWith('/observations/2')) await new Promise<void>(resolve => { release = resolve })
    if (/\/observations\/\d+\/reviews\?/.test(path)) return Response.json({ entries: head === null ? [] : [{ id: head }], cursor: head ?? 0, hasMore: false })
    const match = path.match(/\/observations\/(\d+)$/)
    if (match) return Response.json({ id: Number(match[1]), sourceDigest: digest, note: `Original ${match[1]}`, uncertaintyNote: 'Original uncertainty' })
    return Response.json(data)
  }, stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private'); events.onConnected?.(); await settle()
    await model.loadReviews(1)
    const original = model.reviewBinding()!, draft = { disposition: 'unresolved' as const, note: 'Draft for original one' }
    const pendingSwitch = model.loadReviews(2)
    expect(model.get().reviewTarget).toBe(2)
    expect(model.get().reviews).toBeNull()
    expect(await model.review(draft, original)).toBe(false)
    release!(); await pendingSwitch
    expect(await model.review(draft, original)).toBe(false)
    expect(writes).toBe(0)
    expect(model.get().confirmationRequired).toBe(true)
    model.confirmCurrentContext()
    const second = model.reviewBinding()!
    head = 9
    const nextPage = model.loadReviews(2, 5); release!(); await nextPage
    // Repeat without delayed transport: the same-target page returns the current head.
    expect(model.get().reviewTarget).toBe(2)
    expect(await model.review(draft, second)).toBe(false)
    expect(writes).toBe(0)
  }
  finally { release?.(); model.close() }
})

test('an expired scope-bound context cursor fails closed without repeated stale reads', async () => {
  let events!: BroadcastStreamClientOptions, reads = 0
  const data = snapshot()
  data.selected = { source: { digest: 'a'.repeat(64) }, cursor: 'prior-process-signed-cursor', hasMore: true } as unknown as WorkspaceSnapshot['selected']
  const model = openIncidentWorkspace({ request: async path => { reads++; return path.includes('contextCursor=') ? Response.json({ error: 'Invalid context cursor' }, { status: 422 }) : Response.json(data) }, stream: options => { events = options; return { close() {} } }, refreshMs: 60000 })
  try {
    model.connect('incident-a', 'private'); events.onConnected?.(); await settle()
    const reset = model.get().reset
    model.page('context'); await settle()
    expect(model.get().status).toBe('refused')
    expect(model.get().snapshot).toBeNull()
    expect(model.get().reset).toBe(reset + 1)
    const stopped = reads
    events.onConnected?.(); events.onMessage({ channel: 'server-selected', event: 'refresh', data: { refresh: true } })
    await model.refresh()
    expect(reads).toBe(stopped)
    model.connect('incident-a', 'explicit-new-credential'); events.onConnected?.(); await settle()
    expect(model.get().status).toBe('current')
  }
  finally { model.close() }
})
