import { describe, expect, test } from 'bun:test'
import { exampleVisionCalibration, exampleVisionValidation } from '../../resources/functions/drone/vision/fixtures'
import { createVisionLocalizer } from '../../resources/functions/drone/vision/geometry'
import type { VisionLocalizationInput } from '../../resources/functions/drone/vision/types'

function input(): VisionLocalizationInput {
  const box = { x: 0.45, y: 0.4, width: 0.1, height: 0.2 }
  return {
    nowMs: 1010,
    camera: { cameraId: 'fixture-camera', sessionId: 'camera-session', modeId: '640x480-final-isp', frameSequence: 4, capturedAtMs: 1000, receivedAtMs: 1005 },
    tracking: { state: 'tracking', reason: 'confirmed', sequence: 4, candidates: [{ id: '4:0', label: 'person', confidence: 0.9, box }], selected: { id: 'chosen-lock', box, confidence: 0.9, lastSeenAtMs: 1000, confirmations: 3 }, confirmed: true, observation: { horizontalError: 0, verticalError: 0 }, association: { frameSequence: 4, candidateId: '4:0', capturedAtMs: 1000 } },
    depth: { evidence: 'synthetic', sourceId: 'registered-depth', sequence: 8, calibrationId: 'synthetic-brown5', cameraSessionId: 'camera-session', frameSequence: 4, candidateId: '4:0', capturedAtMs: 1000, receivedAtMs: 1006, pixel: [320, 240], opticalDepthM: 4, sigmaM: 0.03, clockUncertaintyMs: 1 },
    pose: { evidence: 'synthetic', reference: 'ned-origin', capturedAtMs: 1000, positionM: [10, 20, -3], quaternionWxyz: [1, 0, 0, 0], positionSigmaM: 0.03, attitudeSigmaRad: 0.002, clockUncertaintyMs: 1, headingAlignment: 'initial-simulation-north' },
  }
}

describe('calibrated selected-point localization', () => {
  test('projects optical Z through the surveyed body transform and capture-time NED pose', () => {
    const localizer = createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation())
    const observation = localizer.localize(input())
    // Optical [0,0,4] -> body [4.08,0,0], then translate vehicle [10,20,-3].
    expect(observation.positionM).toEqual([14.08, 20, -3])
    expect(observation).toMatchObject({ lockId: 'chosen-lock', candidateId: '4:0', capturedAtMs: 1000, receivedAtMs: 1006, physicalFlightEnabled: false })
    expect(localizer.report).toMatchObject({ samples: 6, minDepthM: 2, maxDepthM: 12, evidence: 'synthetic', physicalCalibrationVerified: false })
    expect(localizer.report.maxErrorM).toBeLessThan(1e-8)
    expect(observation.sigmaM).toBeGreaterThan(0.12)
  })

  test('a metric observation becomes available only after camera, depth and capture pose', () => {
    const localizer = createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation()), packet = input()
    packet.depth!.receivedAtMs = 1009
    const observation = localizer.localize(packet)
    expect(observation.receivedAtMs).toBe(1009)
    expect(observation.capturedAtMs).toBe(1000)
    packet.nowMs = 1008
    expect(() => localizer.localize(packet)).toThrow(/depth age/)
    packet.nowMs = 1010; packet.depth!.receivedAtMs = 1001; packet.camera.receivedAtMs = 1001; packet.pose!.capturedAtMs = 1008
    expect(localizer.localize(packet).receivedAtMs).toBe(1008)
  })

  test('undoes Brown distortion and applies capture heading with independently worked coordinates', () => {
    const packet = input(), pixel: [number, number] = [158.4, 118.8]
    const box = { x: pixel[0] / 640 - 0.025, y: pixel[1] / 480 - 0.05, width: 0.05, height: 0.1 }
    packet.tracking.selected!.box = box; packet.tracking.candidates[0]!.box = { ...box }
    packet.depth!.pixel = pixel; packet.depth!.opticalDepthM = 2
    packet.pose!.quaternionWxyz = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]
    const actual = createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation()).localize(packet)
    // [-0.8,-0.6,2] optical, [2.08,-0.8,-0.6] body, yaw90 => [.8,2.08,-.6] NED.
    expect(actual.positionM[0]).toBeCloseTo(10.8, 9)
    expect(actual.positionM[1]).toBeCloseTo(22.08, 9)
    expect(actual.positionM[2]).toBeCloseTo(-3.6, 9)
  })

  test('maps a declared output crop once, preserving already mapped ISP detection coordinates', () => {
    const calibration = exampleVisionCalibration()
    calibration.output = { width: 320, height: 240, crop: [64, 48, 512, 384] }
    const validation = exampleVisionValidation()
    // Table from subtracting crop origin [64,48] and dividing by scale1.6.
    const pixels: [number, number][] = [[59, 44.25], [261, 44.25], [59, 195.75], [261, 195.75], [109.9, 145.05], [210.1, 94.95]]
    validation.forEach((sample, index) => { sample.pixel = pixels[index]! })
    const packet = input(), box = { x: 59 / 320 - 0.025, y: 44.25 / 240 - 0.05, width: 0.05, height: 0.1 }
    packet.tracking.selected!.box = box; packet.tracking.candidates[0]!.box = { ...box }; packet.depth!.pixel = [59, 44.25]; packet.depth!.opticalDepthM = 2
    const actual = createVisionLocalizer(calibration, validation).localize(packet)
    expect(actual.positionM[0]).toBeCloseTo(12.08, 9)
    expect(actual.positionM[1]).toBeCloseTo(19.2, 9)
    expect(actual.positionM[2]).toBeCloseTo(-3.6, 9)
  })

  test('supports pinhole and all five Brown coefficients using independent decimal tables', () => {
    const cases = [
      { coefficients: [0, 0, 0, 0, 0], pixels: [[160, 120], [480, 120], [160, 360], [480, 360], [240, 280], [400, 200]] },
      // Decimal arithmetic from x'=x(1+k1*r2+k2*r4+k3*r6)+2*p1*x*y+p2*(r2+2*x*x).
      { coefficients: [0.01, 0.001, 0.001, -0.002, 0.0001], pixels: [[159.22975, 119.6723125], [479.85825, 120.0563125], [159.03775, 360.6716875], [480.05025, 360.2876875], [239.839799, 280.0801005], [399.920201, 200.0398995]] },
    ]
    for (const fixture of cases) {
      const calibration = exampleVisionCalibration(), validation = exampleVisionValidation()
      calibration.intrinsics.distortion = fixture.coefficients as [number, number, number, number, number]
      validation.forEach((sample, index) => { sample.pixel = fixture.pixels[index]! as [number, number] })
      expect(createVisionLocalizer(calibration, validation).report.maxErrorM).toBeLessThan(1e-8)
    }
  })

  test('declared bench input retains an unverified physical calibration report and requires surveyed heading', () => {
    const calibration = exampleVisionCalibration(); calibration.evidence = 'declared-bench'
    const localizer = createVisionLocalizer(calibration, exampleVisionValidation()), packet = input()
    packet.depth!.evidence = 'declared-bench'; packet.pose!.evidence = 'declared-bench'
    expect(() => localizer.localize(packet)).toThrow(/heading/)
    packet.pose!.headingAlignment = 'surveyed-body-to-ned'
    expect(localizer.localize(packet).evidence).toBe('declared-bench')
    expect(localizer.report.physicalCalibrationVerified).toBe(false)
  })

  test('retains independent positive uncertainty terms and responds to clock and depth errors', () => {
    const localizer = createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation()), packet = input()
    const initial = localizer.localize(packet)
    // Includes finite depth/pixel/rotation cross terms and a 4.08m lever rotating
    // at 35rad/s through 3ms combined clock uncertainty: angular timing=.4284m.
    expect(initial.sigmaM).toBeCloseTo(0.591291734112160, 10)
    packet.pose!.capturedAtMs -= 10
    // Additional10ms contributes .03m translation +1.428m attitude sweep.
    expect(localizer.localize(packet).sigmaM - initial.sigmaM).toBeCloseTo(1.458, 10)
    packet.depth!.sigmaM = 0.13
    expect(localizer.localize(packet).sigmaM - initial.sigmaM).toBeCloseTo(1.559183913997820, 10)
    // A 10cm range error remains within the independently declared isotropic bound.
    packet.depth!.opticalDepthM = 4.1
    const shifted = localizer.localize(packet)
    expect(Math.hypot(shifted.positionM[0] - 14.08, shifted.positionM[1] - 20, shifted.positionM[2] + 3)).toBeLessThan(shifted.sigmaM)
    const delayedDepth = input(); delayedDepth.depth!.capturedAtMs -= 10
    expect(localizer.localize(delayedDepth).sigmaM - initial.sigmaM).toBeCloseTo(1.448, 10)
  })

  test('rejects pixel uncertainty extending beyond the analytically certified lens domain', () => {
    const calibration = exampleVisionCalibration(), validation = exampleVisionValidation()
    calibration.intrinsics.fx = 200; calibration.intrinsics.fy = 200; calibration.intrinsics.distortion = [0, 0, 0, 0, 0]; calibration.uncertainty.pixelSigmaPx = 10
    const pixels: [number, number][] = [[240, 180], [400, 180], [240, 300], [400, 300], [280, 260], [360, 220]]
    validation.forEach((sample, index) => { sample.pixel = pixels[index]! })
    const localizer = createVisionLocalizer(calibration, validation), packet = input(), box = { x: 0.5 / 640, y: 0.5 / 480, width: 1 / 640, height: 1 / 480 }
    packet.tracking.selected!.box = box; packet.tracking.candidates[0]!.box = { ...box }; packet.depth!.pixel = [1, 1]
    expect(() => localizer.localize(packet)).toThrow(/uncertainty leaves/)
  })

  test('rejects insufficient independent coverage and an optimistic model budget', () => {
    expect(() => createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation().slice(0, 5))).toThrow()
    const oneSided = exampleVisionValidation(); oneSided.forEach(sample => { sample.pixel = [400, 300] })
    expect(() => createVisionLocalizer(exampleVisionCalibration(), oneSided)).toThrow()
    const wrong = exampleVisionValidation(); wrong[0]!.bodyPointM[0] += 0.091
    expect(() => createVisionLocalizer(exampleVisionCalibration(), wrong)).toThrow(/residual/)
    const smallError = exampleVisionValidation(); smallError[0]!.bodyPointM[0] += 0.02
    expect(createVisionLocalizer(exampleVisionCalibration(), smallError).report.maxErrorM).toBeCloseTo(0.02, 8)
  })

  test('rejects malformed lenses, folded distortion, unknown modes and unnormalized extrinsics', () => {
    for (const change of [
      (c: ReturnType<typeof exampleVisionCalibration>) => { c.version = 2 as 1 },
      (c: ReturnType<typeof exampleVisionCalibration>) => { c.intrinsics.distortion = [-0.4, 0, 0, 0, 0] },
      (c: ReturnType<typeof exampleVisionCalibration>) => { c.intrinsics.fx = NaN },
      (c: ReturnType<typeof exampleVisionCalibration>) => { c.extrinsics.quaternionWxyz = [1, 1, 0, 0] },
      (c: ReturnType<typeof exampleVisionCalibration>) => { c.output.crop = [600, 0, 640, 480] },
      (c: ReturnType<typeof exampleVisionCalibration>) => { Object.assign(c.intrinsics, { distortionModel: 'fisheye' }) },
    ]) {
      const calibration = exampleVisionCalibration(); change(calibration)
      expect(() => createVisionLocalizer(calibration, exampleVisionValidation())).toThrow()
    }
    const packet = input(); packet.camera.modeId = 'different-roi'
    expect(() => createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation()).localize(packet)).toThrow(/mode/)
  })

  test('requires the exact current candidate, lock, camera, registered depth and calibrated pose', () => {
    const localizer = createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation())
    const changes: ((p: VisionLocalizationInput) => void)[] = [
      p => { p.tracking.association = null }, p => { p.tracking.confirmed = false }, p => { p.tracking.state = 'lost' },
      p => { p.depth = null }, p => { p.pose = null }, p => { p.depth!.candidateId = '4:1' }, p => { p.depth!.cameraSessionId = 'another-camera' },
      p => { p.depth!.frameSequence = 3 }, p => { p.depth!.calibrationId = 'different-calibration' }, p => { p.depth!.pixel[0] += 1 },
      p => { p.tracking.association!.capturedAtMs-- }, p => { p.tracking.candidates.push({ ...p.tracking.candidates[0]! }) },
      p => { p.pose!.headingAlignment = 'relative-yaw' as 'initial-simulation-north' }, p => { p.pose!.quaternionWxyz = [0, 0, 0, 0] },
      p => { p.depth!.evidence = 'declared-bench' }, p => { p.pose!.evidence = 'declared-bench' },
      p => { p.depth!.opticalDepthM = 1.99 }, p => { p.depth!.opticalDepthM = 12.01 }, p => { p.depth!.sigmaM = 0.01 },
      p => { p.tracking.selected!.confidence = NaN },
    ]
    for (const change of changes) { const packet = input(); change(packet); expect(() => localizer.localize(packet)).toThrow() }
  })

  test('rejects stale, future and unsynchronized capture epochs before output', () => {
    const localizer = createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation())
    const changes: ((p: VisionLocalizationInput) => void)[] = [
      p => { p.nowMs = 1201 }, p => { p.camera.receivedAtMs = 1011 }, p => { p.depth!.receivedAtMs = 1011 },
      p => { p.depth!.receivedAtMs = 999 }, p => { p.depth!.capturedAtMs = 979 }, p => { p.pose!.capturedAtMs = 979 },
      p => { p.pose!.capturedAtMs = 990; p.depth!.capturedAtMs = 990 }, p => { p.pose!.clockUncertaintyMs = 20 },
    ]
    for (const change of changes) { const packet = input(); change(packet); expect(() => localizer.localize(packet)).toThrow() }
  })

  test('capture age includes the combined camera, depth and pose clock uncertainty', () => {
    const localizer = createVisionLocalizer(exampleVisionCalibration(), exampleVisionValidation()), packet = input()
    packet.nowMs = 1197
    expect(localizer.localize(packet).capturedAtMs).toBe(1000)
    packet.nowMs = 1198
    expect(() => localizer.localize(packet)).toThrow(/age uncertainty/)
    packet.nowMs = 1197; packet.depth!.clockUncertaintyMs = 2
    expect(() => localizer.localize(packet)).toThrow(/age uncertainty/)
    packet.depth!.clockUncertaintyMs = 1; packet.pose!.clockUncertaintyMs = 2
    expect(() => localizer.localize(packet)).toThrow(/age uncertainty/)
    packet.pose!.clockUncertaintyMs = 1; packet.depth!.capturedAtMs = 999
    expect(() => localizer.localize(packet)).toThrow(/age uncertainty/)
    packet.depth!.capturedAtMs = 1000; packet.pose!.capturedAtMs = 999
    expect(() => localizer.localize(packet)).toThrow(/age uncertainty/)
    const calibration = exampleVisionCalibration(); calibration.timing.clockUncertaintyMs = 2
    packet.pose!.capturedAtMs = 1000
    expect(() => createVisionLocalizer(calibration, exampleVisionValidation()).localize(packet)).toThrow(/age uncertainty/)
  })

  test('detaches accepted calibration, reports and output arrays from caller mutation', () => {
    const calibration = exampleVisionCalibration(), validation = exampleVisionValidation(), localizer = createVisionLocalizer(calibration, validation)
    calibration.extrinsics.translationM[0] = 2; calibration.intrinsics.fx = 1; validation[0]!.bodyPointM[0] = -99
    localizer.report.maxDepthM = 99
    const first = localizer.localize(input()); first.positionM[0] = -9
    expect(localizer.localize(input()).positionM[0]).toBe(14.08)
    expect(localizer.report.maxDepthM).toBe(12)
  })
})
