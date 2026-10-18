import type { EstimatorSnapshot } from '../estimation/estimator'
import type { SensorVector } from '../sensors/types'
import type { SimulatedControlOutput } from '../controls/controller'
import type { Motors } from '../controls/model'
import { multirotorModel, validVector } from '../controls/model'

export const authorityVersion = 1 as const
export const authorityStates = ['disarmed', 'armed-idle', 'autonomous', 'manual', 'failsafe', 'killed'] as const
export type AuthorityState = typeof authorityStates[number]
export type AuthorityAction = 'arm' | 'engage' | 'renew' | 'disarm' | 'reset' | 'kill'
/** Missing entries are rejected. Hazards and the independent kill input take priority. */
export const authorityTransitions: Readonly<Record<AuthorityState, Readonly<Partial<Record<AuthorityAction, AuthorityState>>>>> = Object.freeze({
  'disarmed': Object.freeze({ arm: 'armed-idle', disarm: 'disarmed', kill: 'killed' }),
  'armed-idle': Object.freeze({ engage: 'autonomous', disarm: 'disarmed', kill: 'killed' }),
  'autonomous': Object.freeze({ renew: 'autonomous', disarm: 'disarmed', kill: 'killed' }),
  'manual': Object.freeze({ disarm: 'disarmed', kill: 'killed' }),
  'failsafe': Object.freeze({ reset: 'disarmed', kill: 'killed' }),
  'killed': Object.freeze({ reset: 'disarmed', kill: 'killed' }),
})
export interface PositionTarget { positionM: SensorVector, yawRad: number }
export interface AuthorityCommand {
  version: 1
  sessionId: bigint
  bootId: bigint
  epoch: number
  sequence: number
  issuedAtMs: number
  action: AuthorityAction
  mode?: 'position'
  target?: PositionTarget
  leaseMs?: number
}
export interface AuthorityObservation {
  kind: 'simulation'
  nowMs: number
  estimate: EstimatorSnapshot
  runtime: { bootId: bigint, capturedAtMs: number, watchdogHealthy: boolean }
  rc: { capturedAtMs: number, connected: boolean, armSwitch: boolean, override: boolean }
  interlocks: { capturedAtMs: number, killActive: boolean, onGround: boolean, motorsStopped: boolean }
  battery: { capturedAtMs: number, remainingPercent: number }
  link: { capturedAtMs: number, connected: boolean }
}
export interface SimulatedActuatorFrame {
  version: 1
  bootId: bigint
  sessionId: bigint
  epoch: number
  sequence: number
  issuedAtMs: number
  expiresAtMs: number
  motorsN: Motors
}
export function validMotors(motors: unknown): motors is Motors {
  return Array.isArray(motors) && motors.length === 4 && motors.every(n => Number.isFinite(n) && n >= 0 && n <= multirotorModel.maxMotorThrustN)
}
export const authorityPolicy = Object.freeze({ commandAgeMs: 100, maxLeaseMs: 100, outputLeaseMs: 60, schedulerGapMs: 40, rcAgeMs: 100, linkAgeMs: 150, batteryAgeMs: 500, runtimeAgeMs: 20, interlockAgeMs: 20, reservePercent: 25, fenceRadiusM: 20, minDownM: -10, maxDownM: 0 })
const active = (s: AuthorityState) => s === 'armed-idle' || s === 'autonomous' || s === 'manual'
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 0xFFFFFFFF
const insideFence = (p: unknown): p is SensorVector => validVector(p) && Math.hypot(p[0], p[1]) <= authorityPolicy.fenceRadiusM && p[2] >= authorityPolicy.minDownM && p[2] <= authorityPolicy.maxDownM
const fresh = (at: number, now: number, age: number) => Number.isFinite(at) && at >= 0 && at <= now && now - at <= age

/** Trusted in-process simulation boundary. Session IDs scope commands, they do not authenticate a network peer. */
export function createAuthoritySupervisor(options: { sessionId: bigint, bootId: bigint }) {
  if (typeof options.sessionId !== 'bigint' || options.sessionId <= 0n || typeof options.bootId !== 'bigint' || options.bootId <= 0n) throw new TypeError('Positive simulation session and boot IDs required')
  const { sessionId, bootId } = options
  let state: AuthorityState = 'disarmed', epoch = 0, sequence = -1, outputSequence = 0
  let lastNow: number | null = null, lastGatedAt: number | null = null, leaseUntilMs: number | null = null, target: PositionTarget | null = null, reference: string | null = null
  let reason = 'startup', commandAccepted = false
  const events: { atMs: number | null, from: AuthorityState, to: AuthorityState, reason: string, epoch: number }[] = []
  function transition(to: AuthorityState, why: string) {
    reason = why
    if (to === state) return
    const from = state
    state = to
    epoch = Math.min(0xFFFFFFFF, epoch + 1)
    leaseUntilMs = null; target = null
    events.push({ atMs: lastNow, from, to, reason: why, epoch })
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
    if (!fresh(o.interlocks.capturedAtMs, now, authorityPolicy.interlockAgeMs)) return 'stale-interlocks'
    if (!fresh(o.rc.capturedAtMs, now, authorityPolicy.rcAgeMs) || !o.rc.connected) return 'rc-loss'
    if (!fresh(o.link.capturedAtMs, now, authorityPolicy.linkAgeMs) || !o.link.connected) return 'link-loss'
    if (!fresh(o.battery.capturedAtMs, now, authorityPolicy.batteryAgeMs) || !Number.isFinite(o.battery.remainingPercent) || o.battery.remainingPercent < 0 || o.battery.remainingPercent > 100) return 'invalid-battery'
    if (o.battery.remainingPercent <= authorityPolicy.reservePercent) return 'battery-reserve'
    if (!e || e.evidence !== 'fixture' || e.physicalFlightEnabled !== false || e.nowMs !== now || !e.health.tilt || !e.health.localPosition || !a || !p || !Object.values(e.resets).every(integer)) return 'estimator-loss'
    if (a.capturedAtMs === null || !fresh(a.capturedAtMs, now, 60) || p.capturedAtMs === null || !fresh(p.capturedAtMs, now, 200) || !fresh(p.predictedToMs, now, 40)) return 'stale-estimator'
    if (a.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'WGS84_ELLIPSOID' || !validVector(p.velocityMps) || a.quaternionWxyz.length !== 4 || !a.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...a.quaternionWxyz) - 1) > 1e-6 || !p.origin || !Object.values(p.origin).every(Number.isFinite)) return 'invalid-estimator-frame'
    if (!insideFence(p.positionM)) return 'fence-breach'
    if (active(state) && reference !== null && JSON.stringify([e.resets, p.origin]) !== reference) return 'estimator-reference-changed'
    return null
  }
  return {
    snapshot,
    update(o: AuthorityObservation, command?: AuthorityCommand) {
      commandAccepted = false
      const observedEpoch = epoch
      // A modeled independent kill input always wins, including over malformed clocks.
      if (o.interlocks.killActive === true) transition('killed', 'kill-input')
      if (!Number.isFinite(o.nowMs) || o.nowMs < 0 || (lastNow !== null && o.nowMs < lastNow)) { if (active(state)) fault('clock-discontinuity'); reason = state === 'killed' ? reason : 'clock-discontinuity'; return snapshot() }
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
    gate(output: SimulatedControlOutput, nowMs: number): SimulatedActuatorFrame | null {
      if (state !== 'autonomous') return null
      if (lastNow !== nowMs || !Number.isFinite(nowMs) || leaseUntilMs === null || nowMs >= leaseUntilMs || lastGatedAt === nowMs || output.atMs !== nowMs || output.kind !== 'simulated-control' || output.inhibited || output.physicalFlightEnabled !== false || output.boardOutputsInhibited !== true || !validMotors(output.motorsN) || outputSequence >= 0xFFFFFFFF) { fault('invalid-or-stale-control-output'); return null }
      lastGatedAt = nowMs
      return { version: authorityVersion, bootId, sessionId, epoch, sequence: ++outputSequence, issuedAtMs: nowMs, expiresAtMs: Math.min(leaseUntilMs, nowMs + authorityPolicy.outputLeaseMs), motorsN: [...output.motorsN] }
    },
  }
}
