import type { VisionMetricObservation, VisionPairing, VisionTargetFix } from '../../resources/functions/drone/vision/types'
import { expect, test } from 'bun:test'
import { createVisualTracker } from '../../resources/functions/drone/camera/tracker'
import { createVisionTargetFusion } from '../../resources/functions/drone/vision/fusion'
import { createVisionLocalizer } from '../../resources/functions/drone/vision/geometry'
import { exampleVisionCalibration, exampleVisionValidation } from '../../resources/functions/drone/vision/fixtures'
import { navigationGoal } from '../../resources/functions/drone/navigation/navigator'
import type { NavigationMap } from '../../resources/functions/drone/navigation/perception'
import type { MissionObservation } from '../../resources/functions/drone/missions/engine'

function person(x = 0.3) {
  return { label: 'person' as const, confidence: 0.95, box: { x, y: 0.2, width: 0.2, height: 0.5 } }
}
function selected() {
  const tracker = createVisualTracker()
  tracker.update({ sequence: 1, capturedAtMs: 100, receivedAtMs: 100, detections: [person()] }, 100)
  tracker.select('1:0', 1, 100)
  tracker.update({ sequence: 2, capturedAtMs: 110, receivedAtMs: 110, detections: [person()] }, 110)
  const tracking = tracker.update({ sequence: 3, capturedAtMs: 120, receivedAtMs: 120, detections: [person()] }, 120)
  const pairing: VisionPairing = {
    cameraSessionId: 'camera-session', lockId: tracking.selected!.id, calibrationId: 'calibration', depthSourceId: 'registered-depth',
    targetSourceId: 'gnss', targetSessionId: 'gnss-session', targetId: 'chosen-person', reference: 'fixed-ned-origin',
    visualToTargetOffsetM: [0.2, 0, 0], offsetSigmaM: 0.1,
  }
  const vision: VisionMetricObservation = {
    evidence: 'synthetic', calibrationId: pairing.calibrationId, cameraSessionId: pairing.cameraSessionId, lockId: pairing.lockId,
    candidateId: tracking.association!.candidateId, frameSequence: 3, depthSourceId: pairing.depthSourceId, depthSequence: 10,
    reference: pairing.reference, capturedAtMs: 120, receivedAtMs: 120, validUntilMs: 320, positionM: [10, 0, 0], sigmaM: 0.1, physicalFlightEnabled: false,
  }
  const fix: VisionTargetFix = {
    evidence: 'synthetic', sourceId: pairing.targetSourceId, sessionId: pairing.targetSessionId, targetId: pairing.targetId,
    reference: pairing.reference, sequence: 20, capturedAtMs: 120, receivedAtMs: 120, positionM: [10.4, 0, 0], sigmaM: 0.4,
  }
  const fusion = createVisionTargetFusion()
  return { tracker, tracking, pairing, vision, fix, fusion }
}

test('metres require an explicit operator pairing and conservative covariance intersection', () => {
  const f = selected()
  expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).target).toBeNull()
  expect(f.fusion.pair(f.pairing, f.tracking, 120).state).toBe('paired')
  const result = f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
  expect(result.state).toBe('tracking')
  expect(result.target!.id).toBe('chosen-person')
  expect(result.target!.positionM[0]).toBeCloseTo(10.24, 12)
  expect(result.target!.positionM.slice(1)).toEqual([0, 0])
  // Worked CI: visual variance=(.1+.1)^2=.04, fix=.16; inverse(.5/.04+.5/.16)=.064.
  expect(result.target!.sigmaM).toBeCloseTo(0.25298221281347033, 12)
  expect(result.target!.capturedAtMs).toBe(120)
  expect(result.innovationM).toBeCloseTo(0.2, 12)
  expect(result.physicalFlightEnabled).toBe(false)
})


test('paired loss latches until clear and a new operator pairing', () => {
  const f = selected()
  f.fusion.pair(f.pairing, f.tracking, 120)
  const lost = f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: null, fix: f.fix })
  expect(lost.state).toBe('lost')
  expect(lost.target).toBeNull()
  expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
  expect(f.fusion.pair(f.pairing, f.tracking, 120).state).toBe('lost')
  expect(f.fusion.clear().state).toBe('unpaired')
  expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).target).toBeNull()
  expect(f.fusion.pair(f.pairing, f.tracking, 120).state).toBe('paired')
  expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('tracking')
})

test('malformed unrelated candidates revoke a published target and latch loss without throwing', () => {
  for (const malformed of [null, {}, { ...person(), id: 'unrelated', box: null }, 'sparse']) {
    const f = selected()
    f.fusion.pair(f.pairing, f.tracking, 120)
    expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('tracking')
    if (malformed === 'sparse') f.tracking.candidates.length++
    else (f.tracking.candidates as unknown[]).push(malformed)
    const result = f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
    expect(result.state).toBe('lost')
    expect(result.target).toBeNull()
    f.tracking = f.tracker.snapshot(120)
    expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
    expect(f.fusion.pair(f.pairing, f.tracking, 120).target).toBeNull()
  }
})

test('operator pairing rejects unconfirmed, stale, legacy and mismatched visual selection', () => {
  for (const change of [
    (f: ReturnType<typeof selected>) => { f.tracking.confirmed = false },
    (f: ReturnType<typeof selected>) => { f.tracking.state = 'lost' },
    (f: ReturnType<typeof selected>) => { f.tracking.selected = null },
    (f: ReturnType<typeof selected>) => { delete f.tracking.association },
    (f: ReturnType<typeof selected>) => { f.tracking.association!.candidateId = 'different-person' },
    (f: ReturnType<typeof selected>) => { f.tracking.association!.frameSequence++ },
    (f: ReturnType<typeof selected>) => { f.tracking.observation = null },
    (f: ReturnType<typeof selected>) => { f.tracking.selected!.lastSeenAtMs = 121 },
    (f: ReturnType<typeof selected>) => { f.tracking.selected!.box.x = 0.5 },
    (f: ReturnType<typeof selected>) => { f.pairing.lockId = 'unselected-person' },
    (f: ReturnType<typeof selected>) => { f.pairing.visualToTargetOffsetM = [2, 1, 0] },
    (f: ReturnType<typeof selected>) => { f.pairing.offsetSigmaM = 0 },
    (f: ReturnType<typeof selected>) => { f.pairing.offsetSigmaM = 1.01 },
    (f: ReturnType<typeof selected>) => { f.pairing.targetSessionId = '' },
    (f: ReturnType<typeof selected>) => { f.pairing.reference = 'x'.repeat(2048) },
  ]) {
    const f = selected()
    change(f)
    const result = f.fusion.pair(f.pairing, f.tracking, 120)
    expect(result.state).toBe('lost')
    expect(result.target).toBeNull()
  }
  for (const nowMs of [119, 321, NaN, Infinity, -1]) {
    const f = selected()
    expect(f.fusion.pair(f.pairing, f.tracking, nowMs).state).toBe('lost')
  }
})

test('a paired output requires exact scope, evidence, detection, reference and fresh bounded measurements', () => {
  const changes: ((f: ReturnType<typeof selected>) => void)[] = [
    f => { f.tracking.state = 'lost' }, f => { f.tracking.confirmed = false },
    f => { f.tracking.selected!.id = 'reselected' }, f => { f.tracking.association = null },
    f => { f.vision.cameraSessionId = 'restarted-camera' }, f => { f.vision.calibrationId = 'changed-calibration' },
    f => { f.vision.depthSourceId = 'nearest-obstacle' }, f => { f.vision.lockId = 'other-lock' },
    f => { f.vision.candidateId = 'other-person' }, f => { f.vision.frameSequence = 2 },
    f => { f.vision.capturedAtMs = 119 }, f => { f.vision.receivedAtMs = 121 },
    f => { f.vision.validUntilMs = NaN }, f => { f.vision.validUntilMs = Infinity },
    f => { f.vision.validUntilMs = 119 }, f => { f.vision.validUntilMs = 321 },
    f => { delete (f.vision as Partial<VisionMetricObservation>).validUntilMs },
    f => { f.vision.reference = 'other-origin' }, f => { f.fix.reference = 'other-origin' },
    f => { f.fix.sourceId = 'other-gnss' }, f => { f.fix.sessionId = 'restarted-gnss' },
    f => { f.fix.targetId = 'other-person' }, f => { f.fix.capturedAtMs = 121 },
    f => { f.fix.receivedAtMs = 119 }, f => { f.fix.capturedAtMs = -1 },
    f => { f.fix.evidence = 'declared-bench' }, f => { f.vision.evidence = 'declared-bench' },
    f => { f.fix.sequence = -1 }, f => { f.fix.sequence = 1.5 },
    f => { f.vision.depthSequence = -1 }, f => { f.vision.depthSequence = 1.5 },
    f => { f.vision.sigmaM = 0 }, f => { f.vision.sigmaM = NaN },
    f => { f.fix.sigmaM = 10.01 }, f => { f.fix.positionM[1] = Infinity },
    f => { f.vision.positionM[2] = 5000.1 }, f => { f.fix.positionM[0] = 12 },
    f => { (f.vision as unknown as Record<string, unknown>).physicalFlightEnabled = true },
    f => { (f.fix as unknown as Record<string, unknown>).extra = 'unrecognized' },
  ]
  for (const change of changes) {
    const f = selected()
    f.fusion.pair(f.pairing, f.tracking, 120)
    change(f)
    const result = f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
    expect(result.state).toBe('lost')
    expect(result.target).toBeNull()
  }
  for (const nowMs of [119, 321, NaN, Infinity]) {
    const f = selected()
    f.fusion.pair(f.pairing, f.tracking, 120)
    expect(f.fusion.step({ nowMs, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
  }
  const f = selected()
  f.fusion.pair(f.pairing, f.tracking, 120)
  expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: null }).state).toBe('lost')
})

function advance(f: ReturnType<typeof selected>, capturedAtMs = 130) {
  f.tracking = f.tracker.update({ sequence: 4, capturedAtMs, receivedAtMs: capturedAtMs, detections: [person()] }, capturedAtMs)
  f.vision = { ...f.vision, frameSequence: 4, candidateId: '4:0', depthSequence: 11, capturedAtMs, receivedAtMs: capturedAtMs, validUntilMs: capturedAtMs + 200 }
  f.fix = { ...f.fix, sequence: 21, capturedAtMs, receivedAtMs: capturedAtMs }
}

test('retained packets are idempotent and never refresh capture time or shrink uncertainty', () => {
  const f = selected()
  f.fusion.pair(f.pairing, f.tracking, 120)
  const initial = f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
  for (const nowMs of [120, 140, 200, 300, 320]) {
    const retained = f.fusion.step({ nowMs, tracking: f.tracking, vision: f.vision, fix: f.fix })
    expect(retained).toEqual(initial)
  }
  expect(f.fusion.step({ nowMs: 321, tracking: f.tracking, vision: f.vision, fix: f.fix }).target).toBeNull()
})

test('retained localized observations expire at the full calibration budget and never revive', () => {
  for (const fixture of [
    { maxAgeMs: 200, depthCaptureMs: 1000, poseCaptureMs: 1000, expiryMs: 1197 },
    { maxAgeMs: 80, depthCaptureMs: 999, poseCaptureMs: 998, expiryMs: 1075 },
  ]) {
    const tracker = createVisualTracker()
    tracker.update({ sequence: 1, capturedAtMs: 980, receivedAtMs: 980, detections: [person()] }, 980)
    tracker.select('1:0', 1, 980)
    tracker.update({ sequence: 2, capturedAtMs: 990, receivedAtMs: 990, detections: [person()] }, 990)
    const tracking = tracker.update({ sequence: 3, capturedAtMs: 1000, receivedAtMs: 1005, detections: [person()] }, 1010)
    const calibration = exampleVisionCalibration(); calibration.timing.maxAgeMs = fixture.maxAgeMs
    const vision = createVisionLocalizer(calibration, exampleVisionValidation()).localize({
      nowMs: 1010, tracking,
      camera: { cameraId: calibration.cameraId, sessionId: 'camera-session', modeId: calibration.modeId, frameSequence: 3, capturedAtMs: 1000, receivedAtMs: 1005 },
      depth: { evidence: 'synthetic', sourceId: 'registered-depth', sequence: 8, calibrationId: calibration.id, cameraSessionId: 'camera-session', frameSequence: 3, candidateId: '3:0', capturedAtMs: fixture.depthCaptureMs, receivedAtMs: 1006, pixel: [256, 216], opticalDepthM: 4, sigmaM: 0.03, clockUncertaintyMs: 1 },
      pose: { evidence: 'synthetic', reference: 'fixed-ned-origin', capturedAtMs: fixture.poseCaptureMs, positionM: [0, 0, -1.2], quaternionWxyz: [1, 0, 0, 0], positionSigmaM: 0.03, attitudeSigmaRad: 0.002, clockUncertaintyMs: 1, headingAlignment: 'initial-simulation-north' },
    })
    const f = selected()
    const pairing = { ...f.pairing, lockId: tracking.selected!.id, calibrationId: calibration.id, visualToTargetOffsetM: [0, 0, 0] as [number, number, number] }
    const fix = { ...f.fix, capturedAtMs: 1000, receivedAtMs: 1006, positionM: [...vision.positionM] as [number, number, number] }
    f.fusion.pair(pairing, tracking, 1010)
    expect(f.fusion.step({ nowMs: 1010, tracking, vision, fix }).state).toBe('tracking')
    const boundary = f.fusion.step({ nowMs: fixture.expiryMs, tracking, vision, fix })
    expect(boundary.state).toBe('tracking')
    expect(boundary.target!.validUntilMs).toBe(fixture.expiryMs)
    const map: NavigationMap = { version: 1, evidence: 'modeled-range', sequence: 1, reference: pairing.reference, capturedAtMs: 1000, receivedAtMs: 1006, latencyMs: 6, clockUncertaintyMs: 1, uncertaintyM: 0.045, coverage: { centerM: [0, 0, -1.2], radiusM: 8 }, obstacles: [], terrain: { northSlope: 0, eastSlope: 0, downAtOriginM: 0 }, landing: null }
    const mission: MissionObservation = { kind: 'simulation', nowMs: fixture.expiryMs, reference: pairing.reference, origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, healthy: true, positionM: [0, 0, -1.2], velocityMps: [0, 0, 0], authority: 'autonomous', batteryPercent: 90, onGround: false }
    const intent = { mode: 'follow' as const, targetId: pairing.targetId, offsetM: [-2, 0, 0] as [number, number, number], clearanceM: 1.2 }
    expect(() => navigationGoal(intent, mission, map, boundary.target!)).not.toThrow()
    expect(() => navigationGoal(intent, { ...mission, nowMs: fixture.expiryMs + 1 }, map, boundary.target!)).toThrow('lost')
    const lost = f.fusion.step({ nowMs: fixture.expiryMs + 1, tracking, vision, fix })
    expect(lost.state).toBe('lost')
    expect(lost.target).toBeNull()
    expect(f.fusion.step({ nowMs: fixture.expiryMs + 1, tracking, vision: { ...vision, validUntilMs: fixture.expiryMs + 1 }, fix }).target).toBeNull()
  }
})

test('altered retained packets, replay and changed evidence latch loss', () => {
  const changes: ((f: ReturnType<typeof selected>) => void)[] = [
    f => { f.fix.positionM[0] += 0.01 },
    f => { f.fix.receivedAtMs = 121 },
    f => { f.vision.positionM[0] += 0.01 },
    f => { f.vision.receivedAtMs = 121 },
    f => { f.vision.depthSequence++ },
    f => { f.vision.validUntilMs-- },
    f => { f.tracking.selected!.box.x += 0.001; f.tracking.candidates[0]!.box.x += 0.001; f.tracking.observation!.horizontalError += 0.002 },
    f => { advance(f); f.vision.depthSequence = 10 },
    f => { advance(f); f.vision.depthSequence = 9 },
    f => { advance(f); f.fix.sequence = 19 },
    f => { advance(f); f.fix.capturedAtMs = 119 },
    f => { advance(f); f.fix.capturedAtMs = 120 },
    f => { f.vision.evidence = 'declared-bench'; f.fix.evidence = 'declared-bench' },
  ]
  for (const change of changes) {
    const f = selected()
    f.fusion.pair(f.pairing, f.tracking, 120)
    expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('tracking')
    change(f)
    const result = f.fusion.step({ nowMs: 130, tracking: f.tracking, vision: f.vision, fix: f.fix })
    expect(result.state).toBe('lost')
    expect(result.target).toBeNull()
  }
})

test('new packets can progress with either source retained but cannot imply excessive target speed', () => {
  const f = selected()
  f.fusion.pair(f.pairing, f.tracking, 120)
  f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
  advance(f)
  f.vision.positionM[0] += 0.02
  f.fix.positionM[0] += 0.02
  expect(f.fusion.step({ nowMs: 130, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('tracking')
  const g = selected()
  g.fusion.pair(g.pairing, g.tracking, 120)
  g.fusion.step({ nowMs: 120, tracking: g.tracking, vision: g.vision, fix: g.fix })
  advance(g)
  g.vision.positionM[0] += 1
  g.fix.positionM[0] += 1
  expect(g.fusion.step({ nowMs: 130, tracking: g.tracking, vision: g.vision, fix: g.fix }).state).toBe('lost')
})

test('camera crossings, occlusion and spatial identity drift never silently switch the fused target', () => {
  for (const detections of [[person(0.3), person(0.32)], [], [person(0.8)]]) {
    const f = selected()
    f.fusion.pair(f.pairing, f.tracking, 120)
    f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
    f.tracking = f.tracker.update({ sequence: 4, capturedAtMs: 130, receivedAtMs: 130, detections }, 130)
    expect(f.tracking.state).toBe('lost')
    expect(f.fusion.step({ nowMs: 130, tracking: f.tracking, vision: f.vision, fix: f.fix }).target).toBeNull()
    expect(f.tracker.update({ sequence: 5, capturedAtMs: 140, receivedAtMs: 140, detections: [person()] }, 140).state).toBe('lost')
    f.tracker.select('5:0', 5, 140)
    f.tracker.update({ sequence: 6, capturedAtMs: 150, receivedAtMs: 150, detections: [person()] }, 150)
    f.tracking = f.tracker.update({ sequence: 7, capturedAtMs: 160, receivedAtMs: 160, detections: [person()] }, 160)
    expect(f.tracking.confirmed).toBe(true)
    expect(f.tracking.selected!.id).not.toBe(f.pairing.lockId)
    f.pairing.lockId = f.tracking.selected!.id
    f.vision = { ...f.vision, lockId: f.pairing.lockId, frameSequence: 7, candidateId: '7:0', depthSequence: 14, capturedAtMs: 160, receivedAtMs: 160, validUntilMs: 360 }
    f.fix = { ...f.fix, sequence: 24, capturedAtMs: 160, receivedAtMs: 160 }
    expect(f.fusion.step({ nowMs: 160, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
    expect(f.fusion.pair(f.pairing, f.tracking, 160).state).toBe('lost')
    f.fusion.clear()
    f.fusion.pair(f.pairing, f.tracking, 160)
    expect(f.fusion.step({ nowMs: 160, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('tracking')
  }
})

test('skew is bounded and the later source adds target-motion uncertainty at the oldest capture epoch', () => {
  for (const laterSource of ['vision', 'fix']) {
    const f = selected()
    f.fusion.pair(f.pairing, f.tracking, 120)
    const baseline = f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
    if (laterSource === 'vision') {
      const retainedFix = structuredClone(f.fix)
      advance(f, 200)
      f.fix = retainedFix
    }
    else {
      f.fix = { ...f.fix, sequence: 21, capturedAtMs: 200, receivedAtMs: 200 }
    }
    const result = f.fusion.step({ nowMs: 200, tracking: f.tracking, vision: f.vision, fix: f.fix })
    expect(result.state).toBe('tracking')
    expect(result.target!.capturedAtMs).toBe(120)
    expect(result.target!.validUntilMs).toBe(320)
    expect(result.target!.sigmaM).toBeGreaterThan(baseline.target!.sigmaM)
  }
  const f = selected()
  f.fusion.pair(f.pairing, f.tracking, 120)
  f.fix = { ...f.fix, capturedAtMs: 201, receivedAtMs: 201 }
  expect(f.fusion.step({ nowMs: 201, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
})

test('pairing and fusion snapshots are detached from caller mutation', () => {
  const f = selected()
  const paired = f.fusion.pair(f.pairing, f.tracking, 120)
  paired.pairing!.visualToTargetOffsetM[0] = 1
  f.pairing.targetId = 'different-person'
  f.pairing.visualToTargetOffsetM[0] = 1
  const accepted = f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix })
  expect(accepted.target!.id).toBe('chosen-person')
  expect(accepted.target!.positionM[0]).toBeCloseTo(10.24, 12)
  accepted.target!.positionM[0] = 300
  accepted.pairing!.targetId = 'injected'
  expect(f.fusion.snapshot().target!.positionM[0]).toBeCloseTo(10.24, 12)
  expect(f.fusion.snapshot().pairing!.targetId).toBe('chosen-person')
  f.fix.positionM[0] += 0.01
  expect(f.fusion.step({ nowMs: 130, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
})

test('clock reversal and re-pairing an active session require clear', () => {
  const f = selected()
  f.fusion.pair(f.pairing, f.tracking, 120)
  f.fusion.step({ nowMs: 130, tracking: f.tracking, vision: f.vision, fix: f.fix })
  expect(f.fusion.step({ nowMs: 129, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
  const g = selected()
  g.fusion.pair(g.pairing, g.tracking, 120)
  expect(g.fusion.pair({ ...g.pairing, targetId: 'other-person' }, g.tracking, 120).state).toBe('lost')
})

test('fused position and uncertainty must remain inside the published metric bounds', () => {
  const f = selected()
  f.pairing.visualToTargetOffsetM = [1, 0, 0]
  f.vision.positionM = [5000, 0, 0]
  f.fix.positionM = [5000, 0, 0]
  f.fusion.pair(f.pairing, f.tracking, 120)
  expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
  const g = selected()
  g.pairing.offsetSigmaM = 1
  g.vision.sigmaM = 10
  g.fix.sigmaM = 10
  g.fusion.pair(g.pairing, g.tracking, 120)
  expect(g.fusion.step({ nowMs: 120, tracking: g.tracking, vision: g.vision, fix: g.fix }).state).toBe('lost')
})

test('sparse or malformed metric values never escape as a target', () => {
  for (const value of [null, {}, [], [0, 0], new Array(3), [0, undefined, 0], 'position']) {
    const f = selected()
    f.fusion.pair(f.pairing, f.tracking, 120)
    const mutable = f.vision as unknown as Record<string, unknown>
    mutable.positionM = value
    expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
  }
})

test('changing source precision cannot create a faster than qualified fused target', () => {
  const f = selected()
  f.fix.positionM = [11, 0, 0]
  f.fix.sigmaM = 1
  f.fusion.pair(f.pairing, f.tracking, 120)
  expect(f.fusion.step({ nowMs: 120, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('tracking')
  advance(f)
  f.vision.sigmaM = 1
  f.fix.sigmaM = 0.0001
  expect(f.fusion.step({ nowMs: 130, tracking: f.tracking, vision: f.vision, fix: f.fix }).state).toBe('lost')
})
