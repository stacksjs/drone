import { expect, test } from 'bun:test'
import { createExecutionCallbackObserver } from '../helpers/execution-worker-observation'

const worker = () => new Worker(new URL('../fixtures/public-safety-access/execution-observer-worker.ts', import.meta.url), { env: {}, preload: [] })

test('real Worker frames and receiver survive private callback observation without persisting payloads', async () => {
  const source = worker(), markers: unknown[] = []
  const observer = createExecutionCallbackObserver(value => markers.push(value))
  const received: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const delivered = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned callback fixture did not deliver its frames')), 2000)
      source.onmessage = function (event) {
        try {
          expect(this).toBe(source)
          const frame = event.data as { kind: string, payload: string, bytes: Uint8Array }
          expect(frame.payload).toBe('private-callback-payload')
          expect(frame.bytes).toEqual(new Uint8Array([1, 2, 3]))
          received.push(frame.kind)
          if (received.length === 4) resolve()
        }
        catch (error) { reject(error) }
      }
      source.onerror = () => reject(new Error('Owned callback fixture Worker failed'))
    })
    observer.observe(source, 1)
    source.postMessage('emit')
    await delivered
    expect(received).toEqual(['event', 'result', 'finished', 'unrecognized'])
    const snapshot = observer.snapshot()
    expect(snapshot.overflow).toBe(false)
    expect(snapshot.unavailable).toBe(false)
    expect(snapshot.observations).toHaveLength(1)
    expect(snapshot.observations[0]!.inCallback).toBe(false)
    expect(snapshot.observations[0]!.capped).toBe(false)
    for (const bucket of Object.values(snapshot.observations[0]!.costs)) {
      expect(bucket.calls).toBe(1)
      expect(Number.isFinite(bucket.totalMs) && bucket.totalMs >= 0).toBe(true)
      expect(bucket.maxMs).toBe(bucket.totalMs)
    }
    expect(markers).toHaveLength(4)
    expect(JSON.stringify({ snapshot, markers })).not.toContain('private-callback-payload')
    expect(JSON.stringify({ snapshot, markers })).not.toContain('bytes')
  }
  finally { clearTimeout(timer); source.terminate() }
})

test('observer failures preserve the original callback return, throw identity and opaque fields', () => {
  const first = worker(), second = worker()
  const observer = createExecutionCallbackObserver(() => { throw new Error('Diagnostic marker unavailable') })
  let getterCalls = 0, received: unknown
  const payload = { kind: 'result', get privateField() { getterCalls++; return 'unread-private-value' } }
  const event = new MessageEvent('message', { data: payload }), result = { originalReturn: true }, originalError = new Error('Original callback failure')
  try {
    first.onmessage = function (value) { expect(this).toBe(first); received = value.data; return result }
    observer.observe(first, 1)
    expect(first.onmessage!.call(first, event)).toBe(result)
    expect(received).toBe(payload)
    expect(getterCalls).toBe(0)
    second.onmessage = function (value) { expect(this).toBe(second); expect(value).toBe(event); throw originalError }
    observer.observe(second, 2)
    let thrown: unknown
    try { second.onmessage!.call(second, event) }
    catch (error) { thrown = error }
    expect(thrown).toBe(originalError)
    expect(observer.snapshot().unavailable).toBe(true)
    expect(observer.snapshot().observations.map(value => value.costs.result.calls)).toEqual([1, 1])
    expect(JSON.stringify(observer.snapshot())).not.toContain('unread-private-value')
    expect(getterCalls).toBe(0)
  }
  finally { first.terminate(); second.terminate() }
})

test('the observer caps actual Worker reservations without changing later callbacks and returns detached snapshots', () => {
  const first = worker(), second = worker(), third = worker()
  const observer = createExecutionCallbackObserver(() => {})
  const callback = () => {}
  try {
    first.onmessage = callback; second.onmessage = callback; third.onmessage = callback
    observer.observe(first, 1); observer.observe(first, 99); observer.observe(second, 2); observer.observe(third, 3)
    const snapshot = observer.snapshot()
    expect(snapshot.overflow).toBe(true)
    expect(snapshot.unavailable).toBe(false)
    expect(snapshot.observations.map(value => value.ordinal)).toEqual([1, 2])
    expect(third.onmessage).toBe(callback)
    snapshot.observations[0]!.costs.event.calls = 9999
    expect(observer.snapshot().observations[0]!.costs.event.calls).toBe(0)
  }
  finally { first.terminate(); second.terminate(); third.terminate() }
})

test('marker latency and diagnostic exceptions cannot inflate the original synchronous callback duration', () => {
  const source = worker(), returned = { original: true }, settled: number[] = []
  let clock = 0
  const observer = createExecutionCallbackObserver(value => {
    if (value.phase === 'settled' && value.callbackMs !== null) settled.push(value.callbackMs)
    clock += 1000
    throw new Error('Slow diagnostic sink failed')
  }, () => clock)
  try {
    source.onmessage = () => { clock += 7; return returned }
    observer.observe(source, 1)
    expect(source.onmessage!.call(source, new MessageEvent('message', { data: { kind: 'result' } }))).toBe(returned)
    expect(observer.snapshot().observations[0]!.costs.result).toEqual({ calls: 1, totalMs: 7, maxMs: 7 })
    expect(settled).toEqual([7])
    expect(observer.snapshot().unavailable).toBe(true)
  }
  finally { source.terminate() }
})

test('repeated terminal-kind messages cannot produce an unbounded diagnostic console stream', () => {
  const source = worker(), markers: unknown[] = []
  const observer = createExecutionCallbackObserver(value => markers.push(value))
  let originalCalls = 0
  try {
    source.onmessage = () => { originalCalls++ }
    observer.observe(source, 1)
    for (let index = 0; index < 10; index++) source.onmessage!.call(source, new MessageEvent('message', { data: { kind: 'result' } }))
    expect(originalCalls).toBe(10)
    expect(markers).toHaveLength(4)
    expect(observer.snapshot().observations[0]!.capped).toBe(true)
    expect(observer.snapshot().observations[0]!.costs.result.calls).toBe(10)
    expect(observer.snapshot().unavailable).toBe(false)
  }
  finally { source.terminate() }
})
