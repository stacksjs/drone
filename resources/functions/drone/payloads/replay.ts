import type { CameraPayloadAdapter, PayloadCaptureAck } from './types'
import { PayloadCaptureError } from './types'
import { validateCaptureCommand } from './capture'
/** Original 8x8 grey baseline JPEG: one DC-zero block plus EOB, no source photograph. */
export function payloadFixtureJpeg() {
  return new Uint8Array([255, 216, 255, 219, 0, 67, 0, ...Array.from({ length: 64 }, () => 1), 255, 192, 0, 11, 8, 0, 8, 0, 8, 1, 1, 17, 0, 255, 196, 0, 38, 0, 1, ...Array.from({ length: 15 }, () => 0), 0, 16, 1, ...Array.from({ length: 15 }, () => 0), 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 63, 255, 217])
}
export function createReplayCameraPayload(options: { now: () => number, captureAt: () => number, fault?: 'none' | 'lost-ack' | 'wrong-identity' | 'stale-clock', onTrigger?: () => void }): CameraPayloadAdapter {
  const { now, captureAt, onTrigger, fault = 'none' } = options
  const descriptor = Object.freeze({ version: 1 as const, driver: 'replay-camera' as const, deviceId: 'synthetic-grey-camera', sessionId: 'replay-payload-session', bootId: 'replay-camera-boot', evidence: 'fixture' as const, width: 8, height: 8, maxImageBytes: 524288, sensorTimingCalibrated: false as const, cameraExtrinsicsCalibrated: false as const, physicalFlightEnabled: false as const })
  let closed = false, sequence = 0
  let cancelPending: (() => void) | undefined
  return {
    describe() { return { ...descriptor } },
    async capture(command, signal) {
      if (closed) throw new PayloadCaptureError('closed', 'Replay camera closed')
      if (cancelPending) throw new PayloadCaptureError('busy', 'Replay capture already pending')
      validateCaptureCommand(command, descriptor, now())
      if (command.sequence <= sequence) throw new PayloadCaptureError('invalid', 'Replayed capture sequence')
      if (signal?.aborted) throw new PayloadCaptureError('cancelled', 'Capture cancelled')
      sequence = command.sequence; onTrigger?.()
      if (fault === 'lost-ack') return new Promise<PayloadCaptureAck>((resolve, reject) => {
        void resolve
        const cancel = () => { signal?.removeEventListener('abort', cancel); cancelPending = undefined; reject(new PayloadCaptureError('cancelled', 'Replay capture retired; outcome unknown')) }
        cancelPending = cancel
        if (signal?.aborted) cancel()
        else signal?.addEventListener('abort', cancel, { once: true })
      })
      return { ...command, bootId: fault === 'wrong-identity' ? 'other-boot' : descriptor.bootId, deviceId: descriptor.deviceId, evidence: descriptor.evidence, capturedAtMs: fault === 'stale-clock' ? command.issuedAtMs - 1 : captureAt(), acknowledgedAtMs: now(), clockUncertaintyMs: 0, timestampReference: 'fixture', sensorTimingCalibrated: false, exposureTimeUs: 1000, width: 8, height: 8, jpeg: payloadFixtureJpeg() }
    },
    close() { closed = true; cancelPending?.() },
  }
}
