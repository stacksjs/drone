import type { CameraFrame, Candidate, ImageBox, TrackingSnapshot, VisualLock } from './types'

export function validBox(value: ImageBox): boolean {
  return !!value && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0
    && value.x + value.width <= 1.000001 && value.y + value.height <= 1.000001
}

function overlap(a: ImageBox, b: ImageBox): number {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return intersection / (a.width * a.height + b.width * b.height - intersection)
}

/** Conservative short-term image association, not biometric identity or re-identification. */
export function createVisualTracker(options: { maxAgeMs?: number, minConfidence?: number, confirmations?: number } = {}) {
  const maxAge = options.maxAgeMs ?? 500
  const minConfidence = options.minConfidence ?? 0.65
  const confirmations = options.confirmations ?? 3
  if (!Number.isFinite(maxAge) || maxAge <= 0 || maxAge > 2000
    || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1
    || !Number.isSafeInteger(confirmations) || confirmations < 2 || confirmations > 20)
    throw new RangeError('Invalid visual tracking settings')
  let state: TrackingSnapshot['state'] = 'idle'
  let reason = 'Select a person explicitly'
  let sequence = -1
  let capturedAt = -Infinity
  let lastNow = -Infinity
  let candidates: Candidate[] = []
  let selected: VisualLock | null = null
  let association: TrackingSnapshot['association'] = null
  let lockSequence = 0
  const trackerId = crypto.randomUUID()
  const history: { sequence: number, capturedAtMs: number, candidates: Candidate[] }[] = []

  function lose(message: string) {
    association = null
    if (selected) state = 'lost'
    reason = message
  }
  function checkClock(nowMs: number) {
    if (!Number.isFinite(nowMs) || nowMs < lastNow) {
      candidates = []
      history.length = 0
      lose('Clock discontinuity; select again')
      return false
    }
    lastNow = nowMs
    return true
  }
  function expire(nowMs: number) {
    if (!checkClock(nowMs)) return false
    if (nowMs - capturedAt > maxAge) {
      candidates = []
      if (state === 'tracking') lose('Camera frame timeout; select again')
    }
    return true
  }
  function associate(next: Candidate[], timestamp: number, frameSequence: number) {
    if (state !== 'tracking' || !selected) return
    const previous = selected.box
    const matches = next.filter(item => {
      const ratio = item.box.width * item.box.height / (previous.width * previous.height)
      const displacement = Math.hypot(item.box.x + item.box.width / 2 - previous.x - previous.width / 2, item.box.y + item.box.height / 2 - previous.y - previous.height / 2)
      return overlap(previous, item.box) >= 0.25 && displacement <= 0.2 && ratio >= 0.5 && ratio <= 2
    })
    if (matches.length !== 1) {
      lose(matches.length > 1 ? 'Ambiguous people; select again' : 'Selected person lost; select again')
      return
    }
    const match = matches[0]!
    association = { frameSequence, candidateId: match.id, capturedAtMs: timestamp }
    selected = { ...selected, box: { ...match.box }, confidence: match.confidence, lastSeenAtMs: timestamp, confirmations: Math.min(confirmations, selected.confirmations + 1) }
    reason = selected.confirmations >= confirmations ? 'Selected person tracked' : 'Confirming selected person'
  }
  function snapshot(nowMs: number): TrackingSnapshot {
    expire(nowMs)
    const confirmed = state === 'tracking' && selected !== null && selected.confirmations >= confirmations
    return structuredClone({
      state, reason, sequence: sequence < 0 ? null : sequence, candidates, selected, confirmed, association: confirmed ? association : null,
      observation: confirmed && selected ? { horizontalError: 2 * (selected.box.x + selected.box.width / 2 - 0.5), verticalError: 2 * (selected.box.y + selected.box.height / 2 - 0.5) } : null,
    })
  }
  return {
    snapshot,
    fail(message: string) { candidates = []; history.length = 0; lose(message) },
    clear() { selected = null; association = null; state = 'idle'; reason = 'Select a person explicitly' },
    select(candidateId: string, frameSequence: number, nowMs: number) {
      if (!expire(nowMs)) throw new RangeError('Invalid selection clock')
      const shown = history.find(frame => frame.sequence === frameSequence)
      const candidate = shown?.candidates.find(item => item.id === candidateId)
      if (!candidate || !shown || nowMs - shown.capturedAtMs > maxAge) throw new RangeError('Candidate expired or unavailable')
      selected = { id: `${trackerId}:${++lockSequence}`, box: { ...candidate.box }, confidence: candidate.confidence, lastSeenAtMs: shown.capturedAtMs, confirmations: 1 }
      association = { frameSequence, candidateId: candidate.id, capturedAtMs: shown.capturedAtMs }
      state = 'tracking'
      reason = 'Confirming selected person'
      for (const frame of history.filter(frame => frame.sequence > frameSequence)) associate(frame.candidates, frame.capturedAtMs, frame.sequence)
      return snapshot(nowMs)
    },
    update(frame: CameraFrame, nowMs: number) {
      if (!expire(nowMs)) return snapshot(nowMs)
      if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence) return snapshot(nowMs)
      if (![frame.capturedAtMs, frame.receivedAtMs, nowMs].every(Number.isFinite)
        || frame.capturedAtMs > frame.receivedAtMs || frame.receivedAtMs > nowMs
        || frame.capturedAtMs <= capturedAt || nowMs - frame.capturedAtMs > maxAge
        || !Array.isArray(frame.detections) || frame.detections.length > 32
        || frame.detections.some(item => !item || item.label !== 'person' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 || !validBox(item.box))) {
        candidates = []
        history.length = 0
        lose('Invalid or stale camera frame; select again')
        return snapshot(nowMs)
      }
      sequence = frame.sequence
      capturedAt = frame.capturedAtMs
      candidates = frame.detections.filter(item => item.confidence >= minConfidence).map((item, index) => ({ ...structuredClone(item), id: `${sequence}:${index}` }))
      history.push({ sequence, capturedAtMs: capturedAt, candidates: structuredClone(candidates) })
      while (history.length > 64 || (history[0] && nowMs - history[0].capturedAtMs > maxAge)) history.shift()
      associate(candidates, capturedAt, sequence)
      return snapshot(nowMs)
    },
  }
}
