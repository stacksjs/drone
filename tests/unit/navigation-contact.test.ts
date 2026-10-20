import { expect, test } from 'bun:test'
import { contactGeometry, createContactFeed } from '../../resources/functions/drone/navigation/contact'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'

const binding = { vehicleId: 'navigation-vehicle', sessionId: '123', bootId: '55', reference: '55:0,0,0,0,0' }

test('selected contact uses the transformed shoe circle and vertical switch with genuine bounded delayed samples', () => {
  const truth = createRigidBody({ positionM: [0.1, 0.06, -0.103] }).snapshot()
  expect(contactGeometry(truth).bit).toBe(1)
  expect(contactGeometry({ ...truth, positionM: [0.3, 0.06, -0.103], groundContact: true }).bit).toBe(0)
  expect(contactGeometry({ ...truth, positionM: [0.1, 0.06, -0.2] }).bit).toBe(0)
  expect(contactGeometry({ ...truth, positionM: [0.1, 0.06, -0.109] }).bit).toBe(0)
  const rotated = contactGeometry({ ...truth, positionM: [0, 0.06, -0.003], quaternionWxyz: [Math.SQRT1_2, 0, Math.SQRT1_2, 0] })
  expect(rotated.bit).toBe(1)
  expect(rotated.shoeM[0]).toBeCloseTo(0.1)
  const source = createContactFeed('nominal', binding)
  source.capture(0, truth)
  expect(source.advanceTo(56)).toBeNull()
  expect(source.advanceTo(60)).toMatchObject({ sequence: 1, capturedAtMs: 0, deliveredAtMs: 60, clockUncertaintyMs: 1, bit: 1, ...binding })
  for (let at = 20; at <= 140; at += 20) source.capture(at, truth)
  expect(source.snapshot().queued).toBe(7)
  expect(source.snapshot().sequence).toBe(8)
  source.capture(160, truth)
  expect(() => source.capture(180, truth)).toThrow(RangeError)
})

import { initialContactVerification, reduceContactVerification } from '../../resources/functions/drone/navigation/contact'
import type { ContactHostObservation } from '../../resources/functions/drone/navigation/contact'
import { createNavigationOccurrenceSession } from '../../resources/functions/drone/navigation/runtime'

// Supplementary pure-policy fixtures only; never injected into the owned runtime.
let policySeed: ReturnType<ReturnType<typeof createNavigationOccurrenceSession>['snapshot']> | undefined
function policyInput(nowMs: number): ContactHostObservation {
  const actual = structuredClone(policySeed ??= createNavigationOccurrenceSession().advanceTo(2000))
  const estimate = actual.estimate
  estimate.nowMs = nowMs
  estimate.attitude!.capturedAtMs = nowMs
  Object.assign(estimate.localPosition!, { capturedAtMs: nowMs, predictedToMs: nowMs, positionM: [0.1, 0.06, -0.1], velocityMps: [0, 0, 0], covarianceBlocks: [0, 1, 2].map(() => ({ positionM2: 0.000001, positionVelocityM2S: 0, velocityM2S2: 0.000001 })) })
  return {
    nowMs, estimate, interlocks: { capturedAtMs: nowMs, onGround: true, motorsStopped: true, killActive: false },
    authority: { ...actual.authority, lastCheckedAtMs: nowMs }, board: { ...actual.board, lastCheckedAtMs: nowMs },
    map: { version: 1, evidence: 'modeled-range', sequence: nowMs + 1, reference: binding.reference, capturedAtMs: nowMs, receivedAtMs: nowMs, latencyMs: 0, clockUncertaintyMs: 1, uncertaintyM: 0.09, coverage: { centerM: [0, 0, 0], radiusM: 8 }, obstacles: [], terrain: { northSlope: -0.03, eastSlope: 0, downAtOriginM: 0 }, landing: { id: 'pad', positionM: [0.1, 0.06, -0.003] } },
    packet: { ...binding, version: 1, evidence: 'modeled-selected-contact', model: 'central-shoe-v1', padId: 'pad', sequence: nowMs / 20, capturedAtMs: nowMs - 60, deliveredAtMs: nowMs, clockUncertaintyMs: 1, bit: 1 },
  }
}
const windowBinding = { ...binding, occurrenceId: 'first', origin: JSON.stringify({ latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }) }

test('pure verifier needs 500ms of distinct qualified captures and retains success beyond its old pending deadline', () => {
  let state = initialContactVerification(windowBinding, 2000)
  for (let now = 2060; now < 2560; now += 20) state = reduceContactVerification(state, policyInput(now))
  expect(state.phase).toBe('pending')
  state = reduceContactVerification(state, policyInput(2560))
  expect(state.phase).toBe('verified')
  expect(state.verifiedAtMs).toBe(2560)
  expect(state.alignment!.sumM).toBeLessThanOrEqual(0.15)
  const rows = state.rows.length
  for (let now = 2580; now <= 7020; now += 20) state = reduceContactVerification(state, policyInput(now))
  expect(state.phase).toBe('verified')
  expect(state.verifiedAtMs).toBe(2560)
  expect(state.rows).toHaveLength(rows)
})

test('pure qualification keeps full covariance and observed interlocks while malformed identity and replay latch', () => {
  const cases: { reason: string, fatal?: boolean, change: (o: ContactHostObservation) => void }[] = [
    { reason: 'contact-interlocks', change: o => { o.interlocks.motorsStopped = false } },
    { reason: 'contact-interlocks', change: o => { o.interlocks.onGround = false } },
    { reason: 'contact-interlocks', change: o => { o.interlocks.capturedAtMs -= 21 } },
    { reason: 'contact-authority-not-neutral', change: o => { o.board.motorsN[0] = 0.1 } },
    { reason: 'contact-authority-not-neutral', change: o => { o.authority.state = 'armed-idle' } },
    { reason: 'contact-estimate-unqualified', change: o => { o.estimate.attitude!.capturedAtMs! -= 61 } },
    { reason: 'contact-estimate-unqualified', change: o => { o.estimate.localPosition!.velocityMps[0] = 0.05 } },
    { reason: 'contact-covariance-unqualified', change: o => { o.estimate.localPosition!.covarianceBlocks[0]!.positionM2 = Number.NaN } },
    { reason: 'contact-alignment-unqualified', change: o => { o.estimate.localPosition!.covarianceBlocks[0]!.positionM2 = 1 } },
    { reason: 'contact-map-unqualified', change: o => { o.map = null } },
    { reason: 'contact-stale', change: o => {
      o.packet!.capturedAtMs -= 40
      o.packet!.deliveredAtMs -= 40
    } },
    { reason: 'contact-binding-changed', fatal: true, change: o => { o.packet!.padId = 'wrong-pad' } },
    { reason: 'contact-binding-changed', fatal: true, change: o => { o.packet!.vehicleId = 'other' } },
    { reason: 'contact-binding-changed', fatal: true, change: o => { o.packet!.bootId = '56' } },
    { reason: 'contact-binding-changed', fatal: true, change: o => { o.packet!.reference = 'changed' } },
    { reason: 'contact-binding-changed', fatal: true, change: o => { o.packet!.model = 'wrong' as 'central-shoe-v1' } },
    { reason: 'contact-packet-invalid', fatal: true, change: o => {
      o.packet!.capturedAtMs = o.nowMs + 20
      o.packet!.deliveredAtMs = o.nowMs + 80
    } },
  ]
  for (const item of cases) {
    const o = policyInput(2060)
    item.change(o)
    const state = reduceContactVerification(initialContactVerification(windowBinding, 2000), o)
    expect(state.reason).toBe(item.reason)
    expect(state.phase).toBe(item.fatal ? 'recovery-required' : 'pending')
    expect(state.candidateCapturedAtMs).toBeNull()
  }
  const boundary = policyInput(2060)
  boundary.map!.uncertaintyM = 0.15
  boundary.estimate.localPosition!.covarianceBlocks.forEach(b => { b.positionM2 = 0 })
  const exact = reduceContactVerification(initialContactVerification(windowBinding, 2000), boundary)
  expect(exact.alignment!.sumM).toBe(0.15)
  expect(exact.reason).toBe('contact-positive')
  boundary.map!.uncertaintyM = 0.150001
  expect(reduceContactVerification(initialContactVerification(windowBinding, 2000), boundary).reason).toBe('contact-alignment-unqualified')
  const first = reduceContactVerification(initialContactVerification(windowBinding, 2000), policyInput(2060))
  const repeat = policyInput(2080)
  repeat.packet = policyInput(2060).packet
  expect(reduceContactVerification(first, repeat).candidateCapturedAtMs).toBe(first.candidateCapturedAtMs)
  repeat.packet!.bit = 0
  const conflict = reduceContactVerification(first, repeat)
  expect(conflict.reason).toBe('contact-replayed')
  expect(conflict.phase).toBe('recovery-required')
  expect(reduceContactVerification(conflict, policyInput(2100)).reason).toBe('contact-replayed')
})

test('one retained selected-site flight opens contact only after actual completion and qualifies the frozen model', () => {
  const session = createNavigationOccurrenceSession({ contact: 'nominal' })
  session.advanceTo(2000)
  session.requestOccurrence({ id: 'first', issuedAtMs: 2000, decision: 'approve' })
  let at = 2020, terminal = session.advanceTo(at)
  for (at = 3000; terminal.mission.taskId !== 'land' && at <= 110000; at += 1000) terminal = session.advanceTo(at)
  for (at = terminal.nowMs + 20; !terminal.terminal && at <= 110000; at += 20) terminal = session.advanceTo(at)
  const settled = session.advanceTo(terminal.nowMs + 2000)
  const geometry = contactGeometry(settled.plant)
  // eslint-disable-next-line no-console
  console.log(`NAVIGATION_CONTACT_NOMINAL ${JSON.stringify({ runtime: Bun.version, completedAtMs: terminal.terminalAtMs, initialContact: terminal.contact, contact: settled.contact, geometry, quaternion: settled.plant.quaternionWxyz, motorsN: settled.plant.motorsN, truthGround: settled.plant.groundContact, estimateCovariance: settled.estimate.localPosition?.covarianceBlocks })}`)
  expect(terminal.mission.state).toBe('completed')
  expect(terminal.contact!.phase).toBe('pending')
  expect(terminal.contact!.currentEligibility).toBe(false)
  expect(settled.contact!.phase).toBe('verified')
  expect(settled.contact!.currentEligibility).toBe(true)
  expect(settled.contact!.verification!.verifiedAtMs).toBeGreaterThan(terminal.terminalAtMs!)
  expect(settled.contact!.verification!.alignment!.sumM).toBeLessThanOrEqual(0.15)
  expect(geometry.bit).toBe(1)
  expect(geometry.horizontalM).toBeLessThanOrEqual(0.15)
  expect(geometry.verticalM).toBeLessThanOrEqual(0.005)
  expect(settled.contact!.interlocks).toMatchObject({ onGround: true, motorsStopped: true, killActive: false, capturedAtMs: settled.nowMs })
  expect(settled.terminal).toEqual(terminal.terminal)
  expect(settled.trace).toEqual(terminal.trace)
  expect(settled.counts.armAccepted).toBe(1)
  expect(settled.counts.engageAccepted).toBe(1)
})

test('pending timeout, repeated samples, capture gaps and finite recording never invent contact dwell or heal a latch', () => {
  const first = reduceContactVerification(initialContactVerification(windowBinding, 2000), policyInput(2060))
  const duplicate = policyInput(2080)
  duplicate.packet = policyInput(2060).packet
  const repeated = reduceContactVerification(first, duplicate)
  expect(repeated.candidateCapturedAtMs).toBe(2000)
  expect(repeated.lastCapturedAtMs).toBe(2000)
  expect(repeated.phase).toBe('pending')
  const gap = reduceContactVerification(first, policyInput(2120))
  expect(gap.candidateCapturedAtMs).toBe(2060)
  const beforeWindow = policyInput(2060)
  beforeWindow.packet!.capturedAtMs = 1980
  beforeWindow.packet!.deliveredAtMs = 2040
  expect(reduceContactVerification(initialContactVerification(windowBinding, 2000), beforeWindow).candidateCapturedAtMs).toBeNull()
  const deadline = reduceContactVerification(initialContactVerification(windowBinding, 2000), policyInput(7000))
  expect(deadline.reason).toBe('contact-timeout')
  expect(deadline.phase).toBe('recovery-required')
  expect(reduceContactVerification(deadline, policyInput(7020))).toEqual({ ...deadline, nowMs: 7020 })
  const full = initialContactVerification(windowBinding, 2000)
  full.totalRows = 512
  const overflow = reduceContactVerification(full, policyInput(2060))
  expect(overflow.phase).toBe('recovery-required')
  expect(overflow.reason).toBe('contact-recording-capacity')
  expect(overflow.rows).toHaveLength(0)
})

import type { ContactProfile } from '../../resources/functions/drone/navigation/contact'
function completedContact(profile: ContactProfile) {
  const session = createNavigationOccurrenceSession({ contact: profile })
  session.advanceTo(2000)
  expect(session.requestOccurrence({ id: 'first', issuedAtMs: 2000, decision: 'approve' }).state).toBe('queued')
  const completed = session.advanceTo(44120)
  expect(completed.mission.state).toBe('completed')
  expect(completed.contact!.phase).toBe('pending')
  return { session, completed }
}

test('actual missing contact waits its full own deadline and neutral tail without truncation or later retry', () => {
  const { session, completed } = completedContact('missing')
  const deadline = completed.contact!.verification!.deadlineMs
  const before = session.advanceTo(deadline - 20)
  expect(before.contact!.phase).toBe('pending')
  const failed = session.advanceTo(deadline)
  expect(failed.contact!.phase).toBe('recovery-required')
  expect(failed.contact!.verification!.reason).toBe('contact-timeout')
  expect(failed.contact!.verification!.rows).toHaveLength(250)
  expect(failed.contact!.verification!.transitions).toHaveLength(1)
  const tail = session.advanceTo(deadline + 2000)
  expect(tail.contact!.verification!.rows).toEqual(failed.contact!.verification!.rows)
  expect(tail.contact!.verification!.transitions).toEqual(failed.contact!.verification!.transitions)
  expect(tail.trace).toEqual(completed.trace)
  expect(tail.plant.motorsN.every(n => n < 0.01)).toBe(true)
  expect(tail.board.motorsN).toEqual([0, 0, 0, 0])
  expect(session.requestOccurrence({ id: 'after-timeout', issuedAtMs: tail.nowMs, decision: 'approve' }).reason).toBe('contact-recovery-required')
  expect(session.advanceTo(tail.nowMs + 20).counts.armAccepted).toBe(1)
  expect(session.requestOccurrence({ id: 'after-timeout', issuedAtMs: tail.nowMs + 20, decision: 'approve' }).reason).toBe('occurrence-consumed')
})

test('actual wrong-pad identity latches at the first post-completion observation without disarming the active route', () => {
  const session = createNavigationOccurrenceSession({ contact: 'wrong-pad' })
  session.advanceTo(2000)
  session.requestOccurrence({ id: 'first', issuedAtMs: 2000, decision: 'approve' })
  const flying = session.advanceTo(6000)
  expect(flying.mission.state).toBe('running')
  expect(flying.authority.state).toBe('autonomous')
  expect(flying.contact!.phase).toBe('awaiting-completion')
  expect(flying.contact!.verification).toBeNull()
  expect(flying.contact!.outcomes).toHaveLength(0)
  const completed = session.advanceTo(44120)
  expect(completed.mission.state).toBe('completed')
  const failed = session.advanceTo(44140)
  expect(failed.contact!.phase).toBe('recovery-required')
  expect(failed.contact!.verification!.reason).toBe('contact-binding-changed')
  expect(failed.contact!.verification!.rows).toHaveLength(1)
  const tail = session.advanceTo(46140)
  expect(tail.trace).toEqual(completed.trace)
  expect(tail.contact!.verification!.transitions).toEqual(failed.contact!.verification!.transitions)
  expect(tail.plant.motorsN.every(n => n < 0.01)).toBe(true)
  expect(tail.board.motorsN).toEqual([0, 0, 0, 0])
  expect(session.requestOccurrence({ id: 'wrong-site', issuedAtMs: 46140, decision: 'approve' }).reason).toBe('contact-recovery-required')
  expect(session.advanceTo(46160).counts.armAccepted).toBe(1)
})

test('actual intermittent contact cannot accumulate separate positive windows and fails only at its own timeout', () => {
  const { session, completed } = completedContact('intermittent')
  const deadline = completed.contact!.verification!.deadlineMs
  expect(session.advanceTo(deadline - 20).contact!.phase).toBe('pending')
  const failed = session.advanceTo(deadline)
  expect(failed.contact!.phase).toBe('recovery-required')
  expect(failed.contact!.verification!.reason).toBe('contact-timeout')
  expect(failed.contact!.verification!.rows).toHaveLength(250)
  expect(failed.contact!.verification!.rows.some(row => row.bit === 1)).toBe(true)
  expect(failed.contact!.verification!.rows.some(row => row.bit === 0)).toBe(true)
  expect(failed.contact!.verification!.rows.every(row => row.dwellMs < 500)).toBe(true)
  const tail = session.advanceTo(deadline + 2000)
  expect(tail.contact!.verification!.transitions).toHaveLength(1)
  expect(tail.plant.motorsN.every(n => n < 0.01)).toBe(true)
  expect(session.requestOccurrence({ id: 'after-intermittent', issuedAtMs: tail.nowMs, decision: 'approve' }).reason).toBe('contact-recovery-required')
  expect(session.advanceTo(tail.nowMs + 20).counts.armAccepted).toBe(1)
})

test('actual held stale feedback stays eligible across the old deadline then refuses the next arm after a valid call', () => {
  const { session, completed } = completedContact('stale')
  const verified = session.advanceTo(47000)
  const historical = verified.contact!.outcomes
  const oldDeadline = completed.contact!.verification!.deadlineMs
  const afterDeadline = session.advanceTo(oldDeadline + 20)
  expect(afterDeadline.contact!.phase).toBe('verified')
  expect(afterDeadline.contact!.outcomes).toEqual(historical)
  expect(afterDeadline.contact!.verification!.rows).toEqual(verified.contact!.verification!.rows)
  const call = session.advanceTo(50060)
  const packet = call.contact!.source.latest!
  const request = session.requestOccurrence({ id: 'second', issuedAtMs: 50060, decision: 'approve' })
  const queued = session.snapshot()
  const attempted = session.advanceTo(50080)
  // eslint-disable-next-line no-console
  console.log(`NAVIGATION_CONTACT_STALE_ARM ${JSON.stringify({ packet, oldDeadline, verifiedAtMs: verified.contact!.verification!.verifiedAtMs, callAtMs: call.nowMs, callAgeUpperMs: call.nowMs - packet.capturedAtMs + packet.clockUncertaintyMs, callEligible: call.contact!.currentEligibility, request, attemptAtMs: attempted.nowMs, attemptAgeUpperMs: attempted.nowMs - packet.capturedAtMs + packet.clockUncertaintyMs, reason: attempted.occurrences[1]?.reason, verificationReason: attempted.contact!.verification!.reason, armAccepted: attempted.counts.armAccepted })}`)
  expect(packet.capturedAtMs).toBe(49980)
  expect(packet.deliveredAtMs).toBe(50040)
  expect(call.nowMs - packet.capturedAtMs + packet.clockUncertaintyMs).toBe(81)
  expect(call.contact!.currentEligibility).toBe(true)
  expect(request.state).toBe('queued')
  expect(queued.terminal).toEqual(call.terminal)
  expect(queued.contact!.phase).toBe('verified')
  expect(attempted.contact!.verification!.reason).toBe('contact-stale')
  expect(attempted.occurrences[1]!.state).toBe('refused')
  expect(attempted.occurrences[1]!.attemptedAtMs).toBe(50080)
  expect(attempted.occurrences[1]!.startedAtMs).toBeNull()
  expect(attempted.counts.armAccepted).toBe(1)
  expect(attempted.counts.engageAccepted).toBe(1)
  expect(attempted.trace).toEqual(completed.trace)
  expect(attempted.contact!.outcomes).toEqual(historical)
  expect(attempted.contact!.currentEligibility).toBe(false)
})

test('actual replay profile retains original metadata and latches a genuine sequence regression after verification', () => {
  const { session } = completedContact('replayed')
  const before = session.advanceTo(50040)
  const replayed = session.advanceTo(50060)
  // eslint-disable-next-line no-console
  console.log(`NAVIGATION_CONTACT_REPLAY ${JSON.stringify({ before: before.contact!.source.latest, after: replayed.contact!.source.latest, beforeEligible: before.contact!.currentEligibility, phase: replayed.contact!.phase, reason: replayed.contact!.verification!.reason, history: replayed.contact!.outcomes })}`)
  expect(before.contact!.currentEligibility).toBe(true)
  expect(before.contact!.source.latest!.capturedAtMs).toBe(49980)
  expect(replayed.contact!.source.latest!.capturedAtMs).toBe(49960)
  expect(replayed.contact!.source.latest!.deliveredAtMs).toBe(50020)
  expect(replayed.contact!.source.latest!.sequence).toBeLessThan(before.contact!.source.latest!.sequence)
  expect(replayed.contact!.phase).toBe('recovery-required')
  expect(replayed.contact!.verification!.reason).toBe('contact-replayed')
  expect(replayed.contact!.outcomes).toEqual(before.contact!.outcomes)
  expect(session.requestOccurrence({ id: 'after-replay', issuedAtMs: 50060, decision: 'approve' }).reason).toBe('contact-recovery-required')
  expect(session.advanceTo(52060).counts.armAccepted).toBe(1)
})

test('pending host silence advances only the independent contact source and board plant beyond its pending deadline', () => {
  const { session, completed } = completedContact('nominal')
  const absent = session.stopHost()
  expect(absent.board).toEqual(completed.board)
  const tail = session.advanceTo(completed.nowMs + 6000)
  expect(tail.contact!.source.sequence).toBeGreaterThan(completed.contact!.source.sequence)
  expect(tail.contact!.source.nowMs).toBe(tail.nowMs)
  expect(tail.contact!.source.latest!.capturedAtMs).toBeGreaterThan(completed.nowMs)
  expect(tail.contact!.verification).toEqual(completed.contact!.verification)
  expect(tail.contact!.outcomes).toEqual(completed.contact!.outcomes)
  expect(tail.contact!.hostObservedAtMs).toBe(completed.contact!.hostObservedAtMs)
  expect(tail.contact!.interlocks).toEqual(completed.contact!.interlocks)
  expect(tail.contact!.phase).toBe('pending')
  expect(tail.contact!.currentEligibility).toBe(false)
  expect(tail.counts).toEqual(completed.counts)
  expect(tail.sensors).toEqual(completed.sensors)
  expect(tail.estimate).toEqual(completed.estimate)
  expect(tail.authority).toEqual(completed.authority)
  expect(tail.trace).toEqual(completed.trace)
  expect(tail.board.lastCheckedAtMs).toBe(tail.nowMs)
  expect(tail.board.motorsN).toEqual([0, 0, 0, 0])
  expect(tail.plant.motorsN.every(n => n < 0.01)).toBe(true)
  expect(completed.plant.motorsN.some(n => n >= 0.01)).toBe(true)
})

test('verified host silence masks current eligibility while preserving historical success and frozen host observations', () => {
  const { session } = completedContact('nominal')
  const verified = session.advanceTo(47000)
  expect(verified.contact!.currentEligibility).toBe(true)
  const absent = session.stopHost()
  expect(absent.contact!.currentEligibility).toBe(false)
  expect(absent.contact!.verification).toEqual(verified.contact!.verification)
  const tail = session.advanceTo(53000)
  expect(tail.contact!.source.sequence).toBeGreaterThan(verified.contact!.source.sequence)
  expect(tail.contact!.source.nowMs).toBe(53000)
  expect(tail.contact!.phase).toBe('verified')
  expect(tail.contact!.verification).toEqual(verified.contact!.verification)
  expect(tail.contact!.outcomes).toEqual(verified.contact!.outcomes)
  expect(tail.contact!.hostObservedAtMs).toBe(47000)
  expect(tail.contact!.interlocks).toEqual(verified.contact!.interlocks)
  expect(tail.contact!.currentEligibility).toBe(false)
  expect(tail.counts).toEqual(verified.counts)
  expect(tail.sensors).toEqual(verified.sensors)
  expect(tail.estimate).toEqual(verified.estimate)
  expect(tail.authority).toEqual(verified.authority)
  expect(tail.board.bootId).toBe(verified.board.bootId)
  expect(tail.board.sequence).toBe(verified.board.sequence)
  expect(tail.board.lastCheckedAtMs).toBe(53000)
  expect(tail.board.motorsN).toEqual([0, 0, 0, 0])
})

test('pending, off-host-epoch and denied second requests are consumed without retiring verified contact or inventing host work', () => {
  const pending = completedContact('nominal')
  expect(pending.session.requestOccurrence({ id: 'early', issuedAtMs: 44120, decision: 'approve' }).reason).toBe('contact-not-verified')
  const eventually = pending.session.advanceTo(47000)
  expect(eventually.contact!.phase).toBe('verified')
  expect(eventually.counts.armAccepted).toBe(1)
  expect(pending.session.requestOccurrence({ id: 'early', issuedAtMs: 47000, decision: 'approve' }).reason).toBe('occurrence-consumed')
  const off = completedContact('nominal')
  const verified = off.session.advanceTo(47000)
  const between = off.session.advanceTo(47004)
  expect(between.contact!.currentEligibility).toBe(false)
  expect(off.session.requestOccurrence({ id: 'off-epoch', issuedAtMs: 47004, decision: 'approve' }).reason).toBe('contact-observation-not-current')
  const afterCall = off.session.snapshot()
  expect(afterCall.counts).toEqual(between.counts)
  expect(afterCall.authority).toEqual(between.authority)
  expect(afterCall.contact!.verification).toEqual(between.contact!.verification)
  expect(afterCall.terminal).toEqual(verified.terminal)
  expect(off.session.advanceTo(47020).contact!.currentEligibility).toBe(true)
  expect(off.session.requestOccurrence({ id: 'off-epoch', issuedAtMs: 47020, decision: 'approve' }).reason).toBe('occurrence-consumed')
  const denied = completedContact('nominal')
  const before = denied.session.advanceTo(47000)
  expect(denied.session.requestOccurrence({ id: 'deny', issuedAtMs: 47000, decision: 'deny' }).reason).toBe('operator-denied')
  expect(denied.session.snapshot().contact).toEqual(before.contact)
  expect(denied.session.advanceTo(47020).contact!.phase).toBe('verified')
  expect(denied.session.snapshot().counts.armAccepted).toBe(1)
})

test('two independently approved contact cycles retain one source and plant and release old eligibility only on successful launch', () => {
  const { session, completed } = completedContact('nominal')
  const first = session.advanceTo(47000)
  expect(first.contact!.phase).toBe('verified')
  const firstHistory = first.contact!.outcomes
  expect(session.requestOccurrence({ id: 'second', issuedAtMs: 47000, decision: 'approve' }).state).toBe('queued')
  expect(session.snapshot().contact).toEqual(first.contact)
  const started = session.advanceTo(47020)
  expect(started.mission.state).toBe('running')
  expect(started.contact!.phase).toBe('awaiting-completion')
  expect(started.contact!.currentEligibility).toBe(false)
  expect(started.contact!.outcomes).toEqual(firstHistory)
  const mid = session.advanceTo(completed.contact!.verification!.deadlineMs + 20)
  expect(mid.contact!.phase).toBe('awaiting-completion')
  expect(mid.contact!.verification!.rows).toEqual(first.contact!.verification!.rows)
  expect(mid.authority.state).toBe('autonomous')
  expect(mid.mission.state).toBe('running')
  const second = session.advanceTo(89120)
  expect(second.mission.state).toBe('completed')
  expect(second.contact!.phase).toBe('pending')
  expect(second.contact!.verification!.binding.occurrenceId).toBe('second')
  expect(second.contact!.verification!.candidateCapturedAtMs).toBeNull()
  expect(second.contact!.verification!.rows).toHaveLength(0)
  expect(second.contact!.outcomes).toEqual(firstHistory)
  const preWindow = session.advanceTo(89140)
  expect(preWindow.contact!.verification!.candidateCapturedAtMs).toBeNull()
  const tail = session.advanceTo(91120)
  // eslint-disable-next-line no-console
  console.log(`NAVIGATION_CONTACT_TWO_CYCLES ${JSON.stringify({ completions: tail.occurrences.map(item => item.terminalAtMs), history: tail.contact!.outcomes, totalRows: tail.contact!.verification!.totalRows, totalTransitions: tail.contact!.verification!.totalTransitions, sourceSequence: tail.contact!.source.sequence, sourcePacketSequence: tail.contact!.source.latest!.sequence, rawSequence: tail.sensors.sensors.find(s => s.kind === 'imu')!.observation!.sequence, outputSequence: tail.board.sequence, bootId: String(tail.board.bootId), usedWh: tail.energy.usedWh, geometry: contactGeometry(tail.plant) })}`)
  expect(tail.contact!.phase).toBe('verified')
  expect(tail.contact!.currentEligibility).toBe(true)
  expect(tail.contact!.outcomes).toHaveLength(2)
  expect(tail.contact!.outcomes[0]).toEqual(firstHistory[0])
  expect(tail.contact!.outcomes[1]!.verifiedAtMs).toBeGreaterThan(second.nowMs)
  expect(tail.contact!.verification!.totalRows).toBeLessThanOrEqual(512)
  expect(tail.counts.armAccepted).toBe(2)
  expect(tail.counts.engageAccepted).toBe(2)
  expect(tail.contact!.source.sequence).toBeGreaterThan(first.contact!.source.sequence)
  expect(tail.board.bootId).toBe(first.board.bootId)
  expect(tail.board.sequence).toBeGreaterThan(first.board.sequence)
  expect(tail.estimate.resets).toEqual(first.estimate.resets)
  expect(tail.energy.usedWh).toBeGreaterThan(first.energy.usedWh)
  expect(tail.occurrences[0]!.result).toEqual(first.occurrences[0]!.result)
  expect(contactGeometry(tail.plant).bit).toBe(1)
  expect(session.requestOccurrence({ id: 'third', issuedAtMs: tail.nowMs, decision: 'approve' }).reason).toBe('occurrence-capacity')
})

test('contact reserves its own full route window and tail without changing default manual shape or global capacity', () => {
  expect(Object.hasOwn(createNavigationOccurrenceSession().snapshot(), 'contact')).toBe(false)
  const late = createNavigationOccurrenceSession({ contact: 'nominal' })
  late.advanceTo(89000)
  expect(late.requestOccurrence({ id: 'late', issuedAtMs: 89000, decision: 'approve' }).reason).toBe('insufficient-session-time')
  expect(late.snapshot().contact!.source.sequence).toBe(0)
  expect(late.snapshot().counts.armAccepted).toBe(0)
  const exact = createNavigationOccurrenceSession({ contact: 'nominal' })
  exact.advanceTo(88980)
  expect(exact.requestOccurrence({ id: 'exact', issuedAtMs: 88980, decision: 'approve' }).state).toBe('queued')
  const frame = exact.advanceTo(89000)
  expect(frame.counts.armAccepted).toBe(1)
  expect(frame.mission.state).toBe('running')
  expect(frame.horizonMs).toBe(180000)
  exact.stopHost()
  const expired = exact.advanceTo(frame.board.expiresAtMs!)
  expect(expired.board.fault).toBe('output-lease-expired')
  expect(expired.board.motorsN).toEqual([0, 0, 0, 0])
  expect(expired.counts).toEqual(frame.counts)
  expect(exact.advanceTo(180000).contact!.source.sequence).toBeLessThanOrEqual(9001)
  expect(() => exact.advanceTo(180004)).toThrow(RangeError)
})
