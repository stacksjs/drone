type CallbackKind = 'event' | 'result' | 'finished' | 'other'
interface CallbackCost { calls: number, totalMs: number, maxMs: number }
interface CallbackObservation { ordinal: number, inCallback: boolean, capped: boolean, costs: Record<CallbackKind, CallbackCost> }
type CallbackMarker = { evidence: 'native-worker-callback', ordinal: number, kind: 'result' | 'finished', phase: 'entered', sinceObservationMs: number | null }
  | { evidence: 'native-worker-callback', ordinal: number, kind: 'result' | 'finished', phase: 'settled', callbackMs: number | null, sinceObservationMs: number | null }
const scalar = (value: number) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null
const field = (value: unknown, name: string): unknown => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined
const choice = <T extends string>(value: unknown, values: readonly T[]): T | null => values.find(item => item === value) ?? null

/** Private fixture observation only. Measures synchronous callback work, never async completion. */
export function createExecutionCallbackObserver(marker: (value: CallbackMarker) => void, now: () => number = () => performance.now()) {
  const callbackObservations: CallbackObservation[] = [], observedWorkers = new WeakSet<Worker>()
  let callbackObservationOverflow = false, callbackObservationUnavailable = false
  const snapshot = () => ({ overflow: callbackObservationOverflow, unavailable: callbackObservationUnavailable, observations: structuredClone(callbackObservations) })
  function observe(worker: Worker, acceptedOrdinal: number) {
    try {
      if (observedWorkers.has(worker)) return
      if (callbackObservations.length >= 2) { callbackObservationOverflow = true; return }
      const callback = worker.onmessage
      if (typeof callback !== 'function') { callbackObservationUnavailable = true; return }
      const cost = (): CallbackCost => ({ calls: 0, totalMs: 0, maxMs: 0 })
      const observation: CallbackObservation = { ordinal: acceptedOrdinal, inCallback: false, capped: false, costs: { event: cost(), result: cost(), finished: cost(), other: cost() } }
      const installedAt = now()
      let markerCount = 0
      const emitMarker = (value: CallbackMarker) => {
        if (markerCount >= 4) { observation.capped = true; return }
        markerCount++
        marker(value)
      }
      worker.onmessage = function (event) {
        let began: number | null = null, kind: CallbackKind = 'other'
        try {
          kind = choice(field(event.data, 'kind'), ['event', 'result', 'finished']) ?? 'other'
          if (kind === 'result' || kind === 'finished') emitMarker({ evidence: 'native-worker-callback', ordinal: acceptedOrdinal, kind, phase: 'entered', sinceObservationMs: scalar(now() - installedAt) })
        }
        catch { callbackObservationUnavailable = true }
        try { observation.inCallback = true; began = now() }
        catch { callbackObservationUnavailable = true }
        try { return callback.call(this, event) }
        finally {
          // Timing is observational: preserve the exact native callback outcome,
          // including an exception, even if collection or its closed console marker fails.
          try {
            const ended = now()
            observation.inCallback = false
            const elapsed = began === null ? null : scalar(ended - began)
            if (elapsed === null || elapsed < 0) callbackObservationUnavailable = true
            else {
              const bucket = observation.costs[kind]
              if (bucket.calls >= 1000000 || bucket.totalMs + elapsed > Number.MAX_SAFE_INTEGER) observation.capped = true
              else { bucket.calls++; bucket.totalMs += elapsed; bucket.maxMs = Math.max(bucket.maxMs, elapsed) }
            }
            if (kind === 'result' || kind === 'finished') emitMarker({ evidence: 'native-worker-callback', ordinal: acceptedOrdinal, kind, phase: 'settled', callbackMs: elapsed, sinceObservationMs: scalar(now() - installedAt) })
          }
          catch { observation.inCallback = false; callbackObservationUnavailable = true }
        }
      }
      observedWorkers.add(worker); callbackObservations.push(observation)
    }
    catch { callbackObservationUnavailable = true }
  }
  return { observe, snapshot }
}
