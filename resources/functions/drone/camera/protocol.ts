import type { CameraFrame } from './types'
import { validBox } from './tracker'

/** Convert the Linux child clock into the local consumer clock, including IPC queue delay. */
export function parseCameraPacket(value: unknown, receivedAtMs: number, hostMonotonicMs: number): { frame: CameraFrame, image: string | null } {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid camera packet')
  const packet = value as Record<string, unknown>
  const timestamp = packet.capturedMonotonicMs
  if (packet.version !== 1 || !Number.isSafeInteger(packet.sequence) || Number(packet.sequence) < 0
    || typeof timestamp !== 'number' || !Number.isFinite(timestamp)
    || !Number.isFinite(hostMonotonicMs) || !Number.isFinite(receivedAtMs)
    || hostMonotonicMs - timestamp < 0 || hostMonotonicMs - timestamp > 500
    || !Array.isArray(packet.detections) || packet.detections.length > 32)
    throw new TypeError('Stale or malformed camera packet')
  const detections = packet.detections.map((input: unknown) => {
    if (!input || typeof input !== 'object') throw new TypeError('Invalid detection')
    const item = input as Record<string, unknown>
    if (item.label !== 'person' || typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1 || !validBox(item.box as never)) throw new TypeError('Invalid detection')
    return { label: 'person' as const, confidence: item.confidence, box: { ...(item.box as CameraFrame['detections'][number]['box']) } }
  })
  let image: string | null = null
  if (packet.jpeg !== undefined) {
    if (typeof packet.jpeg !== 'string' || packet.jpeg.length > 500000 || !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(packet.jpeg)) throw new TypeError('Invalid camera preview')
    image = `data:image/jpeg;base64,${packet.jpeg}`
  }
  return { frame: { sequence: Number(packet.sequence), capturedAtMs: receivedAtMs - (hostMonotonicMs - timestamp), receivedAtMs, detections }, image }
}
