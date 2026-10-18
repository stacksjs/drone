import type { AuthorityFrameMetadata } from './core'
import { authorityPolicy } from './supervisor'
/** Shared board-side lease simulation. It runs without invoking the host supervisor. */
export function createOutputWatchdogKernel<Frame extends AuthorityFrameMetadata>(options: { bootId: bigint, sessionId: bigint, neutral: number[], valid: (frame: Frame) => boolean, values: (frame: Frame) => number[] }) {
  if (typeof options.bootId !== 'bigint' || options.bootId <= 0n || typeof options.sessionId !== 'bigint' || options.sessionId <= 0n) throw new TypeError('Positive board and session IDs required')
  const { sessionId, valid, values: readValues } = options, neutral = [...options.neutral]
  let bootId = options.bootId, lastNow: number | null = null, sequence = 0, epoch = -1, expiresAtMs: number | null = null, values = [...neutral], fault: string | null = null
  function zero() { values = [...neutral]; expiresAtMs = null }
  function trip(why: string) { zero(); fault ??= why }
  function snapshot() { return { bootId, lastCheckedAtMs: lastNow, sequence, epoch, expiresAtMs, values: [...values], fault, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const } }
  function tick(nowMs: number) {
    if (!Number.isFinite(nowMs) || nowMs < 0 || (lastNow !== null && nowMs < lastNow)) { trip('board-clock-discontinuity'); return snapshot() }
    lastNow = nowMs
    if (expiresAtMs !== null && nowMs >= expiresAtMs) trip('output-lease-expired')
    return snapshot()
  }
  return {
    snapshot, tick,
    accept(frame: Frame, nowMs: number) {
      tick(nowMs)
      if (fault) return false
      let qualified = false
      try { qualified = !!frame && valid(frame) } catch { /* Malformed output is a latched fault. */ }
      if (!qualified || frame.version !== 1 || frame.bootId !== bootId || frame.sessionId !== sessionId || !Number.isSafeInteger(frame.epoch) || frame.epoch < 0 || frame.epoch > 0xFFFFFFFF || frame.epoch < epoch || !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence || frame.sequence > 0xFFFFFFFF || frame.issuedAtMs !== nowMs || !Number.isFinite(frame.expiresAtMs) || frame.expiresAtMs <= nowMs || frame.expiresAtMs - frame.issuedAtMs > authorityPolicy.outputLeaseMs) { trip('invalid-output-frame'); return false }
      sequence = frame.sequence; epoch = frame.epoch; expiresAtMs = frame.expiresAtMs; values = [...readValues(frame)]
      return true
    },
    revoke() { zero() },
    trip() { trip('board-watchdog') },
    reboot(nextBootId: bigint) {
      if (typeof nextBootId !== 'bigint' || nextBootId <= bootId) throw new TypeError('Reboot requires a strictly increasing simulation boot ID')
      zero(); bootId = nextBootId; sequence = 0; epoch = -1; fault = null
    },
  }
}
