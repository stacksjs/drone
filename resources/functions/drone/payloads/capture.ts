import type { CameraPayloadAdapter, CameraPayloadDescriptor, PayloadCaptureAck, PayloadCaptureCommand } from './types'
import type { PayloadPoseTimeline } from './pose'
import { createHash } from 'node:crypto'
import { PayloadCaptureError, payloadLimits } from './types'

export function jpegDimensions(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 16 || bytes.length > payloadLimits.maxImageBytes || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new PayloadCaptureError('invalid', 'Invalid JPEG envelope or size')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 2; offset + 4 <= bytes.length;) {
    if (bytes[offset] !== 255) break
    const marker = bytes[offset + 1]!, length = v.getUint16(offset + 2, false)
    if (length < 2 || offset + 2 + length > bytes.length) break
    if ([192, 193, 194].includes(marker)) {
      if (length < 8) break
      return { height: v.getUint16(offset + 5, false), width: v.getUint16(offset + 7, false) }
    }
    if (marker === 218) break
    offset += 2 + length
  }
  throw new PayloadCaptureError('invalid', 'JPEG dimensions unavailable')
}
export function validateCaptureCommand(c: PayloadCaptureCommand, descriptor: CameraPayloadDescriptor, nowMs: number) {
  if (!c || c.version !== 1 || c.sessionId !== descriptor.sessionId || c.bootId !== descriptor.bootId || !Number.isSafeInteger(c.sequence) || c.sequence < 1 || c.sequence > 0xFFFFFFFF || !Number.isFinite(nowMs) || !Number.isFinite(c.issuedAtMs) || c.issuedAtMs < 0 || c.issuedAtMs > nowMs || nowMs - c.issuedAtMs > 100 || !Number.isFinite(c.deadlineMs) || c.deadlineMs <= nowMs || c.deadlineMs - c.issuedAtMs > payloadLimits.captureTimeoutMs) throw new PayloadCaptureError('invalid', 'Capture scope, sequence or deadline invalid')
}
export function validateCaptureAck(ack: PayloadCaptureAck, c: PayloadCaptureCommand, d: CameraPayloadDescriptor, nowMs: number) {
  if (!ack || ack.version !== 1 || ack.sessionId !== c.sessionId || ack.bootId !== c.bootId || ack.sequence !== c.sequence || ack.issuedAtMs !== c.issuedAtMs || ack.deadlineMs !== c.deadlineMs || ack.deviceId !== d.deviceId || ack.evidence !== d.evidence
    || !Number.isFinite(nowMs) || nowMs < c.issuedAtMs || nowMs >= c.deadlineMs || !Number.isFinite(ack.capturedAtMs) || !Number.isFinite(ack.acknowledgedAtMs) || ack.capturedAtMs < c.issuedAtMs || ack.capturedAtMs > ack.acknowledgedAtMs || ack.acknowledgedAtMs > nowMs
    || !Number.isFinite(ack.clockUncertaintyMs) || ack.clockUncertaintyMs < 0 || ack.clockUncertaintyMs > payloadLimits.clockUncertaintyMs || ack.sensorTimingCalibrated !== false || !['sensor-first-row', 'fixture'].includes(ack.timestampReference) || (d.evidence === 'hardware' && ack.timestampReference !== 'sensor-first-row')
    || !Number.isFinite(ack.exposureTimeUs) || ack.exposureTimeUs < 0 || ack.exposureTimeUs > 1000000 || ack.width !== d.width || ack.height !== d.height || !(ack.jpeg instanceof Uint8Array) || ack.jpeg.length > d.maxImageBytes) throw new PayloadCaptureError('invalid', 'Capture ACK identity, time or capabilities invalid')
  const dimensions = jpegDimensions(ack.jpeg)
  if (dimensions.width !== d.width || dimensions.height !== d.height) throw new PayloadCaptureError('invalid', 'JPEG dimensions disagree with capture metadata')
}
/** At most one trigger, never automatically retried. Cancellation or timeout retires the adapter session. */
export function createPayloadCaptureSession(options: { adapter: CameraPayloadAdapter, poses: PayloadPoseTimeline, now?: () => number }) {
  const adapter = options.adapter, poses = options.poses, now = options.now ?? (() => performance.now()), descriptor = structuredClone(adapter.describe())
  if (descriptor.version !== 1 || !['replay-camera', 'pi-ai-camera'].includes(descriptor.driver) || !['fixture', 'hardware'].includes(descriptor.evidence) || ![descriptor.deviceId, descriptor.sessionId, descriptor.bootId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 256) || ![descriptor.width, descriptor.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096) || !Number.isInteger(descriptor.maxImageBytes) || descriptor.maxImageBytes < 16 || descriptor.maxImageBytes > payloadLimits.maxImageBytes || descriptor.physicalFlightEnabled !== false || descriptor.sensorTimingCalibrated !== false || descriptor.cameraExtrinsicsCalibrated !== false) { adapter.close(); throw new PayloadCaptureError('invalid', 'Invalid camera payload descriptor') }
  let sequence = 0, lastNow = -Infinity, closed = false, busy = false
  let cancelPending: (() => void) | undefined
  function close() { if (!closed) { closed = true; cancelPending?.(); adapter.close() } }
  return {
    describe() { return structuredClone(descriptor) }, close,
    async capture(options: { requirePose?: boolean, signal?: AbortSignal } = {}) {
      const requirePose = options.requirePose ?? false
      if (typeof requirePose !== 'boolean') throw new PayloadCaptureError('invalid', 'requirePose must be boolean')
      if (closed) throw new PayloadCaptureError('closed', 'Payload session closed; capture outcome may be unknown')
      if (busy) throw new PayloadCaptureError('busy', 'Only one capture may be pending')
      if (options.signal?.aborted) throw new PayloadCaptureError('cancelled', 'Capture cancelled before trigger')
      const issuedAtMs = now()
      if (!Number.isFinite(issuedAtMs) || issuedAtMs < 0 || issuedAtMs < lastNow || sequence >= 0xFFFFFFFF) { close(); throw new PayloadCaptureError('invalid', 'Payload clock or sequence invalid') }
      lastNow = issuedAtMs; busy = true
      const request: PayloadCaptureCommand = { version: 1, sessionId: descriptor.sessionId, bootId: descriptor.bootId, sequence: ++sequence, issuedAtMs, deadlineMs: issuedAtMs + payloadLimits.captureTimeoutMs }
      const revision = poses.snapshot().revision, signal = options.signal, controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
      try {
        const ack = await new Promise<PayloadCaptureAck>((resolve, reject) => {
          const retire = (error: PayloadCaptureError) => { controller.abort(); reject(error); close() }
          cancelPending = () => { controller.abort(); reject(new PayloadCaptureError('closed', 'Capture session closed; outcome may be unknown')) }
          abort = () => retire(new PayloadCaptureError('cancelled', 'Capture cancelled; shutter outcome may be unknown'))
          signal?.addEventListener('abort', abort, { once: true })
          timer = setTimeout(() => retire(new PayloadCaptureError('timeout', 'Capture timed out; shutter outcome may be unknown')), payloadLimits.captureTimeoutMs)
          try { Promise.resolve(adapter.capture(structuredClone(request), controller.signal)).then(resolve, reject) }
          catch (error) { reject(error) }
        })
        const receivedAtMs = now()
        validateCaptureAck(ack, request, descriptor, receivedAtMs)
        lastNow = receivedAtMs
        const association = poses.associate(ack, revision)
        if (requirePose && association.status !== 'associated') throw new PayloadCaptureError('pose', 'Capture completed but no qualified pose association is available')
        const jpeg = Uint8Array.from(ack.jpeg), sha256 = createHash('sha256').update(jpeg).digest('hex')
        return { version: 1 as const, requestId: `${descriptor.sessionId}:${request.sequence}`, camera: structuredClone(descriptor), command: request, capturedAtMs: ack.capturedAtMs, acknowledgedAtMs: ack.acknowledgedAtMs, receivedAtMs, clockUncertaintyMs: ack.clockUncertaintyMs, timestampReference: ack.timestampReference, exposureTimeUs: ack.exposureTimeUs, sensorTimingCalibrated: false as const, association, sha256, byteLength: jpeg.length, jpeg, physicalFlightEnabled: false as const }
      }
      catch (error) { close(); throw error }
      finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); cancelPending = undefined; busy = false }
    },
  }
}

export type PayloadCaptureResult = Awaited<ReturnType<ReturnType<typeof createPayloadCaptureSession>['capture']>>
