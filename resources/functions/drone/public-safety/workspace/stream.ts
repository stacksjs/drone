import { AsyncResource } from 'node:async_hooks'
import { createBroadcastHub, createBroadcastResponse, getReplayBuffer } from '@stacksjs/realtime'
import { getCurrentRequest, runWithRequest } from '@stacksjs/router'
import limits from '../../../../../config/workspace'
import { PublicSafetyAccessError } from '../access/errors'
import { associateIncidentDeadline } from '../access/deadline'
import { privateHeaders } from '../access/http'
import { readWorkspaceAccess } from './policy'
import { workspaceRefreshChannel } from './updates'

let connections = 0, pendingChecks = 0
const accounts = new Map<number, number>(), incidents = new Map<number, number>()
const headers = { ...privateHeaders, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' }

function requireUnbuffered(channel: string): void {
  const bare = channel.replace(/^(?:private|presence)-/, '')
  const matches = (pattern: string, name: string) => pattern === '*' || pattern === name || pattern.endsWith('.*') && name.startsWith(pattern.slice(0, -1))
  if (getReplayBuffer()?.channels.some(pattern => matches(pattern, channel) || matches(pattern, bare))) throw new PublicSafetyAccessError(409, 'Workspace replay is unavailable')
}

/** Capture ALL async stores before the first native read, not the broadcaster's ORM scope. */
export function captureWorkspaceCheck(key: string) {
  const subscriber = getCurrentRequest()
  if (!subscriber) throw new PublicSafetyAccessError(401, 'A valid incident access token is required')
  let expectedScope: string | undefined
  const current = AsyncResource.bind(async () => runWithRequest(subscriber, async () => {
    const access = await readWorkspaceAccess(key, expectedScope)
    expectedScope ??= access.scope
    requireUnbuffered(workspaceRefreshChannel(access.incidentId))
    return access
  }))
  return async () => {
    if (pendingChecks >= limits.pendingChecks) throw new PublicSafetyAccessError(409, 'Workspace checks are busy')
    pendingChecks++
    const pending = current().finally(() => { pendingChecks-- })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([pending, new Promise<never>((resolve, reject) => {
        void resolve
        timer = setTimeout(() => reject(new PublicSafetyAccessError(404, 'Incident is unavailable')), limits.checkTimeoutMs)
      })])
    }
    finally { clearTimeout(timer) }
  }
}

export async function openIncidentWorkspaceStream(check: ReturnType<typeof captureWorkspaceCheck>, signal: AbortSignal, head = false): Promise<Response> {
  const initial = await check()
  if (head) return associateIncidentDeadline(new Response(null, { headers }), initial.deadline)
  const accountCount = accounts.get(initial.accountId) ?? 0, incidentCount = incidents.get(initial.incidentId) ?? 0
  if (connections >= limits.globalConnections || accountCount >= limits.accountConnections || incidentCount >= limits.incidentConnections) return Response.json({ error: 'Workspace connections are busy' }, { status: 429, headers: privateHeaders })
  connections++; accounts.set(initial.accountId, accountCount + 1); incidents.set(initial.incidentId, incidentCount + 1)
  const abort = new AbortController(), deadline = Math.min(initial.deadline, Date.now() + limits.lifetimeMs)
  let ended = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (ended) return
    ended = true; clearTimeout(timer); signal.removeEventListener('abort', finish); abort.abort()
    connections--
    for (const [map, id] of [[accounts, initial.accountId], [incidents, initial.incidentId]] as const) {
      const count = (map.get(id) ?? 1) - 1
      if (count) map.set(id, count)
      else map.delete(id)
    }
    void reader?.cancel().catch(() => {})
  }
  signal.addEventListener('abort', finish, { once: true })
  timer = setTimeout(finish, Math.max(1, deadline - Date.now()))
  if (signal.aborted) finish()
  try {
    createBroadcastHub()
    const native = await createBroadcastResponse({ channels: [workspaceRefreshChannel(initial.incidentId)], authorize: async () => {
      if (ended) return false
      try { const current = await check(); return !ended && Date.now() < Math.min(deadline, current.deadline) }
      catch { finish(); return false }
    }, signal: abort.signal, heartbeatMs: limits.heartbeatMs, maxPending: limits.nativePending })
    if (!native.ok || !native.body || ended) { finish(); return new Response(null, { status: 404, headers: privateHeaders }) }
    reader = native.body.getReader()
    // Native framing stays opaque. Only one chunk can wait for current authority.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader!.read()
          if (chunk.done || ended) { finish(); controller.close(); return }
          if (chunk.value.byteLength > limits.frameBytes) { finish(); controller.close(); return }
          const current = await check()
          if (ended || Date.now() >= Math.min(deadline, current.deadline)) { finish(); controller.close(); return }
          controller.enqueue(chunk.value)
        }
        catch { finish(); try { controller.close() } catch { /* canceled */ } }
      },
      cancel() { finish() },
    }, { highWaterMark: 0 })
    return associateIncidentDeadline(new Response(body, { headers }), deadline)
  }
  catch (error) { finish(); throw error }
}
