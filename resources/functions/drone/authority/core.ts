import type { AuthorityCommand, AuthorityObservation, AuthorityState, PositionTarget } from './supervisor'
import { authorityPolicy, authorityTransitions, authorityVersion } from './supervisor'
import type { SensorVector } from '../sensors/types'
import { validVector } from '../controls/model'
export interface AuthorityFrameMetadata { version: 1, bootId: bigint, sessionId: bigint, epoch: number, sequence: number, issuedAtMs: number, expiresAtMs: number }
const active = (s: AuthorityState) => s === 'armed-idle' || s === 'autonomous' || s === 'manual'
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 0xFFFFFFFF
const fresh = (at: number, now: number, age: number) => Number.isFinite(at) && at >= 0 && at <= now && now - at <= age
/** Shared authority lifecycle. Wrappers own actuator units, limits and frame construction. */
export function createAuthorityKernel<Output, Frame>(options: { sessionId: bigint, bootId: bigint, fence: { radiusM: number, minDownM: number, maxDownM: number }, interlockAgeMs?: number, altitudeDatum?: 'WGS84_ELLIPSOID' | 'LOCAL_WATER_SURFACE', validateOutput: (output: Output, atMs: number) => boolean, createFrame: (output: Output, metadata: AuthorityFrameMetadata) => Frame }) {
  if (typeof options.sessionId !== 'bigint' || options.sessionId <= 0n || typeof options.bootId !== 'bigint' || options.bootId <= 0n) throw new TypeError('Positive simulation session and boot IDs required')
  const { sessionId, bootId, validateOutput, createFrame } = options, fence = { ...options.fence }, interlockAgeMs = options.interlockAgeMs ?? authorityPolicy.interlockAgeMs
  if (![fence.radiusM, fence.minDownM, fence.maxDownM].every(Number.isFinite) || fence.radiusM <= 0 || fence.radiusM > 5000 || fence.minDownM >= fence.maxDownM || !Number.isFinite(interlockAgeMs) || interlockAgeMs < 20 || interlockAgeMs > 200) throw new TypeError('Invalid authority profile bounds')
  const altitudeDatum = options.altitudeDatum ?? 'WGS84_ELLIPSOID'
  if (!['WGS84_ELLIPSOID', 'LOCAL_WATER_SURFACE'].includes(altitudeDatum)) throw new TypeError('Invalid authority altitude datum')
  const insideFence = (p: unknown) => validVector(p) && Math.hypot(p[0], p[1]) <= fence.radiusM && p[2] >= fence.minDownM && p[2] <= fence.maxDownM
  let state: AuthorityState = 'disarmed', epoch = 0, sequence = -1, outputSequence = 0
  let lastNow: number | null = null, lastGatedAt: number | null = null, leaseUntilMs: number | null = null, target: PositionTarget | null = null, reference: string | null = null
  let reason = 'startup', commandAccepted = false
  const events: { atMs: number | null, from: AuthorityState, to: AuthorityState, reason: string, epoch: number }[] = []
  function transition(to: AuthorityState, why: string, eventAtMs: number | null = lastNow) {
    reason = why
    if (to === state) return
    const from = state
    state = to
    epoch = Math.min(0xFFFFFFFF, epoch + 1)
    leaseUntilMs = null; target = null
    events.push({ atMs: eventAtMs, from, to, reason: why, epoch })
    if (events.length > 64) events.shift()
  }
  function fault(why: string) { if (state !== 'killed') transition('failsafe', why) }
  function snapshot() {
    return { version: authorityVersion, state, epoch, sessionId, bootId, sequence, lastCheckedAtMs: lastNow, reason, commandAccepted, leaseUntilMs, target: target ? { ...target, positionM: [...target.positionM] as SensorVector } : null, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, events: events.map(e => ({ ...e })) }
  }
  function hazard(o: AuthorityObservation): string | null {
    const now = o.nowMs, e = o.estimate, a = e?.attitude, p = e?.localPosition
    if (o.kind !== 'simulation') return 'simulation-only'
    if (o.runtime.bootId !== bootId || e?.bootId !== bootId) return 'board-boot-changed'
    if (!fresh(o.runtime.capturedAtMs, now, authorityPolicy.runtimeAgeMs) || !o.runtime.watchdogHealthy) return 'runtime-watchdog'
    if (!fresh(o.interlocks.capturedAtMs, now, interlockAgeMs)) return 'stale-interlocks'
    if (!fresh(o.rc.capturedAtMs, now, authorityPolicy.rcAgeMs) || !o.rc.connected) return 'rc-loss'
    if (!fresh(o.link.capturedAtMs, now, authorityPolicy.linkAgeMs) || !o.link.connected) return 'link-loss'
    if (!fresh(o.battery.capturedAtMs, now, authorityPolicy.batteryAgeMs) || !Number.isFinite(o.battery.remainingPercent) || o.battery.remainingPercent < 0 || o.battery.remainingPercent > 100) return 'invalid-battery'
    if (o.battery.remainingPercent <= authorityPolicy.reservePercent) return 'battery-reserve'
    if (!e || e.evidence !== 'fixture' || e.physicalFlightEnabled !== false || e.nowMs !== now || !e.health.tilt || !e.health.localPosition || !a || !p || !Object.values(e.resets).every(integer)) return 'estimator-loss'
    if (a.capturedAtMs === null || !fresh(a.capturedAtMs, now, 60) || p.capturedAtMs === null || !fresh(p.capturedAtMs, now, 200) || !fresh(p.predictedToMs, now, 40)) return 'stale-estimator'
    if (a.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== altitudeDatum || !validVector(p.velocityMps) || a.quaternionWxyz.length !== 4 || !a.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...a.quaternionWxyz) - 1) > 1e-6 || !p.origin || !Object.values(p.origin).every(Number.isFinite)) return 'invalid-estimator-frame'
    if (!insideFence(p.positionM)) return 'fence-breach'
    if (active(state) && reference !== null && JSON.stringify([e.resets, p.origin]) !== reference) return 'estimator-reference-changed'
    return null
  }
  return {
    snapshot,
    update(o: AuthorityObservation, command?: AuthorityCommand) {
      commandAccepted = false
      const observedEpoch = epoch
      const validNow = Number.isFinite(o.nowMs) && o.nowMs >= 0 && (lastNow === null || o.nowMs >= lastNow)
      // A modeled independent kill input always wins, including over malformed clocks.
      if (o.interlocks.killActive === true) transition('killed', 'kill-input', validNow ? o.nowMs : lastNow)
      if (!validNow) { if (active(state)) fault('clock-discontinuity'); reason = state === 'killed' ? reason : 'clock-discontinuity'; return snapshot() }
      const gap = lastNow !== null && o.nowMs - lastNow > authorityPolicy.schedulerGapMs
      lastNow = o.nowMs
      if (active(state) && gap) fault('supervisor-schedule-gap')
      const problem = hazard(o)
      if (active(state) && problem) fault(problem)
      if (active(state) && !problem && !o.rc.armSwitch) transition('disarmed', 'rc-disarm')
      if (active(state) && !problem && o.rc.override && state !== 'manual') transition('manual', 'rc-override')
      if (state === 'autonomous' && (leaseUntilMs === null || o.nowMs >= leaseUntilMs)) fault('command-lease-expired')
      if (!command || epoch !== observedEpoch) return snapshot()
      const reject = (why: string, revoke = false) => { if (revoke && active(state)) fault(why); else if (state !== 'killed' && state !== 'failsafe') reason = why; return snapshot() }
      if (command.version !== authorityVersion || command.sessionId !== sessionId || command.bootId !== bootId || command.epoch !== epoch || !integer(command.sequence) || command.sequence <= sequence || !fresh(command.issuedAtMs, o.nowMs, authorityPolicy.commandAgeMs)) return reject('invalid-command-scope-or-time', true)
      sequence = command.sequence
      const next = Object.hasOwn(authorityTransitions[state], command.action) ? authorityTransitions[state][command.action] : undefined
      if (!next) return reject('illegal-transition')
      if (command.action === 'kill') { transition('killed', 'operator-kill'); commandAccepted = true; return snapshot() }
      if (command.action === 'disarm') { transition('disarmed', 'operator-disarm'); reference = null; commandAccepted = true; return snapshot() }
      if (epoch >= 0xFFFFFFFF) return reject('epoch-exhausted', true)
      if (problem) return reject(problem)
      if (command.action === 'reset') {
        if (o.interlocks.killActive || o.rc.armSwitch || o.rc.override || !o.interlocks.onGround || !o.interlocks.motorsStopped) return reject('reset-interlocks')
        transition('disarmed', 'operator-reset'); reference = null
      }
      else if (command.action === 'arm') {
        if (o.interlocks.killActive || !o.rc.armSwitch || o.rc.override || !o.interlocks.onGround || !o.interlocks.motorsStopped) return reject('arming-interlocks')
        reference = JSON.stringify([o.estimate.resets, o.estimate.localPosition!.origin])
        transition('armed-idle', 'operator-arm')
      }
      else {
        const t = command.target, lease = command.leaseMs
        if (command.mode !== 'position' || !t || !insideFence(t.positionM) || !Number.isFinite(t.yawRad) || Math.abs(t.yawRad) > Math.PI || !Number.isFinite(lease) || lease! < 20 || lease! > authorityPolicy.maxLeaseMs || command.issuedAtMs + lease! <= o.nowMs) return reject('invalid-target-or-lease', true)
        if (o.rc.override || !o.rc.armSwitch || o.interlocks.killActive) return reject('authority-interlocks', true)
        transition(next, `operator-${command.action}`)
        target = { positionM: [...t.positionM], yawRad: t.yawRad }
        leaseUntilMs = command.issuedAtMs + lease!
      }
      commandAccepted = true
      return snapshot()
    },
    /** Exactly one current controller output per authority observation time. No actuator IO exists here. */
    gate(output: Output, nowMs: number): Frame | null {
      if (state !== 'autonomous') return null
      let valid = false
      try { valid = validateOutput(output, nowMs) } catch { /* Invalid control data must revoke. */ }
      if (lastNow !== nowMs || !Number.isFinite(nowMs) || leaseUntilMs === null || nowMs >= leaseUntilMs || lastGatedAt === nowMs || !valid || outputSequence >= 0xFFFFFFFF) { fault('invalid-or-stale-control-output'); return null }
      lastGatedAt = nowMs
      return createFrame(output, { version: authorityVersion, bootId, sessionId, epoch, sequence: ++outputSequence, issuedAtMs: nowMs, expiresAtMs: Math.min(leaseUntilMs, nowMs + authorityPolicy.outputLeaseMs) })
    },
  }
}
