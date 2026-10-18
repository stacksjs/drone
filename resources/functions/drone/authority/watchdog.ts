import type { Motors } from '../controls/model'
import type { SimulatedActuatorFrame } from './supervisor'
import { authorityPolicy, validMotors } from './supervisor'

/** Independent modeled board clock and output expiry, not the physical firmware watchdog. */
export function createSimulatedOutputWatchdog(options: { bootId: bigint, sessionId: bigint }) {
  if (typeof options.bootId !== 'bigint' || options.bootId <= 0n || typeof options.sessionId !== 'bigint' || options.sessionId <= 0n) throw new TypeError('Positive board and session IDs required')
  const sessionId = options.sessionId
  let bootId = options.bootId, lastNow: number | null = null, sequence = 0, epoch = -1, expiresAtMs: number | null = null
  let motorsN: Motors = [0, 0, 0, 0], fault: string | null = null
  function zero() { motorsN = [0, 0, 0, 0]; expiresAtMs = null }
  function trip(why: string) { zero(); fault ??= why }
  function snapshot() { return { bootId, lastCheckedAtMs: lastNow, sequence, epoch, expiresAtMs, motorsN: [...motorsN] as Motors, fault, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const } }
  function tick(nowMs: number) {
    if (!Number.isFinite(nowMs) || nowMs < 0 || (lastNow !== null && nowMs < lastNow)) { trip('board-clock-discontinuity'); return snapshot() }
    lastNow = nowMs
    if (expiresAtMs !== null && nowMs >= expiresAtMs) trip('output-lease-expired')
    return snapshot()
  }
  return {
    snapshot, tick,
    accept(frame: SimulatedActuatorFrame, nowMs: number) {
      tick(nowMs)
      if (fault) return false
      if (frame.version !== 1 || frame.bootId !== bootId || frame.sessionId !== sessionId || !Number.isSafeInteger(frame.epoch) || frame.epoch < 0 || frame.epoch > 0xFFFFFFFF || frame.epoch < epoch || !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence || frame.sequence > 0xFFFFFFFF || frame.issuedAtMs !== nowMs || !Number.isFinite(frame.expiresAtMs) || frame.expiresAtMs <= nowMs || frame.expiresAtMs - frame.issuedAtMs > authorityPolicy.outputLeaseMs || !validMotors(frame.motorsN)) { trip('invalid-output-frame'); return false }
      sequence = frame.sequence; epoch = frame.epoch; expiresAtMs = frame.expiresAtMs; motorsN = [...frame.motorsN]
      return true
    },
    revoke() { zero() },
    trip() { trip('board-watchdog') },
    /** A reboot clears modeled outputs but invalidates all frames from the old boot. */
    reboot(nextBootId: bigint) {
      if (typeof nextBootId !== 'bigint' || nextBootId <= bootId) throw new TypeError('Reboot requires a strictly increasing simulation boot ID')
      zero(); bootId = nextBootId; sequence = 0; epoch = -1; fault = null
    },
  }
}
