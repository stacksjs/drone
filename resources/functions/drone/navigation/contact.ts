import type { RigidBodyState } from '../controls/physics'
import { rotateBodyToNed } from '../controls/physics'

export const contactProfiles = ['nominal', 'missing', 'wrong-pad', 'intermittent', 'stale', 'replayed'] as const
export type ContactProfile = typeof contactProfiles[number]
export const contactModel = Object.freeze({ radiusM: 0.15, verticalToleranceM: 0.005, periodMs: 20, delayMs: 60, clockUncertaintyMs: 1, dwellMs: 500, maxAgeMs: 100, maxGapMs: 40, windowMs: 5000, rows: 512, transitions: 64, faultAtMs: 50000 })
export interface ContactBinding { vehicleId: string, sessionId: string, bootId: string, reference: string }
export interface ContactPacket extends ContactBinding {
  version: 1
  evidence: 'modeled-selected-contact'
  model: 'central-shoe-v1'
  padId: string
  sequence: number
  capturedAtMs: number
  deliveredAtMs: number
  clockUncertaintyMs: number
  bit: 0 | 1
}
/** Truth is confined to this declared switch renderer and independent evaluation. */
export function contactGeometry(truth: RigidBodyState) {
  const offset = rotateBodyToNed(truth.quaternionWxyz, [0, 0, 0.1])
  const shoeM = truth.positionM.map((n, i) => n + offset[i]!)
  const horizontalM = Math.hypot(shoeM[0]! - 0.1, shoeM[1]! - 0.06)
  const verticalM = Math.abs(shoeM[2]! + 0.003)
  return { shoeM, horizontalM, verticalM, bit: (horizontalM <= contactModel.radiusM && verticalM <= contactModel.verticalToleranceM ? 1 : 0) as 0 | 1 }
}
/** Independent source clock/latest measurement, not host verification history. */
export function createContactFeed(profile: ContactProfile, binding: ContactBinding) {
  if (!contactProfiles.includes(profile)) throw new TypeError('Invalid contact profile')
  binding = { vehicleId: binding.vehicleId, sessionId: binding.sessionId, bootId: binding.bootId, reference: binding.reference }
  let sequence = 0, now = -1, lastCapture = -1, replaySent = false
  let latest: ContactPacket | null = null, previousCapture: ContactPacket | null = null, penultimate: ContactPacket | null = null
  const queue: ContactPacket[] = []
  return {
    capture(atMs: number, truth: RigidBodyState) {
      if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs <= lastCapture) throw new RangeError('Invalid contact capture clock')
      if (atMs % contactModel.periodMs !== 0) return
      lastCapture = atMs
      sequence++
      if (profile === 'missing' || (profile === 'stale' || profile === 'replayed') && atMs >= contactModel.faultAtMs) return
      if (queue.length >= 8) throw new RangeError('Modeled contact queue exhausted')
      const packet: ContactPacket = { ...binding, version: 1, evidence: 'modeled-selected-contact', model: 'central-shoe-v1', padId: profile === 'wrong-pad' ? 'other-pad' : 'pad', sequence, capturedAtMs: atMs, deliveredAtMs: atMs + contactModel.delayMs, clockUncertaintyMs: contactModel.clockUncertaintyMs, bit: profile === 'intermittent' && Math.floor(atMs / 100) % 2 === 1 ? 0 : contactGeometry(truth).bit }
      penultimate = previousCapture
      previousCapture = packet
      queue.push(packet)
    },
    advanceTo(atMs: number) {
      if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs < now) throw new RangeError('Invalid contact delivery clock')
      now = atMs
      while (queue[0] && queue[0].deliveredAtMs <= now) latest = queue.shift()!
      if (profile === 'replayed' && now >= contactModel.faultAtMs + contactModel.delayMs && !replaySent && penultimate) {
        latest = penultimate
        replaySent = true
      }
      return latest ? structuredClone(latest) : null
    },
    snapshot() { return { nowMs: now, sequence, queued: queue.length, latest: latest ? structuredClone(latest) : null } },
  }
}

import type { EstimatorSnapshot } from '../estimation/estimator'
import type { AuthorityObservation, createAuthoritySupervisor } from '../authority/supervisor'
import type { createSimulatedOutputWatchdog } from '../authority/watchdog'
import type { NavigationMap } from './perception'
import { validateNavigationMap } from './perception'
import { navigationPolicy } from './planner'

export interface ContactWindowBinding extends ContactBinding { occurrenceId: string, origin: string }
export interface ContactHostObservation {
  nowMs: number
  estimate: EstimatorSnapshot
  interlocks: AuthorityObservation['interlocks']
  authority: ReturnType<ReturnType<typeof createAuthoritySupervisor>['snapshot']>
  board: ReturnType<ReturnType<typeof createSimulatedOutputWatchdog>['snapshot']>
  map: NavigationMap | null
  packet: ContactPacket | null
}
export interface ContactAlignment { dEstM: number, mapUncertaintyM: number, estimateUncertaintyM: number, sumM: number }
export interface ContactVerification {
  binding: ContactWindowBinding
  completedAtMs: number
  deadlineMs: number
  nowMs: number
  phase: 'pending' | 'verified' | 'recovery-required'
  reason: string
  verifiedAtMs: number | null
  candidateCapturedAtMs: number | null
  lastSequence: number
  lastCapturedAtMs: number
  lastSignature: string
  alignment: ContactAlignment | null
  totalRows: number
  totalTransitions: number
  rows: { atMs: number, sequence: number | null, bit: number | null, reason: string, dwellMs: number, alignment: ContactAlignment | null }[]
  transitions: { atMs: number, phase: ContactVerification['phase'], reason: string }[]
}
const contactFresh = (at: number | null, now: number, age: number) => at !== null && Number.isFinite(at) && at >= 0 && at <= now && now - at <= age
/** Current qualified inputs only. Body truth is deliberately absent from this interface. */
export function contactEligibility(o: ContactHostObservation, binding: ContactWindowBinding) {
  const result = (reason: string, fatal = false, alignment: ContactAlignment | null = null) => ({ reason, fatal, alignment })
  const p = o.packet, e = o.estimate, a = o.authority, b = o.board, i = o.interlocks, map = o.map
  const reference = e && `${e.bootId}:${Object.values(e.resets).join(',')}`
  if (String(e?.bootId) !== binding.bootId || reference !== binding.reference || JSON.stringify(e?.localPosition?.origin) !== binding.origin || String(a.sessionId) !== binding.sessionId || String(a.bootId) !== binding.bootId || String(b.bootId) !== binding.bootId) return result('contact-binding-changed', true)
  if (!p) return result('contact-missing')
  if (p.version !== 1 || p.evidence !== 'modeled-selected-contact' || p.model !== 'central-shoe-v1' || p.padId !== 'pad' || p.vehicleId !== binding.vehicleId || p.sessionId !== binding.sessionId || p.bootId !== binding.bootId || p.reference !== binding.reference) return result('contact-binding-changed', true)
  if (!Number.isSafeInteger(p.sequence) || p.sequence < 1 || p.sequence > 0xFFFFFFFF || !Number.isSafeInteger(p.capturedAtMs) || p.capturedAtMs < 0 || !Number.isSafeInteger(p.deliveredAtMs) || p.deliveredAtMs !== p.capturedAtMs + contactModel.delayMs || p.clockUncertaintyMs !== contactModel.clockUncertaintyMs || ![0, 1].includes(p.bit) || p.capturedAtMs > o.nowMs || p.deliveredAtMs > o.nowMs) return result('contact-packet-invalid', true)
  if (o.nowMs - p.capturedAtMs + p.clockUncertaintyMs > contactModel.maxAgeMs) return result('contact-stale')
  if (a.lastCheckedAtMs !== o.nowMs || b.lastCheckedAtMs !== o.nowMs || a.state !== 'disarmed' || a.target !== null || a.leaseUntilMs !== null || b.fault !== null || b.motorsN.some(n => n !== 0)) return result('contact-authority-not-neutral')
  if (!contactFresh(i.capturedAtMs, o.nowMs, 20) || i.killActive !== false || i.onGround !== true || i.motorsStopped !== true) return result('contact-interlocks')
  if (e.nowMs !== o.nowMs || !e.health.tilt || !e.health.localPosition || !e.attitude || !e.localPosition || !contactFresh(e.attitude.capturedAtMs, o.nowMs, 60) || !contactFresh(e.localPosition.capturedAtMs, o.nowMs, 200) || !contactFresh(e.localPosition.predictedToMs, o.nowMs, 40) || e.localPosition.velocityMps.length !== 3 || !e.localPosition.velocityMps.every(Number.isFinite) || Math.hypot(...e.localPosition.velocityMps) >= 0.05) return result('contact-estimate-unqualified')
  try { validateNavigationMap(map!) }
  catch { return result('contact-map-unqualified') }
  if (!map || map.reference !== binding.reference || !map.landing || map.landing.id !== 'pad' || map.receivedAtMs > o.nowMs || !contactFresh(map.capturedAtMs, o.nowMs, navigationPolicy.maxRangeAgeMs - map.clockUncertaintyMs)) return result('contact-map-unqualified')
  const blocks = e.localPosition.covarianceBlocks
  if (!Array.isArray(blocks) || blocks.length !== 3 || blocks.some(block => !block || !Number.isFinite(block.positionM2) || block.positionM2 < 0) || e.localPosition.positionM.length !== 3 || !e.localPosition.positionM.every(Number.isFinite)) return result('contact-covariance-unqualified')
  const dEstM = Math.hypot(e.localPosition.positionM[0]! - map.landing.positionM[0], e.localPosition.positionM[1]! - map.landing.positionM[1])
  const mapUncertaintyM = map.uncertaintyM, estimateUncertaintyM = 3 * Math.sqrt(blocks[0]!.positionM2 + blocks[1]!.positionM2)
  const alignment = { dEstM, mapUncertaintyM, estimateUncertaintyM, sumM: dEstM + mapUncertaintyM + estimateUncertaintyM }
  if (alignment.sumM > contactModel.radiusM) return result('contact-alignment-unqualified', false, alignment)
  if (p.bit !== 1) return result('contact-open', false, alignment)
  return result('', false, alignment)
}
export function initialContactVerification(binding: ContactWindowBinding, completedAtMs: number, previous?: ContactVerification): ContactVerification {
  return { binding: { ...binding }, completedAtMs, deadlineMs: completedAtMs + contactModel.windowMs, nowMs: completedAtMs, phase: 'pending', reason: 'contact-pending', verifiedAtMs: null, candidateCapturedAtMs: null, lastSequence: 0, lastCapturedAtMs: -1, lastSignature: '', alignment: null, totalRows: previous?.totalRows ?? 0, totalTransitions: previous?.totalTransitions ?? 0, rows: [], transitions: [] }
}
/** Pure reducer; pending rows are bounded independently of continuous eligibility checks. */
export function reduceContactVerification(previous: ContactVerification, o: ContactHostObservation): ContactVerification {
  const state = structuredClone(previous)
  function fail(reason: string) {
    state.phase = 'recovery-required'
    state.reason = reason
    state.candidateCapturedAtMs = null
  }
  if (!Number.isSafeInteger(o.nowMs) || o.nowMs < 0 || o.nowMs <= previous.nowMs) fail('contact-clock-invalid')
  else state.nowMs = o.nowMs
  if (previous.phase === 'recovery-required') return state
  const pending = previous.phase === 'pending'
  if (state.phase !== 'recovery-required' && pending && o.nowMs >= state.deadlineMs) fail('contact-timeout')
  if (state.phase !== 'recovery-required') {
    const check = contactEligibility(o, state.binding)
    state.alignment = check.alignment
    const p = o.packet
    const signature = p ? JSON.stringify(p) : ''
    const regressed = p && (p.sequence < state.lastSequence || p.sequence === state.lastSequence && signature !== state.lastSignature || p.sequence > state.lastSequence && p.capturedAtMs <= state.lastCapturedAtMs)
    if (check.fatal) fail(check.reason)
    else if (regressed) fail('contact-replayed')
    else if (check.reason) {
      state.reason = check.reason
      state.candidateCapturedAtMs = null
      if (!pending) fail(check.reason)
    }
    else if (p && p.capturedAtMs >= state.completedAtMs) {
      state.reason = 'contact-positive'
      if (p.sequence > state.lastSequence) {
        if (state.candidateCapturedAtMs === null || p.capturedAtMs - state.lastCapturedAtMs > contactModel.maxGapMs) state.candidateCapturedAtMs = p.capturedAtMs
        if (pending && p.capturedAtMs - state.candidateCapturedAtMs >= contactModel.dwellMs) {
          state.phase = 'verified'
          state.reason = 'contact-verified'
          state.verifiedAtMs = o.nowMs
        }
      }
    }
    else {
      state.reason = 'contact-pre-window'
      state.candidateCapturedAtMs = null
    }
    if (p && !regressed && !check.fatal) {
      state.lastSequence = p.sequence
      state.lastCapturedAtMs = p.capturedAtMs
      state.lastSignature = signature
    }
  }
  if (pending) {
    if (state.totalRows >= contactModel.rows) fail('contact-recording-capacity')
    else {
      state.rows.push({ atMs: o.nowMs, sequence: o.packet?.sequence ?? null, bit: o.packet?.bit ?? null, reason: state.reason, dwellMs: state.candidateCapturedAtMs === null ? 0 : Math.max(0, state.lastCapturedAtMs - state.candidateCapturedAtMs), alignment: state.alignment })
      state.totalRows++
    }
  }
  if (state.phase !== previous.phase) {
    if (state.totalTransitions >= contactModel.transitions) fail('contact-transition-capacity')
    else {
      state.transitions.push({ atMs: o.nowMs, phase: state.phase, reason: state.reason })
      state.totalTransitions++
    }
  }
  return state
}
