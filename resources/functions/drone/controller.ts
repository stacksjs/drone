import type { Behavior, Decision, FlightAdapter, FlightLimits, Target } from './types'
import { decide, defaultLimits, validateLimits } from './safety'

/** A finite lease prevents forgotten enable switches from running indefinitely. */
export function createController(adapter: FlightAdapter, behavior: Behavior, options: { targetId: string, limits?: FlightLimits, guard?: (nowMs: number) => string | undefined }) {
  const guard = options.guard
  const targetId = options.targetId
  if (!targetId.trim()) throw new TypeError('Select a target before creating a controller')
  const limits = { ...(options.limits ?? defaultLimits) }
  validateLimits(limits)
  let enabledUntil = -Infinity
  let enabledAt = Infinity
  let target: Target | undefined
  let lastNow = -Infinity
  let closed = false
  return {
    enable(nowMs: number, leaseMs = 1000) {
      if (closed || !Number.isFinite(nowMs) || !Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 5000)
        throw new RangeError('Invalid autonomy lease')
      enabledUntil = nowMs + leaseMs
      enabledAt = nowMs
    },
    setTarget(next: Target) {
      if (closed || next.id !== targetId || !Number.isFinite(next.receivedAtMs)) return
      if (!target || next.receivedAtMs > target.receivedAtMs) target = structuredClone(next)
    },
    tick(nowMs: number): Decision {
      if (closed) return { kind: 'release', reason: 'Controller closed' }
      const clockValid = Number.isFinite(nowMs) && nowMs >= lastNow
      if (!clockValid) enabledUntil = -Infinity
      else lastNow = nowMs
      if (nowMs < enabledAt) enabledUntil = -Infinity
      let decision = decide({ telemetry: adapter.read(), target, targetId, enabled: clockValid && nowMs >= enabledAt && nowMs < enabledUntil, nowMs, behavior, limits })
      if (guard && decision.kind === 'velocity') {
        try {
          const blocked = guard(nowMs)
          if (blocked !== undefined) decision = { kind: 'hold', reason: typeof blocked === 'string' && blocked.trim() ? blocked : 'Invalid motion guard result' }
        }
        catch { decision = { kind: 'hold', reason: 'Motion guard failed' } }
      }
      adapter.send(decision)
      return decision
    },
    disable() {
      enabledUntil = -Infinity
      if (!closed) adapter.send({ kind: 'release', reason: 'Autonomy disabled' })
    },
    close() {
      if (closed) return
      enabledUntil = -Infinity
      adapter.send({ kind: 'release', reason: 'Controller closed' })
      adapter.close()
      closed = true
    },
  }
}
