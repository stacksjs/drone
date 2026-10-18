import type { RuntimeFrame } from './protocol'
import { commandFrame, decodeRuntimeFrame, encodeRuntimeFrame, runtimeFlags, runtimeProtocol } from './protocol'

function nonce64() {
  const words = crypto.getRandomValues(new Uint32Array(2))
  return (BigInt(words[0]!) << 32n | BigInt(words[1]!)) || 1n
}
/** Local bench protocol only. This session cannot create actuator or flight commands. */
export function createRuntimeSession(options: { nonce?: () => bigint } = {}) {
  let phase: 'idle' | 'handshaking' | 'ready' | 'lost' = 'idle'
  let session = 0n
  let sequence = 0
  let lastNow = -Infinity
  let progressAt = -Infinity
  let previous: RuntimeFrame | undefined
  function lose(message: string): never { phase = 'lost'; previous = undefined; throw new Error(message) }
  function clock(now: number) {
    if (!Number.isFinite(now) || now < lastNow) lose('Runtime link clock discontinuity')
    lastNow = now
  }
  function ready(now: number) {
    clock(now)
    if (phase !== 'ready' || !previous) return lose('Runtime handshake required')
    if (now - progressAt > runtimeProtocol.freshnessUs / 1000) return lose('Runtime sample is stale')
    if (sequence >= 0xFFFFFFFF) return lose('Runtime command sequence exhausted; create a new session')
    return previous
  }
  return {
    snapshot() { return { phase, status: previous ? { ...previous } : null, physicalFlightEnabled: false as const } },
    hello(now: number) {
      clock(now)
      const next = (options.nonce ?? nonce64)()
      if (typeof next !== 'bigint' || next <= 0n || next > 0xFFFFFFFFFFFFFFFFn || next === session) return lose('Runtime handshake needs a fresh nonzero nonce')
      session = next; phase = 'handshaking'; sequence = 1; previous = undefined; progressAt = -Infinity
      return encodeRuntimeFrame(commandFrame('hello', sequence, 0n, session))
    },
    accept(bytes: Uint8Array, now: number) {
      clock(now)
      let status: RuntimeFrame
      try { status = decodeRuntimeFrame(bytes) }
      catch { return lose('Incompatible or corrupt runtime status') }
      if ((phase !== 'handshaking' && phase !== 'ready') || status.kind !== 'status' || status.sequence === 0 || status.bootId === 0n || status.sessionId !== session
        || (status.flags & 3) !== 3 || (status.flags & ~127) !== 0 || (status.flags & (runtimeFlags.clockFault | runtimeFlags.deadlineFault)) !== 0
        || !(status.flags & runtimeFlags.sampleValid) || status.ticks === 0 || status.deadlineMisses !== 0
        || status.leaseUs > runtimeProtocol.maxLeaseUs || !!(status.flags & runtimeFlags.leased) !== (status.leaseUs > 0)
        || status.stateBytes === 0 || status.stateBytes > 128 || status.maxExecutionUs > runtimeProtocol.deadlineUs
        || (previous && (status.bootId !== previous.bootId || status.sequence <= previous.sequence || status.sampleTimeUs < previous.sampleTimeUs || status.ticks < previous.ticks
          || (status.sampleTimeUs > previous.sampleTimeUs) !== (status.ticks > previous.ticks))))
        return lose('Runtime identity, capabilities, sequence or health rejected')
      if (!previous || status.sampleTimeUs > previous.sampleTimeUs) progressAt = now
      previous = status; phase = 'ready'
      return { ...status }
    },
    lease(now: number, durationUs: number = runtimeProtocol.maxLeaseUs) {
      const status = ready(now)
      if (!Number.isSafeInteger(durationUs) || durationUs <= 0 || durationUs > runtimeProtocol.maxLeaseUs) return lose('Invalid bench lease duration')
      return encodeRuntimeFrame(commandFrame('lease', ++sequence, status.bootId, session, status.sampleTimeUs, durationUs))
    },
    stop(now: number) {
      const status = ready(now)
      const frame = encodeRuntimeFrame(commandFrame('stop', ++sequence, status.bootId, session, status.sampleTimeUs))
      phase = 'idle'; previous = undefined
      return frame
    },
  }
}
