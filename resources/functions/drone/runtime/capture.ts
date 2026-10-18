import { decodeRuntimeFrame, runtimeProtocol, type RuntimeFrame } from './protocol'

export const maxRuntimeCaptureBytes = 1048576
/** Inspect receive-only UART evidence; never treats a recorded frame as live authority. */
export function inspectRuntimeCapture(bytes: Uint8Array) {
  if (bytes.length > maxRuntimeCaptureBytes) throw new RangeError('Runtime capture exceeds 1 MiB')
  let offset = 0, frames = 0, discardedBytes = 0, corruptCandidates = 0, boots = 0
  let latest: RuntimeFrame | null = null
  while (offset + runtimeProtocol.frameBytes <= bytes.length) {
    if (bytes[offset] !== 68 || bytes[offset + 1] !== 82) { offset++; discardedBytes++; continue }
    let frame: RuntimeFrame
    try { frame = decodeRuntimeFrame(bytes.subarray(offset, offset + runtimeProtocol.frameBytes)) }
    catch { corruptCandidates++; offset++; discardedBytes++; continue }
    if (frame.kind !== 'status') { offset += runtimeProtocol.frameBytes; discardedBytes += runtimeProtocol.frameBytes; continue }
    if (!latest || latest.bootId !== frame.bootId) boots++
    latest = frame; frames++; offset += runtimeProtocol.frameBytes
  }
  discardedBytes += bytes.length - offset
  if (!latest) throw new Error('No compatible CRC-valid runtime status frames in capture')
  return { evidence: 'recorded-uart', protocolVersion: 1, frames, observedBootSegments: boots, discardedBytes, corruptCandidates, latest, physicalFlightEnabled: false as const }
}
