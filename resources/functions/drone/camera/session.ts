import type { CameraFrame, CameraSnapshot } from './types'
import type { CameraSource, CameraSourceCallbacks } from './imx500'
import { startImx500 } from './imx500'
import { createVisualTracker } from './tracker'

export function createCameraSession(options: { now?: () => number, liveSource?: (callbacks: CameraSourceCallbacks) => CameraSource } = {}) {
  const now = options.now ?? (() => performance.now())
  const liveSource = options.liveSource ?? startImx500
  let tracker = createVisualTracker()
  let source: CameraSnapshot['source'] = 'stopped'
  let status: CameraSnapshot['status'] = 'stopped'
  let error: string | null = null
  let image: string | null = null
  let imageAt = -Infinity
  let sessionId: string | null = null
  let handle: CameraSource | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let replayFault: 'none' | 'loss' | 'ambiguity' = 'none'
  let replaySequence = 0

  function snapshot(): CameraSnapshot {
    const tracking = tracker.snapshot(now())
    return { source, status, error, image: status === 'running' && now() - imageAt <= 500 ? image : null, sessionId, tracking, physicalFlightEnabled: false }
  }
  function stop() {
    sessionId = null
    handle?.close(); handle = undefined
    if (timer) clearInterval(timer)
    timer = undefined
    tracker = createVisualTracker()
    source = 'stopped'; status = 'stopped'; image = null; error = null
    return snapshot()
  }
  function start(next: 'replay' | 'imx500') {
    if (source !== 'stopped') throw new Error('Stop the current camera session first')
    tracker = createVisualTracker()
    source = next; status = 'starting'; error = null
    const epoch = crypto.randomUUID()
    sessionId = epoch
    const callbacks: CameraSourceCallbacks = {
      onFrame(frame: CameraFrame, jpeg) {
        if (sessionId !== epoch || status === 'error') return
        tracker.update(frame, now())
        image = jpeg
        imageAt = frame.capturedAtMs
        status = 'running'
      },
      onError(message) {
        if (sessionId !== epoch) return
        tracker.fail('Camera source failed; select again after restart')
        status = 'error'; error = message; image = null
      },
    }
    try {
      if (next === 'imx500') handle = liveSource(callbacks)
      else {
        replaySequence = 0; replayFault = 'none'
        const emit = () => {
          const timestamp = now()
          const x = 0.18 + 0.03 * Math.sin(replaySequence / 20)
          const person = { label: 'person' as const, confidence: 0.94, box: { x, y: 0.2, width: 0.2, height: 0.6 } }
          const detections = replayFault === 'loss' ? [] : [person, { ...person, box: { ...person.box, x: replayFault === 'ambiguity' ? x + 0.03 : 0.65 } }]
          callbacks.onFrame({ sequence: ++replaySequence, capturedAtMs: timestamp, receivedAtMs: timestamp, detections }, null)
        }
        emit()
        timer = setInterval(emit, 100)
      }
    }
    catch {
      callbacks.onError('Unable to start camera worker; verify Picamera2, firmware and camera connection')
    }
    return snapshot()
  }
  return {
    snapshot, start, stop,
    select(id: string, sequence: number, epoch: string) {
      if (status !== 'running' || epoch !== sessionId) throw new RangeError('Camera session changed or is unavailable')
      tracker.select(id, sequence, now())
      return snapshot()
    },
    clear() { tracker.clear(); return snapshot() },
    inject(fault: typeof replayFault) {
      if (source !== 'replay' || status !== 'running') throw new RangeError('Failure injection is available only during replay')
      replayFault = fault
      return snapshot()
    },
  }
}

// No worker, timer or camera starts during module import or auto-import discovery.
let session: ReturnType<typeof createCameraSession> | undefined
export function cameraSession() {
  if (!session) {
    session = createCameraSession()
    // Preserve Bun's default signal termination. The Linux worker uses parent-death SIGKILL.
  }
  return session
}
