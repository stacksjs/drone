import type { ExecutionContext } from './policy'
import type { ExecutionAttachment, ExecutionLocator, ExecutionView } from './types'
import { createBroadcastHub, getReplayBuffer } from '@stacksjs/realtime'
import { emit } from '@stacksjs/realtime/emit'
import { createBroadcastResponse } from '../../http/native-realtime/stream'
import limits from '../../../../../config/execution'
import { PublicSafetyAccessError } from '../access/errors'
import { associateIncidentDeadline, assertIncidentDeadline } from '../access/deadline'
import { privateHeaders } from '../access/http'
import { attachIncidentExecution } from './service'

const headers = { ...privateHeaders, 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' }
function requireUnbuffered(channel: string): void {
  const bare = channel.replace(/^(?:private|presence)-/, '')
  const matches = (pattern: string, name: string) => pattern === '*' || pattern === name || pattern.endsWith('.*') && name.startsWith(pattern.slice(0, -1))
  if (getReplayBuffer()?.channels.some(pattern => matches(pattern, channel) || matches(pattern, bare))) throw new PublicSafetyAccessError(409, 'Execution replay is unavailable')
}

/** Native frames remain opaque; the core owns original owner and subscriber policy. */
export async function openIncidentExecutionStream(context: ExecutionContext, locator: ExecutionLocator, signal: AbortSignal, preflightDeadline: number): Promise<Response> {
  const channel = `private-public-safety.execution.${locator.execution}`
  requireUnbuffered(channel)
  const abort = new AbortController()
  let attachment: ExecutionAttachment | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let ended = false, timer: ReturnType<typeof setTimeout> | undefined
  let pending: { value: ExecutionView, resolve: () => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> } | undefined
  let deadline = Math.min(preflightDeadline, Date.now() + limits.streamLifetimeMs)
  const finish = () => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    const waiting = pending
    pending = undefined
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error('Execution native consumer is unavailable')) }
    signal.removeEventListener('abort', finish)
    abort.abort()
    attachment?.release()
    void reader?.cancel().catch(() => {})
  }
  const check = async () => {
    if (ended || !attachment) throw new PublicSafetyAccessError(404, 'Execution is unavailable')
    requireUnbuffered(channel)
    // Core's shared pending-check budget remains charged until actual SQL settles.
    const value = await attachment.check()
    assertIncidentDeadline(value)
    const until = Date.parse(value.availableUntil)
    if (ended || !Number.isFinite(until) || Date.now() >= Math.min(deadline, until)) throw new PublicSafetyAccessError(404, 'Execution is unavailable')
    return value
  }
  signal.addEventListener('abort', finish, { once: true })
  try {
    if (signal.aborted) throw new PublicSafetyAccessError(404, 'Execution is unavailable')
    attachment = await attachIncidentExecution(context, locator, value => {
      if (ended || Date.now() >= Math.min(deadline, Date.parse(value.availableUntil))) throw new PublicSafetyAccessError(404, 'Execution is unavailable')
      requireUnbuffered(channel)
      if (pending) { finish(); throw new PublicSafetyAccessError(409, 'Execution observer is busy') }
      return new Promise<void>((resolve, reject) => {
        pending = { value, resolve, reject, timer: setTimeout(finish, limits.checkTimeoutMs) }
        try { emit(channel, 'execution', value) }
        catch { finish() }
      })
    })
    if (ended || signal.aborted) { attachment.release(); throw new PublicSafetyAccessError(404, 'Execution is unavailable') }
    deadline = Math.min(deadline, Date.parse(attachment.initial.availableUntil))
    timer = setTimeout(finish, Math.max(1, deadline - Date.now()))
    createBroadcastHub()
    requireUnbuffered(channel)
    const native = await createBroadcastResponse({ channels: [channel], authorize: async () => {
      try { await check(); return !ended }
      catch { finish(); return false }
    }, signal: abort.signal, heartbeatMs: limits.heartbeatMs, maxPending: limits.nativePending,
    onEnqueue(chunk, broadcast) {
      if (ended || chunk.byteLength > limits.frameBytes || Date.now() >= deadline) { finish(); throw new PublicSafetyAccessError(404, 'Execution is unavailable') }
      // Native connected/heartbeat frames have null metadata. Only this exact
      // application view's successful local enqueue can settle its private credit.
      const waiting = pending
      if (!waiting || broadcast?.channel !== channel || broadcast.event !== 'execution' || broadcast.data !== waiting.value) return
      if (Date.now() >= Math.min(deadline, Date.parse(waiting.value.availableUntil))) { finish(); throw new PublicSafetyAccessError(404, 'Execution is unavailable') }
      pending = undefined; clearTimeout(waiting.timer); waiting.resolve()
    }, onClose: finish })
    if (!native.ok || !native.body || ended) throw new PublicSafetyAccessError(404, 'Execution is unavailable')
    reader = native.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader!.read()
          if (chunk.done || ended) { finish(); controller.close(); return }
          if (chunk.value.byteLength > limits.frameBytes) { finish(); controller.close(); return }
          const current = await check()
          if (ended || Date.now() >= Math.min(deadline, Date.parse(current.availableUntil))) { finish(); controller.close(); return }
          controller.enqueue(chunk.value)
        }
        catch { finish(); try { controller.close() } catch { /* canceled */ } }
      },
      cancel() { finish() },
    }, { highWaterMark: 0 })
    const response = associateIncidentDeadline(new Response(body, { headers }), deadline)
    assertIncidentDeadline(response)
    // Install the native hook and construct the response before activation.
    // Terminal activation awaits delivery; it must not hold response creation.
    void attachment.activate().catch(finish)
    return response
  }
  catch (error) { finish(); throw error }
}
