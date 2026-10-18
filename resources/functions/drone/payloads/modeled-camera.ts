import type { RigidBodyState } from '../controls/physics'

export interface ModeledShutterCommand { sessionId: string, sequence: number, issuedAtMs: number, reference: string }
export interface ModeledImage { rgba: Uint8Array, thermalCentiKelvin: Uint16Array | null }
export interface ModeledShutterAck extends ModeledShutterCommand, ModeledImage { capturedAtMs: number, acknowledgedAtMs: number }
/** Owned model protocol. One pending exposure, immutable session and reference, no retry policy. */
export function createModeledCamera(renderer: (state: RigidBodyState, nowMs: number) => ModeledImage, options: { fault?: 'none' | 'loss' | 'wrong-ack', faultAfterMs?: number } = {}) {
  const fault = options.fault ?? 'none', faultAfterMs = options.faultAfterMs ?? 12000
  if (!['none', 'loss', 'wrong-ack'].includes(fault) || !Number.isFinite(faultAfterMs) || faultAfterMs < 0) throw new RangeError('Invalid modeled camera fault')
  let latest: { state: RigidBodyState, nowMs: number } | null = null
  let pending: ModeledShutterAck | null = null, closed = false, sequence = 0
  let session: string | null = null, reference: string | null = null, faultAtMs: number | null = null
  let lastPoll = -Infinity, lastIssued = -Infinity
  return {
    render(state: RigidBodyState, nowMs: number) {
      if (closed) return
      if (!Number.isFinite(nowMs) || nowMs < 0 || (latest && nowMs < latest.nowMs)) throw new RangeError('Invalid modeled camera clock')
      latest = { state: structuredClone(state), nowMs }
    },
    request(command: ModeledShutterCommand) {
      if (closed || pending || !latest || command.issuedAtMs !== latest.nowMs || command.issuedAtMs <= lastIssued || command.issuedAtMs < lastPoll || !Number.isSafeInteger(command.sequence) || command.sequence !== sequence + 1 || !/^[\w:.-]{1,128}$/.test(command.sessionId) || !/^[\w:,.-]{1,256}$/.test(command.reference) || (session !== null && session !== command.sessionId) || (reference !== null && reference !== command.reference)) throw new RangeError('Invalid or ambiguous modeled shutter request')
      const image = renderer(structuredClone(latest.state), latest.nowMs)
      if (!(image.rgba instanceof Uint8Array) || image.rgba.length < 4 || image.rgba.length > 65536 * 4 || image.rgba.length % 4 !== 0 || (image.thermalCentiKelvin !== null && (!(image.thermalCentiKelvin instanceof Uint16Array) || image.thermalCentiKelvin.length !== image.rgba.length / 4))) throw new RangeError('Invalid modeled raster budget')
      sequence = command.sequence; session = command.sessionId; reference = command.reference; lastIssued = command.issuedAtMs
      if (command.issuedAtMs >= faultAfterMs && faultAtMs === null) faultAtMs = command.issuedAtMs
      const failed = faultAtMs !== null && command.issuedAtMs < faultAtMs + 2000
      pending = { ...command, reference: failed && fault === 'wrong-ack' ? 'wrong-reference' : command.reference, capturedAtMs: command.issuedAtMs, acknowledgedAtMs: failed && fault === 'loss' ? command.issuedAtMs + 2000 : command.issuedAtMs + 20, rgba: new Uint8Array(image.rgba), thermalCentiKelvin: image.thermalCentiKelvin === null ? null : new Uint16Array(image.thermalCentiKelvin) }
    },
    poll(nowMs: number): ModeledShutterAck | null {
      if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs < lastPoll) throw new RangeError('Invalid modeled camera poll clock')
      lastPoll = nowMs
      if (!pending || pending.acknowledgedAtMs > nowMs) return null
      const ack = pending; pending = null; return structuredClone(ack)
    },
    close() { closed = true; latest = null; pending = null },
  }
}
