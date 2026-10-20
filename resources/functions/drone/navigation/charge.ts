import type { AuthorityFrameMetadata } from '../authority/core'
import { createOutputWatchdogKernel } from '../authority/watchdog-core'

export const chargeProfiles = ['nominal', 'no-current', 'current-stuck', 'stuck-relay', 'feedback-loss', 'feedback-replay', 'mains-loss'] as const
export type ChargeProfile = typeof chargeProfiles[number]
export const chargeModel = Object.freeze({ capacityWh: 20, batteryV: 14.8, nodeV: 16, currentA: 2, eta: 0.90, tauS: 0.020, relayMs: 40, periodMs: 20, delayMs: 40, uncertaintyMs: 1, ageMs: 80, gapMs: 40, positiveMs: 1000, verificationMs: 3000, episodeMs: 8000, isolationMs: 1000, isolationDwellMs: 200, startupDeadlineMs: 1000, rows: 512, transitions: 64 })
interface ChargeFrame extends AuthorityFrameMetadata { kind: 'modeled-charge-enable', scope: string, enable: boolean }
/** Exact own data only; never repeatedly read an unknown approval or frame. */
function data(input: unknown, fields: string[]) {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) throw new TypeError('Invalid charge input')
  const d = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(d).length !== fields.length || fields.some(k => !d[k]?.enumerable || !('value' in d[k]!))) throw new TypeError('Invalid charge fields')
  return Object.fromEntries(fields.map(k => [k, d[k]!.value]))
}
interface ChargeApproval { id: string, occurrenceId: string, issuedAtMs: number, decision: 'approve' | 'deny' }
/** Materialize the untrusted boundary before the runtime reads current owned authority. */
export function normalizeChargeApproval(input: unknown): Readonly<ChargeApproval> {
  const v = data(input, ['id', 'occurrenceId', 'issuedAtMs', 'decision'])
  if (typeof v.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(v.id) || typeof v.occurrenceId !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(v.occurrenceId) || !Number.isSafeInteger(v.issuedAtMs) || v.issuedAtMs < 0 || !['approve', 'deny'].includes(v.decision)) throw new TypeError('Invalid charge approval')
  return Object.freeze({ id: v.id, occurrenceId: v.occurrenceId, issuedAtMs: v.issuedAtMs, decision: v.decision })
}
/** Trusted private adapter seam. Runtime owns this handle, never an options dependency. */
export function createChargeOutputWatchdog(initialScope: string) {
  let scope = initialScope
  const core = createOutputWatchdogKernel<ChargeFrame>({ sessionId: 123n, bootId: 77n, neutral: [0], valid: f => f.kind === 'modeled-charge-enable' && f.scope === scope && typeof f.enable === 'boolean', values: f => [f.enable ? 1 : 0] })
  return {
    snapshot: core.snapshot, tick: core.tick, revoke: core.revoke,
    bindScope(next: string) {
      const s = core.snapshot()
      if (s.fault || s.expiresAtMs !== null || s.values[0] !== 0) throw new TypeError('Charge scope is still active')
      scope = next
    },
    accept(input: unknown, nowMs: number) {
      core.tick(nowMs)
      try {
        const v = data(input, ['version', 'kind', 'scope', 'sessionId', 'bootId', 'epoch', 'sequence', 'issuedAtMs', 'expiresAtMs', 'enable'])
        const own = { version: v.version, kind: v.kind, scope: v.scope, sessionId: v.sessionId, bootId: v.bootId, epoch: v.epoch, sequence: v.sequence, issuedAtMs: v.issuedAtMs, expiresAtMs: v.expiresAtMs, enable: v.enable } as ChargeFrame
        return core.accept(own, nowMs)
      }
      catch {
        core.trip()
        return false
      }
    },
  }
}

/** Independent physical model. Endpoint changes cannot create energy in the prior interval. */
export function createChargePlant(profile: ChargeProfile) {
  let now = 0, relayClosed = false, requested = false, pending: { atMs: number, closed: boolean } | null = null, stuck = false
  let currentA = 0, nodeV = 0, currentTarget = 0, nodeTarget = 0, storedWh: number = chargeModel.capacityWh
  let grossGainWh = 0, loadWh = 0, capacityLossWh = 0, firstAcceptedAtMs: number | null = null, mains = true
  function snapshot() { return { nowMs: now, relayClosed, currentA, nodeV, batteryV: chargeModel.batteryV, storedWh, grossGainWh, loadWh, capacityLossWh, mains, packC: 25, chargerC: 25, dry: true, precipitation: false, pendingRelayAtMs: pending?.atMs ?? null, firstAcceptedAtMs } }
  return {
    snapshot,
    tick(atMs: number, enable: number, consumedWh: number, acceptedAtMs: number | null) {
      if (!Number.isSafeInteger(atMs) || atMs < now || (atMs !== now && atMs - now !== 4) || ![0, 1].includes(enable) || !Number.isFinite(consumedWh) || consumedWh < 0) throw new RangeError('Invalid independent charge step')
      const dt = (atMs - now) / 1000, decay = Math.exp(-dt / chargeModel.tauS)
      const integralASeconds = currentTarget * dt + (currentA - currentTarget) * chargeModel.tauS * (1 - decay)
      const gain = chargeModel.eta * chargeModel.batteryV * Math.max(integralASeconds, 0) / 3600
      grossGainWh += gain
      loadWh += consumedWh
      const nextStored = storedWh + gain - consumedWh
      capacityLossWh += Math.max(0, nextStored - chargeModel.capacityWh)
      storedWh = Math.max(0, Math.min(chargeModel.capacityWh, nextStored))
      currentA = currentTarget + (currentA - currentTarget) * decay
      nodeV = nodeTarget + (nodeV - nodeTarget) * decay
      now = atMs
      firstAcceptedAtMs ??= acceptedAtMs
      mains = !(profile === 'mains-loss' && firstAcceptedAtMs !== null && now >= firstAcceptedAtMs + 2000)
      const desired = enable === 1
      if (desired !== requested) {
        requested = desired
        pending = requested === relayClosed ? null : { atMs: now + chargeModel.relayMs, closed: requested }
      }
      if (pending && pending.atMs <= now) {
        if (pending.closed) {
          relayClosed = true
          if (profile === 'stuck-relay') stuck = true
        }
        else if (!stuck) relayClosed = false
        pending = null
      }
      currentTarget = relayClosed && mains && profile !== 'no-current' && profile !== 'current-stuck' ? chargeModel.currentA : 0
      nodeTarget = relayClosed && mains ? chargeModel.nodeV : 0
      return snapshot()
    },
  }
}

import type { EstimatorSnapshot } from '../estimation/estimator'
import type { AuthorityObservation, createAuthoritySupervisor } from '../authority/supervisor'
import type { createSimulatedOutputWatchdog } from '../authority/watchdog'
import type { ContactVerification } from './contact'
interface Instrument {
  version: 1, kind: 'modeled-charge-instruments', model: 'partial-pack-v1', vehicleId: 'navigation-vehicle', padId: 'pad', sessionId: string, bootId: string, chargerBootId: '77', reference: string,
  sequence: number, capturedAtMs: number, deliveredAtMs: number, clockUncertaintyMs: 1,
  batteryV: number, currentA: number, nodeV: number, packWh: number, relayClosed: boolean, mains: boolean, packC: number, chargerC: number, dry: boolean, precipitation: boolean,
}
/** Pure instrument qualification; runtime observations stay encapsulated by the domain. */
export function qualifyChargeEnvironment(p: Pick<Instrument, 'mains' | 'dry' | 'precipitation' | 'packC' | 'chargerC' | 'batteryV'>) {
  return p.mains && p.dry && !p.precipitation && p.packC >= 5 && p.packC <= 40 && p.chargerC >= 5 && p.chargerC <= 50 && p.batteryV >= 14 && p.batteryV <= 15.5 && p.batteryV === chargeModel.batteryV
}
export interface OwnedChargeHostObservation {
  nowMs: number, usedWh: number, estimate: EstimatorSnapshot,
  authority: ReturnType<ReturnType<typeof createAuthoritySupervisor>['snapshot']>,
  board: ReturnType<ReturnType<typeof createSimulatedOutputWatchdog>['snapshot']>,
  interlocks: AuthorityObservation['interlocks'], contactEligible: boolean, contactVerification: ContactVerification | null,
  occurrenceId: string | null, flightQueued: boolean,
}
interface Episode {
  id: string, occurrenceId: string, issuedAtMs: number, decision: 'approve' | 'deny', requestedAtMs: number,
  state: 'queued' | 'refused' | 'pending' | 'verified' | 'isolating' | 'isolated' | 'recovery-required', reason: string,
  attemptedAtMs: number | null, startedAtMs: number | null, verifiedAtMs: number | null, isolatedAtMs: number | null,
  scope: string | null, loadBaselineWh: number, creditWh: number,
}
const fresh = (captured: number | null, now: number, age: number) => captured !== null && Number.isFinite(captured) && captured >= 0 && captured <= now && now - captured <= age
const quantize = (n: number, resolution: number) => Math.round(n / resolution) * resolution
/** One retained charge domain. All inputs below are owned runtime observations, never user options dependencies. */
export function createChargeDomain(profile: ChargeProfile) {
  if (!chargeProfiles.includes(profile)) throw new TypeError('Invalid charge profile')
  const output = createChargeOutputWatchdog('unapproved'), plant = createChargePlant(profile)
  let now = 0, sourceSequence = 0, frameSequence = 0, hostUpdates = 0, acceptedFrames = 0, revokes = 0
  let binding: { sessionId: string, bootId: string, reference: string, origin: string } | null = null
  let host: OwnedChargeHostObservation | null = null, hostPacket: Instrument | null = null
  let latest: Instrument | null = null, previousCapture: Instrument | null = null, penultimate: Instrument | null = null, replaySent = false
  const queue: Instrument[] = [], episodes: Episode[] = []
  let queued: Episode | null = null, active: Episode | null = null
  let phase: 'startup' | 'idle' | 'pending' | 'verified' | 'isolating' | 'recovery-required' = 'startup', reason = 'charge-startup-isolation'
  let latch: string | null = null, firstAcceptedAtMs: number | null = null
  let offRequestedAtMs = 0, offObservedAtMs: number | null = 0, isolationDeadlineMs: number = chargeModel.startupDeadlineMs
  let hostOffObservedAtMs: number | null = 0
  let isolationCandidate: number | null = null, electricalIsolation = false, isolatedAtMs: number | null = null
  let lastSequence = 0, lastCapture = -1, signature = '', lastIsolationCapture = -1
  let baseline: Instrument | null = null, previousQualified: Instrument | null = null, lowerWh = 0, upperWh = 0
  let totalCreditWh = 0, priorCreditWh = 0
  const rows: { atMs: number, phase: string, reason: string, sequence: number | null }[] = []
  const transitions: { atMs: number, phase: string, reason: string }[] = []
  function transition(next: typeof phase, why: string) {
    if (phase === next && reason === why) return
    if (transitions.length >= chargeModel.transitions) {
      latch ??= 'charge-transition-capacity'
      phase = 'recovery-required'
      reason = latch
      return
    }
    phase = next
    reason = why
    transitions.push({ atMs: now, phase, reason })
  }
  function beginOff(why: string, fault: boolean) {
    if (fault) latch ??= why
    if (phase !== 'isolating') {
      output.revoke()
      revokes++
      offRequestedAtMs = now
      offObservedAtMs = null
      hostOffObservedAtMs = null
      isolationDeadlineMs = now + chargeModel.isolationMs
      isolationCandidate = null
      lastIsolationCapture = -1
      electricalIsolation = false
      isolatedAtMs = null
      transition('isolating', why)
      if (active) {
        active.state = 'isolating'
        active.reason = why
      }
    }
  }
  function neutral(o: OwnedChargeHostObservation) {
    const e = o.estimate, i = o.interlocks
    return o.nowMs === now && o.authority.lastCheckedAtMs === now && o.board.lastCheckedAtMs === now && o.authority.state === 'disarmed' && o.authority.target === null && o.authority.leaseUntilMs === null && o.board.fault === null && o.board.motorsN.every(n => n === 0)
      && fresh(i.capturedAtMs, now, 20) && i.killActive === false && i.onGround === true && i.motorsStopped === true && e.nowMs === now && e.health.tilt && e.health.localPosition && !!e.attitude && !!e.localPosition
      && (!binding || String(e.bootId) === binding.bootId && `${e.bootId}:${Object.values(e.resets).join(',')}` === binding.reference && JSON.stringify(e.localPosition.origin) === binding.origin)
      && fresh(e.attitude.capturedAtMs, now, 60) && fresh(e.localPosition.capturedAtMs, now, 200) && fresh(e.localPosition.predictedToMs, now, 40) && Math.hypot(...e.localPosition.velocityMps) < .05
  }
  function context(o: OwnedChargeHostObservation) {
    const v = o.contactVerification
    return o.occurrenceId && o.contactEligible && v?.phase === 'verified' && v.binding.occurrenceId === o.occurrenceId ? JSON.stringify([o.occurrenceId, v.binding, v.completedAtMs, v.verifiedAtMs, 'partial-pack-v1', binding]) : null
  }
  function packetReason(p: Instrument | null) {
    if (!p) return 'charge-feedback-missing'
    if (!binding || p.version !== 1 || p.kind !== 'modeled-charge-instruments' || p.model !== 'partial-pack-v1' || p.vehicleId !== 'navigation-vehicle' || p.padId !== 'pad' || p.sessionId !== binding.sessionId || p.bootId !== binding.bootId || p.chargerBootId !== '77' || p.reference !== binding.reference) return 'charge-feedback-binding'
    if (!Number.isSafeInteger(p.sequence) || p.sequence < 1 || !Number.isSafeInteger(p.capturedAtMs) || p.capturedAtMs < 0 || p.deliveredAtMs !== p.capturedAtMs + chargeModel.delayMs || p.clockUncertaintyMs !== 1 || p.deliveredAtMs > now || p.capturedAtMs > now || ![p.batteryV, p.currentA, p.nodeV, p.packWh, p.packC, p.chargerC].every(Number.isFinite) || p.packWh < 0 || p.packWh > 20 || typeof p.relayClosed !== 'boolean' || typeof p.mains !== 'boolean' || typeof p.dry !== 'boolean' || typeof p.precipitation !== 'boolean') return 'charge-feedback-invalid'
    if (p.sequence < lastSequence || p.sequence === lastSequence && JSON.stringify(p) !== signature || p.sequence > lastSequence && p.capturedAtMs <= lastCapture) return 'charge-feedback-replayed'
    if (now - p.capturedAtMs + 1 > chargeModel.ageMs) return 'charge-feedback-stale'
    return ''
  }
  function isolated(p: Instrument) {
    return !p.relayClosed && Math.abs(p.currentA) <= .02 && p.nodeV <= .2 && p.nodeV >= 0 && p.batteryV >= 14 && p.batteryV <= 15.5
  }
  function ready(atMs: number) {
    if (!host || host.nowMs !== atMs || now !== atMs) return 'charge-observation-not-current'
    if (latch || output.snapshot().fault) return 'charge-recovery-required'
    if (queued || phase === 'pending' || phase === 'verified') return 'charge-active'
    if (phase !== 'idle' || !electricalIsolation || packetReason(latest) || !latest || !isolated(latest) || !qualifyChargeEnvironment(latest) || !neutral(host) || active?.startedAtMs !== null && active !== null && !host.contactEligible) return 'charge-not-isolated'
    return ''
  }
  function emit(record: Episode) {
    const epoch = episodes.indexOf(record) + 1
    const own = { version: 1, kind: 'modeled-charge-enable', scope: record.scope!, sessionId: 123n, bootId: 77n, epoch, sequence: ++frameSequence, issuedAtMs: now, expiresAtMs: now + 60, enable: true }
    if (!output.accept(own, now)) {
      beginOff('charge-output-fault', true)
      return false
    }
    acceptedFrames++
    return true
  }
  function recordPending() {
    if (phase !== 'startup' && phase !== 'pending' && phase !== 'isolating') return
    if (rows.length >= chargeModel.rows) {
      beginOff('charge-recording-capacity', true)
      return
    }
    rows.push({ atMs: now, phase, reason, sequence: latest?.sequence ?? null })
  }
  return {
    tick(atMs: number, consumedWh: number) {
      now = atMs
      const board = output.tick(now)
      const physical = plant.tick(now, board.values[0]!, consumedWh, firstAcceptedAtMs)
      if (offObservedAtMs === null && board.values[0] === 0) offObservedAtMs = now
      if (now % chargeModel.periodMs === 0) {
        sourceSequence++
        const fault = firstAcceptedAtMs !== null && now >= firstAcceptedAtMs + 2000
        if (binding && !(fault && (profile === 'feedback-loss' || profile === 'feedback-replay'))) {
          if (queue.length >= 8) throw new RangeError('Modeled charge feedback queue exhausted')
          const p: Instrument = { version: 1, kind: 'modeled-charge-instruments', model: 'partial-pack-v1', vehicleId: 'navigation-vehicle', padId: 'pad', sessionId: binding.sessionId, bootId: binding.bootId, chargerBootId: '77', reference: binding.reference, sequence: sourceSequence, capturedAtMs: now, deliveredAtMs: now + chargeModel.delayMs, clockUncertaintyMs: 1, batteryV: quantize(physical.batteryV, .01), currentA: profile === 'current-stuck' && physical.relayClosed ? 2 : quantize(physical.currentA, .01), nodeV: quantize(physical.nodeV, .01), packWh: quantize(physical.storedWh, .001), relayClosed: physical.relayClosed, mains: physical.mains, packC: physical.packC, chargerC: physical.chargerC, dry: physical.dry, precipitation: physical.precipitation }
          penultimate = previousCapture
          previousCapture = p
          queue.push(p)
        }
      }
      while (queue[0] && queue[0].deliveredAtMs <= now) latest = queue.shift()!
      if (firstAcceptedAtMs !== null && now >= firstAcceptedAtMs + 2000 + chargeModel.delayMs) {
        if (profile === 'feedback-loss') latest = null
        if (profile === 'feedback-replay' && !replaySent && penultimate) {
          latest = penultimate
          replaySent = true
        }
      }
    },
    observe(o: OwnedChargeHostObservation) {
      hostOffObservedAtMs = offObservedAtMs
      host = o
      hostUpdates++
      if (!binding && neutral(o)) binding = { sessionId: String(o.authority.sessionId), bootId: String(o.estimate.bootId), reference: `${o.estimate.bootId}:${Object.values(o.estimate.resets).join(',')}`, origin: JSON.stringify(o.estimate.localPosition!.origin) }
      const error = packetReason(latest), isNew = latest !== null && latest.sequence > lastSequence && !error
      hostPacket = latest ? structuredClone(latest) : null
      const wasPending = phase === 'startup' || phase === 'pending' || phase === 'isolating'
      if (wasPending && rows.length >= chargeModel.rows) beginOff('charge-recording-capacity', true)
      if (phase === 'isolating' && now >= isolationDeadlineMs) {
        latch ??= 'charge-isolation-timeout'
        if (active) {
          active.state = 'recovery-required'
          active.reason = latch
        }
        transition('recovery-required', latch)
      }
      if (phase === 'startup' && now >= chargeModel.startupDeadlineMs) {
        latch ??= 'charge-startup-timeout'
        transition('recovery-required', latch)
      }
      if (phase === 'pending' || phase === 'verified') {
        if (now >= active!.startedAtMs! + chargeModel.episodeMs) beginOff('charge-episode-complete', active!.verifiedAtMs === null)
        else if (phase === 'pending' && now >= active!.startedAtMs! + chargeModel.verificationMs) beginOff('charge-verification-timeout', true)
        else if (output.snapshot().fault) beginOff('charge-output-fault', true)
        else if (error) beginOff(error, true)
        else if (!neutral(o) || !o.contactEligible || context(o) !== active!.scope || o.usedWh !== active!.loadBaselineWh || !qualifyChargeEnvironment(latest!)) beginOff('charge-interlock-loss', true)
        else if (isNew) {
          const p = latest!
          if (!p.relayClosed || p.currentA < 1.5 || p.currentA > 2.005 || p.nodeV < 15 || p.nodeV > 17) {
            if (phase === 'verified') beginOff('charge-current-loss', true)
            else {
              baseline = null
              previousQualified = null
              lowerWh = 0
              upperWh = 0
            }
          }
          else {
            if (!baseline || !previousQualified || p.capturedAtMs - previousQualified.capturedAtMs > chargeModel.gapMs) {
              baseline = p
              previousQualified = p
              lowerWh = 0
              upperWh = 0
            }
            else {
              const a = previousQualified, delta = p.capturedAtMs - a.capturedAtMs
              lowerWh += .9 * Math.max(0, Math.min(a.batteryV - .005, p.batteryV - .005)) * Math.max(0, Math.min(a.currentA - .005, p.currentA - .005)) * Math.max(delta - 2, 0) / 3600000
              upperWh += .9 * Math.max(a.batteryV + .005, p.batteryV + .005) * 2.005 * (delta + 2) / 3600000
              previousQualified = p
            }
            if (p.capturedAtMs - baseline.capturedAtMs >= chargeModel.positiveMs) {
              const delta = p.packWh - baseline.packWh
              if (delta - .001 <= .004 || delta + .001 < lowerWh || delta - .001 > upperWh) beginOff('charge-energy-unverified', true)
              else {
                if (phase === 'pending') {
                  active!.state = 'verified'
                  active!.verifiedAtMs = now
                  active!.reason = 'charge-verified'
                  transition('verified', 'charge-verified')
                }
                active!.creditWh = Math.max(active!.creditWh, Math.min(lowerWh, Math.max(0, delta - .001)))
                totalCreditWh = priorCreditWh + active!.creditWh
              }
            }
          }
        }
      }
      if (phase === 'startup' || phase === 'isolating' || phase === 'idle' || phase === 'recovery-required') {
        if (!error && latest && isolated(latest) && offObservedAtMs !== null && latest.capturedAtMs > Math.max(offRequestedAtMs, offObservedAtMs)) {
          if (isNew) {
            if (isolationCandidate === null || latest.capturedAtMs - lastIsolationCapture > chargeModel.gapMs) isolationCandidate = latest.capturedAtMs
            lastIsolationCapture = latest.capturedAtMs
            if (latest.capturedAtMs - isolationCandidate >= chargeModel.isolationDwellMs) {
              electricalIsolation = true
              isolatedAtMs ??= now
              if (phase === 'startup') transition('idle', 'charge-startup-isolated')
              else if (phase === 'isolating') {
                if (active) {
                  active.isolatedAtMs = now
                  active.state = latch ? 'recovery-required' : 'isolated'
                  active.reason = latch ?? 'charge-isolated'
                }
                transition(latch ? 'recovery-required' : 'idle', latch ?? 'charge-isolated')
              }
            }
          }
        }
        else {
          isolationCandidate = null
          electricalIsolation = false
        }
        if (phase === 'isolating' && now >= isolationDeadlineMs) {
          latch ??= 'charge-isolation-timeout'
          if (active) {
            active.state = 'recovery-required'
            active.reason = latch
          }
          transition('recovery-required', latch)
        }
      }
      if (wasPending) recordPending()
      if (!error && latest) {
        lastSequence = latest.sequence
        lastCapture = latest.capturedAtMs
        signature = JSON.stringify(latest)
      }
      if (queued) {
        const item = queued
        queued = null
        item.attemptedAtMs = now
        item.state = 'refused'
        const qualification = ready(now)
        if (now - item.issuedAtMs > 100) item.reason = 'charge-approval-expired'
        else if (now + 11000 > 180000) item.reason = 'insufficient-charge-time'
        else if (qualification || o.flightQueued || !neutral(o) || !o.contactEligible || context(o) !== item.scope) item.reason = qualification || 'charge-approval-context-changed'
        else {
          active = item
          priorCreditWh = totalCreditWh
          output.bindScope(item.scope!)
          if (emit(item)) {
            item.state = 'pending'
            item.reason = 'charge-verification-pending'
            item.startedAtMs = now
            firstAcceptedAtMs ??= now
            electricalIsolation = false
            offObservedAtMs = null
            hostOffObservedAtMs = null
            baseline = null
            previousQualified = null
            lowerWh = 0
            upperWh = 0
            transition('pending', 'charge-verification-pending')
          }
        }
      }
      else if (phase === 'pending' || phase === 'verified') emit(active!)
    },
    request(v: Readonly<ChargeApproval>, atMs: number, hostAvailable: boolean, flightQueued: boolean) {
      if (episodes.some(e => e.id === v.id)) return { state: 'refused' as const, reason: 'charge-approval-consumed' }
      if (episodes.length >= 2) return { state: 'refused' as const, reason: 'charge-capacity' }
      const item: Episode = { id: v.id, occurrenceId: v.occurrenceId, issuedAtMs: v.issuedAtMs, decision: v.decision, requestedAtMs: atMs, state: 'refused', reason: '', attemptedAtMs: null, startedAtMs: null, verifiedAtMs: null, isolatedAtMs: null, scope: null, loadBaselineWh: host?.usedWh ?? 0, creditWh: 0 }
      episodes.push(item)
      const qualification = ready(atMs)
      if (item.decision === 'deny') item.reason = 'charge-operator-denied'
      else if (item.issuedAtMs > atMs || atMs - item.issuedAtMs > 100) item.reason = 'charge-approval-expired'
      else if (!hostAvailable) item.reason = 'charge-host-unavailable'
      else if (qualification) item.reason = qualification
      else if (!host || !neutral(host) || !host.contactEligible || host.occurrenceId !== item.occurrenceId || flightQueued || !latest || !qualifyChargeEnvironment(latest)) item.reason = 'charge-contact-or-interlock-unqualified'
      else if (atMs + 20 + 11000 > 180000) item.reason = 'insufficient-charge-time'
      else {
        item.scope = context(host)
        item.state = 'queued'
        item.reason = 'awaiting-charge-host-tick'
        queued = item
      }
      return { state: item.state as 'queued' | 'refused', reason: item.reason }
    },
    stop(atMs: number) {
      if (atMs !== now) throw new RangeError('Charge stop clock differs')
      if (queued) {
        active = queued
        queued.state = 'recovery-required'
        queued.reason = 'charge-stopped-unverified'
        queued = null
        beginOff('charge-stopped-unverified', true)
      }
      else if (phase === 'pending' || phase === 'verified') beginOff(active?.verifiedAtMs === null ? 'charge-stopped-unverified' : 'charge-stop-requested', active?.verifiedAtMs === null)
    },
    launchEligibility: ready,
    remainingWh(usedWh: number) { return Math.max(0, Math.min(20, 20 - usedWh + totalCreditWh)) },
    snapshot(hostAvailable: boolean) {
      return structuredClone({ phase, reason, latch, binding, output: output.snapshot(), plant: plant.snapshot(), independent: { offObservedAtMs }, source: { nowMs: now, sequence: sourceSequence, queued: queue.length, latest }, host: { observedAtMs: host?.nowMs ?? null, latest: hostPacket, updates: hostUpdates, acceptedFrames, revokes, rows, transitions, electricalIsolation, isolatedAtMs, offRequestedAtMs, offObservedAtMs: hostOffObservedAtMs, isolationDeadlineMs, baseline, lastQualified: previousQualified, lowerWh, upperWh, verifiedCreditWh: totalCreditWh }, episodes, currentEligibility: hostAvailable && ready(now) === '' })
    },
  }
}
