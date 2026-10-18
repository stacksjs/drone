export const runtimeProtocol = { version: 1, frameBytes: 64, periodUs: 1000, deadlineUs: 500, maxLatenessUs: 250, freshnessUs: 50000, maxLeaseUs: 100000 } as const
export const runtimeFlags = { synthetic: 1, neutralOnly: 2, leased: 4, deadlineFault: 8, clockFault: 16, watchdogReset: 32, sampleValid: 64 } as const
const kinds = { hello: 1, lease: 2, stop: 3, status: 4 } as const
export type RuntimeKind = keyof typeof kinds
export interface RuntimeFrame {
  kind: RuntimeKind
  sequence: number
  bootId: bigint
  sessionId: bigint
  sampleTimeUs: bigint
  leaseUs: number
  sample: number
  ticks: number
  deadlineMisses: number
  flags: number
  maxExecutionUs: number
  stateBytes: number
}
export function runtimeCrc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return (~crc) >>> 0
}
export function commandFrame(kind: Exclude<RuntimeKind, 'status'>, sequence: number, bootId: bigint, sessionId: bigint, sampleTimeUs = 0n, leaseUs = 0): RuntimeFrame {
  return { kind, sequence, bootId, sessionId, sampleTimeUs, leaseUs, sample: 0, ticks: 0, deadlineMisses: 0, flags: 0, maxExecutionUs: 0, stateBytes: 0 }
}
export function encodeRuntimeFrame(frame: RuntimeFrame): Uint8Array {
  const u32 = [frame.sequence, frame.leaseUs, frame.ticks, frame.deadlineMisses, frame.flags, frame.maxExecutionUs, frame.stateBytes]
  if (!Object.hasOwn(kinds, frame.kind) || u32.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0xFFFFFFFF)
    || !Number.isSafeInteger(frame.sample) || frame.sample < -0x80000000 || frame.sample > 0x7FFFFFFF
    || [frame.bootId, frame.sessionId, frame.sampleTimeUs].some(value => typeof value !== 'bigint' || value < 0n || value > 0xFFFFFFFFFFFFFFFFn))
    throw new RangeError('Invalid runtime wire fields')
  const bytes = new Uint8Array(runtimeProtocol.frameBytes)
  const view = new DataView(bytes.buffer)
  bytes.set([68, 82, runtimeProtocol.version, kinds[frame.kind]])
  view.setUint32(4, frame.sequence, true)
  view.setBigUint64(8, frame.bootId, true); view.setBigUint64(16, frame.sessionId, true); view.setBigUint64(24, frame.sampleTimeUs, true)
  view.setUint32(32, frame.leaseUs, true); view.setInt32(36, frame.sample, true)
  view.setUint32(40, frame.ticks, true); view.setUint32(44, frame.deadlineMisses, true); view.setUint32(48, frame.flags, true)
  view.setUint32(52, frame.maxExecutionUs, true); view.setUint32(56, frame.stateBytes, true)
  view.setUint32(60, runtimeCrc32(bytes.subarray(0, 60)), true)
  return bytes
}
export function decodeRuntimeFrame(bytes: Uint8Array): RuntimeFrame {
  if (bytes.byteLength !== runtimeProtocol.frameBytes) throw new RangeError('Runtime frame must be exactly 64 bytes')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = (Object.keys(kinds) as RuntimeKind[]).find(key => kinds[key] === bytes[3])
  if (bytes[0] !== 68 || bytes[1] !== 82 || bytes[2] !== runtimeProtocol.version || !kind || view.getUint32(60, true) !== runtimeCrc32(bytes.subarray(0, 60)))
    throw new RangeError('Incompatible or corrupt runtime frame')
  return {
    kind, sequence: view.getUint32(4, true), bootId: view.getBigUint64(8, true), sessionId: view.getBigUint64(16, true), sampleTimeUs: view.getBigUint64(24, true),
    leaseUs: view.getUint32(32, true), sample: view.getInt32(36, true), ticks: view.getUint32(40, true), deadlineMisses: view.getUint32(44, true),
    flags: view.getUint32(48, true), maxExecutionUs: view.getUint32(52, true), stateBytes: view.getUint32(56, true),
  }
}
