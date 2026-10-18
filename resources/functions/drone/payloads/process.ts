import type { CameraPayloadAdapter, CameraPayloadDescriptor, PayloadCaptureAck, PayloadCaptureCommand, PayloadEvidence } from './types'
import { PayloadCaptureError, payloadLimits } from './types'
import { validateCaptureAck, validateCaptureCommand } from './capture'

interface PendingCapture {
  command: PayloadCaptureCommand
  phase: 'sync' | 'capture'
  syncSentAtMs: number
  offsetMs: number
  uncertaintyMs: number
  resolve: (ack: PayloadCaptureAck) => void
  reject: (error: unknown) => void
  cleanup: () => void
}
/** Bounded local acquisition bridge. A measured round trip maps clocks without assuming process clock origins. */
export async function openCameraPayloadProcess(options: { command: readonly string[], sessionId?: string, evidence: PayloadEvidence, now?: () => number }): Promise<CameraPayloadAdapter> {
  const command = [...options.command], evidence = options.evidence, now = options.now ?? (() => performance.now()), sessionId = options.sessionId ?? crypto.randomUUID()
  if (!command.length || !command.every(s => typeof s === 'string' && s.length > 0 && s.length < 4096) || !/^[\w-]{1,128}$/.test(sessionId) || !['fixture', 'hardware'].includes(evidence)) throw new PayloadCaptureError('invalid', 'Invalid camera process configuration')
  const child = Bun.spawn([...command, '--session', sessionId], { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
  let closed = false, exited = false, descriptor: CameraPayloadDescriptor | null = null, sequence = 0
  let pending: PendingCapture | null = null
  let startupResolve: (value: CameraPayloadDescriptor) => void = () => {}, startupReject: (error: unknown) => void = () => {}
  const ready = new Promise<CameraPayloadDescriptor>((resolve, reject) => { startupResolve = resolve; startupReject = reject })
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const startupTimer = setTimeout(() => fail(new PayloadCaptureError('timeout', 'Camera startup timed out')), payloadLimits.startupTimeoutMs)
  function close() {
    if (closed) return
    closed = true; clearTimeout(startupTimer)
    const error = new PayloadCaptureError('closed', 'Camera process closed; capture outcome may be unknown')
    startupReject(error)
    if (pending) { const p = pending; pending = null; p.cleanup(); p.reject(error) }
    child.stdin.end()
    if (exited) return
    child.kill()
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref()
  }
  function fail(error: unknown) {
    if (closed) return
    startupReject(error)
    if (pending) { const p = pending; pending = null; p.cleanup(); p.reject(error) }
    close()
  }
  function emit(value: unknown) {
    try { child.stdin.write(`${JSON.stringify(value)}\n`); const flushed = child.stdin.flush(); if (flushed instanceof Promise) void flushed.catch(fail) }
    catch (error) { fail(error) }
  }
  function packet(data: unknown) {
    if (!data || typeof data !== 'object') throw new PayloadCaptureError('invalid', 'Invalid camera process packet')
    const p = data as Record<string, unknown>
    if (p.version !== 1 || p.sessionId !== sessionId) throw new PayloadCaptureError('invalid', 'Camera process version/session mismatch')
    if (!descriptor) {
      if (p.kind !== 'hello' || typeof p.bootId !== 'string' || !/^[\w-]{1,128}$/.test(p.bootId) || typeof p.deviceId !== 'string' || p.deviceId.length < 1 || p.deviceId.length > 256 || !Number.isInteger(p.width) || !Number.isInteger(p.height) || Number(p.width) < 1 || Number(p.height) < 1 || Number(p.width) > 4096 || Number(p.height) > 4096 || p.evidence !== evidence || (evidence === 'hardware' && p.model !== 'imx500')) throw new PayloadCaptureError('invalid', 'Invalid camera capabilities handshake')
      descriptor = { version: 1, driver: evidence === 'hardware' ? 'pi-ai-camera' : 'replay-camera', deviceId: p.deviceId, sessionId, bootId: p.bootId, evidence, width: Number(p.width), height: Number(p.height), maxImageBytes: payloadLimits.maxImageBytes, sensorTimingCalibrated: false, cameraExtrinsicsCalibrated: false, physicalFlightEnabled: false }
      clearTimeout(startupTimer); startupResolve({ ...descriptor }); return
    }
    if (!pending || p.bootId !== descriptor.bootId || p.sequence !== pending.command.sequence) throw new PayloadCaptureError('invalid', 'Unexpected or replayed camera response')
    const active = pending, received = now()
    if (p.kind === 'error') throw new PayloadCaptureError('device', 'Camera acquisition failed; inspect local worker diagnostics')
    if (active.phase === 'sync') {
      const roundTrip = received - active.syncSentAtMs
      if (p.kind !== 'sync' || typeof p.monotonicMs !== 'number' || !Number.isFinite(p.monotonicMs) || p.monotonicMs < 0 || !Number.isFinite(roundTrip) || roundTrip < 0 || roundTrip / 2 > payloadLimits.clockUncertaintyMs) throw new PayloadCaptureError('invalid', 'Camera clock synchronization exceeded uncertainty budget')
      validateCaptureCommand(active.command, descriptor, received)
      active.offsetMs = (received + active.syncSentAtMs) / 2 - p.monotonicMs
      active.uncertaintyMs = roundTrip / 2
      active.phase = 'capture'
      emit({ version: 1, kind: 'capture', sessionId, bootId: descriptor.bootId, sequence: active.command.sequence, notBeforeMonotonicMs: active.command.issuedAtMs - active.offsetMs + active.uncertaintyMs, deadlineMonotonicMs: active.command.deadlineMs - active.offsetMs - active.uncertaintyMs })
      return
    }
    if (p.kind !== 'capture' || typeof p.jpeg !== 'string' || p.jpeg.length > 699052 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.jpeg) || p.jpeg.length % 4 !== 0 || typeof p.capturedMonotonicMs !== 'number' || typeof p.acknowledgedMonotonicMs !== 'number' || typeof p.clockUncertaintyMs !== 'number' || p.clockUncertaintyMs < 0 || typeof p.exposureTimeUs !== 'number') throw new PayloadCaptureError('invalid', 'Malformed camera capture packet')
    const ack: PayloadCaptureAck = { ...active.command, deviceId: descriptor.deviceId, evidence, capturedAtMs: p.capturedMonotonicMs + active.offsetMs, acknowledgedAtMs: p.acknowledgedMonotonicMs + active.offsetMs, clockUncertaintyMs: p.clockUncertaintyMs + active.uncertaintyMs, timestampReference: evidence === 'hardware' ? 'sensor-first-row' : 'fixture', sensorTimingCalibrated: false, exposureTimeUs: p.exposureTimeUs, width: Number(p.width), height: Number(p.height), jpeg: Uint8Array.fromBase64(p.jpeg) }
    validateCaptureAck(ack, active.command, descriptor, received)
    pending = null
    active.cleanup()
    active.resolve(ack)
  }
  void (async () => {
    const reader = child.stdout.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    let text = ''
    try {
      while (!closed) {
        const part = await reader.read(); if (part.done) break
        text += decoder.decode(part.value, { stream: true })
        if (text.length > payloadLimits.packetCharacters) throw new PayloadCaptureError('invalid', 'Camera packet exceeded budget')
        let index
        while ((index = text.indexOf('\n')) >= 0) { const line = text.slice(0, index); text = text.slice(index + 1); if (line) packet(JSON.parse(line)) }
      }
      if (!closed) fail(new PayloadCaptureError('device', 'Camera process stream ended'))
    }
    catch (error) { fail(error) }
    finally { reader.releaseLock() }
  })()
  void child.exited.then(code => { exited = true; if (killTimer) clearTimeout(killTimer); if (!closed) fail(new PayloadCaptureError('device', `Camera process exited (${code})`)) })
  await ready
  return {
    describe() { return { ...descriptor! } }, close,
    capture(c, signal) {
      if (closed) return Promise.reject(new PayloadCaptureError('closed', 'Camera process closed'))
      if (pending) return Promise.reject(new PayloadCaptureError('busy', 'Camera capture already pending'))
      try { validateCaptureCommand(c, descriptor!, now()); if (c.sequence <= sequence) throw new PayloadCaptureError('invalid', 'Replayed capture sequence') }
      catch (error) { return Promise.reject(error) }
      if (signal?.aborted) return Promise.reject(new PayloadCaptureError('cancelled', 'Capture cancelled before trigger'))
      sequence = c.sequence
      return new Promise<PayloadCaptureAck>((resolve, reject) => {
        const abort = () => fail(new PayloadCaptureError('cancelled', 'Capture cancelled; shutter outcome may be unknown'))
        const syncSentAtMs = now(), timer = setTimeout(() => fail(new PayloadCaptureError('timeout', 'Camera ACK expired; shutter outcome may be unknown')), Math.max(1, c.deadlineMs - syncSentAtMs))
        pending = { command: { ...c }, phase: 'sync', syncSentAtMs, offsetMs: 0, uncertaintyMs: Infinity, resolve, reject, cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort) } }
        signal?.addEventListener('abort', abort, { once: true })
        emit({ version: 1, kind: 'sync', sessionId, bootId: descriptor!.bootId, sequence: c.sequence })
      })
    },
  }
}
