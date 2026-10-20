import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { RigidBodyState } from '../../resources/functions/drone/controls/physics'
import { cinemaModel, createCinemaRenderer } from '../../resources/functions/drone/cinema/camera'
import { simulateCinema } from '../../resources/functions/drone/cinema/runtime'
import { replayMission } from '../../resources/functions/drone/missions/engine'

// Public function seam: exercises actual mission, delayed joints and exposed images.
// It proves owned fixture behavior, not physical flight, lens control or video synchronization.
test('owned cinema completes one repeatable hover reframe with three admitted measured images', () => {
  const run = simulateCinema()
  expect(run.status).toBe('completed')
  expect(run.reason).toBe('qualified')
  expect(run.physicalFlightEnabled).toBe(false)
  expect(run.physicalGimbalActuationEnabled).toBe(false)
  expect(run.identityAuthenticated).toBe(false)
  expect(run.mission.terminalState).toBe('completed')
  expect(run.mission.terminalReason).toBe('landed')
  expect(run.mission.boardNeutral).toBe(true)
  expect(replayMission(run.mission.trace).snapshot()).toEqual(run.mission.trace.rows.at(-1)!.result)
  expect(run.mission.trace.rows.length).toBeLessThanOrEqual(6001)
  expect(new TextEncoder().encode(JSON.stringify(run.mission.trace) + '\n').length).toBeLessThanOrEqual(8388608)
  expect(run.shot.phase).toBe('completed')
  expect(run.shot.firstFault).toBeNull()
  expect(run.shot.startedAtMs! % 40).toBe(0)
  expect(run.shot.startedAtMs!).toBeLessThanOrEqual(run.shot.latestStartMs!)
  expect(run.shot.completedAtMs).toBe(run.shot.startedAtMs! + 8000)
  expect(run.shot.retirement.atMs).toBe(run.shot.completedAtMs!)
  expect(run.shot.retirement.cause).toBe('shot-completed')
  expect(run.shot.counters).toEqual({ trackingCommands: run.shot.counters.trackingCommands, shutterAttempts: 3, ackReceipts: 3, confirmedCaptures: 3, uncertainCaptures: 0, trackingCommandsAfterRetirement: 0, shutterAttemptsAfterRetirement: 0 })
  expect(run.shot.counters.trackingCommands).toBeGreaterThan(0)
  expect(run.captures.length).toBe(3)
  const offsets = [1000, 3000, 7000], fractions = [379 / 2187, 1, 0]
  for (const [index, capture] of run.captures.entries()) {
    expect(capture.sequence as number).toBe(index + 1)
    expect(capture.shotOffsetMs as number).toBe(offsets[index]!)
    expect(capture.issuedAtMs).toBe(run.shot.startedAtMs! + offsets[index]!)
    expect(capture.capturedAtMs).toBe(capture.issuedAtMs)
    expect(capture.state).toBe('confirmed')
    expect(capture.postStepAdmission).toBe('valid')
    expect(capture.ack!.receivedAtMs).toBe(capture.issuedAtMs + 20)
    expect(capture.ack!.acknowledgedAtMs).toBe(capture.issuedAtMs + 20)
    expect(capture.ack!.reference).toBe('55:0,0,0,0,0')
    expect(capture.pose.capturedAtMs).toBe(capture.issuedAtMs)
    expect(capture.encoder.capturedAtMs).toBe(capture.issuedAtMs - 20)
    expectActualRaster(capture, [4, 0, -1.2])
    const image = capture.image!
    expect(image.width).toBe(64)
    expect(image.height).toBe(48)
    expect(image.rgba.length).toBe(12288)
    let x = 0, y = 0, pixels = 0
    for (let pixel = 0; pixel < 3072; pixel++) {
      const base = pixel * 4
      if (image.rgba[base] === 240 && image.rgba[base + 1] === 20 && image.rgba[base + 2] === 180) { x += pixel % 64 + 0.5; y += Math.floor(pixel / 64) + 0.5; pixels++ }
    }
    expect(pixels).toBeGreaterThan(0)
    const expectedX = 32 - 40 * Math.tan(8 * Math.PI / 180 * fractions[index]!)
    expect(Math.hypot(x / pixels - expectedX, y / pixels - 24)).toBeLessThanOrEqual(2)
    expect(capture.quality.observedPixel).toEqual([x / pixels, y / pixels])
    expect(capture.quality.qualified).toBe(true)
  }
  expect(run.captures[0]!.image!.rgba).not.toEqual(run.captures[1]!.image!.rgba)
  expect(run.encoderObservations[0]!.capturedAtMs).toBe(580)
  expect(run.encoderObservations[0]!.velocityRadS).toBeNull()
  expect(run.gimbal.rows[0]).toEqual({ atMs: 0, requestedAtMs: 0, requestedTorqueNm: [0, 0, 0], appliedTorqueNm: [0, 0, 0], positionRad: [0, 0, 0], velocityRadS: [0, 0, 0], accelerationRadS2: [0, 0, 0] })
  expect(run.gimbal.tail.length).toBe(501)
  const boundary = run.gimbal.rows.at(-1)!, tailStart = run.gimbal.tail[0]!
  expect(tailStart.atMs).toBe(boundary.atMs)
  expect(tailStart.positionRad).toEqual(boundary.positionRad)
  expect(tailStart.velocityRadS).toEqual(boundary.velocityRadS)
  expect(tailStart.accelerationRadS2).toEqual(boundary.accelerationRadS2)
  expect(tailStart.appliedTorqueNm).toEqual(boundary.appliedTorqueNm)
  expect(tailStart.requestedTorqueNm).toEqual([0, 0, 0])
  const rows = [...run.gimbal.rows, ...run.gimbal.tail.slice(1)]
  const travel = [20, 45, 45].map(n => n * Math.PI / 180)
  for (const [index, row] of rows.entries()) {
    expect(row.positionRad.every((n, axis) => Math.abs(n) <= travel[axis]!)).toBe(true)
    expect(row.velocityRadS.every(n => Math.abs(n) <= 2 + 1e-9)).toBe(true)
    expect(row.accelerationRadS2.every(n => Math.abs(n) <= 4 + 1e-9)).toBe(true)
    expect(row.appliedTorqueNm.every(n => Math.abs(n) <= 0.02 + 1e-9)).toBe(true)
    if (index === 0) continue
    const old = rows[index - 1]!
    expect(row.atMs - old.atMs).toBe(4)
    expect(row.accelerationRadS2.every((n, axis) => Math.abs((n - old.accelerationRadS2[axis]!) / 0.004) <= 6 + 1e-9)).toBe(true)
    expect(row.appliedTorqueNm.every((n, axis) => Math.abs((n - old.appliedTorqueNm[axis]!) / 0.004) <= 0.02 + 1e-9)).toBe(true)
  }
  expect(run.reconciliation).toEqual({ invalidCaptureSequences: [], earliestInvalidAtMs: null })
  expect(run.evaluation.qualified).toBe(true)
  expect(JSON.stringify(simulateCinema())).toBe(JSON.stringify(run))
  expect(new TextEncoder().encode(JSON.stringify(run) + '\n').length).toBeLessThanOrEqual(20971520)
}, 70000)

// The public fault fixture deliberately withdraws its last packet across exposure1's ACK epoch.
test('target loss wins the first ACK tie and preserves the real exposed image as uncertain', () => {
  const run = simulateCinema({ scenario: 'target-loss' }), start = run.shot.startedAtMs!
  expect(start).not.toBeNull()
  expect(run.status).toBe('halted')
  expect(run.reason).toBe('target-stale')
  expect(run.shot.firstFault).toEqual({ atMs: start + 1020, code: 'target-stale' })
  expect(run.shot.retirement.atMs).toBe(start + 1020)
  expect(run.targetObservations.at(-1)!.capturedAtMs).toBe(start + 900)
  expect(run.captures.length).toBe(1)
  const capture = run.captures[0]!
  expect(capture.issuedAtMs).toBe(start + 1000)
  expect(capture.capturedAtMs).toBe(capture.issuedAtMs)
  expect(capture.image!.rgba.length).toBe(12288)
  expect(capture.actual).not.toBeNull()
  expectActualRaster(capture, [4, 0, -1.2])
  expect(capture.state).toBe('uncertain')
  expect(capture.reason).toBe('target-stale')
  expect(capture.ack).toBeNull()
  expect(capture.postStepAdmission).toBe('valid')
  expect(run.shot.counters.shutterAttempts).toBe(1)
  expect(run.shot.counters.ackReceipts).toBe(0)
  expect(run.shot.counters.confirmedCaptures).toBe(0)
  expect(run.shot.counters.uncertainCaptures).toBe(1)
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0)
  expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.gimbal.rows.at(-1)!.atMs).toBe(start + 1020)
  expect(run.encoderObservations.at(-1)!.receivedAtMs).toBe(start + 1020)
  const firstTail = run.gimbal.tail[0]!, boundary = run.gimbal.rows.at(-1)!
  expect(firstTail.positionRad).toEqual(boundary.positionRad)
  expect(firstTail.velocityRadS).toEqual(boundary.velocityRadS)
  expect(firstTail.appliedTorqueNm).toEqual(boundary.appliedTorqueNm)
  expect(firstTail.requestedTorqueNm).toEqual([0, 0, 0])
  expect(firstTail.appliedTorqueNm.some(n => n !== 0)).toBe(true)
  expect(run.gimbal.tail.at(-1)!.atMs).toBe(start + 3020)
  expect(run.mission.terminalState).toBe('aborted')
  expect(run.mission.boardNeutral).toBe(true)
  expect(replayMission(run.mission.trace).snapshot().state).toBe('aborted')
  expect(run.evaluation.qualified).toBe(false)
}, 70000)

test('body disturbance reaches real mission physics while the three intended frames remain qualified', () => {
  const nominal = simulateCinema(), run = simulateCinema({ scenario: 'body-disturbance' })
  expect(run.status).toBe('completed')
  expect(run.reason).toBe('qualified')
  expect(run.mission.terminalReason).toBe('landed')
  expect(run.mission.boardNeutral).toBe(true)
  expect(run.captures.length).toBe(3)
  expect(run.captures.every(c => c.state === 'confirmed' && c.postStepAdmission === 'valid' && c.quality.errorPx !== null && c.quality.errorPx <= 2)).toBe(true)
  expect(run.captures.map(c => c.actual!.bodyQuaternionWxyz)).not.toEqual(nominal.captures.map(c => c.actual!.bodyQuaternionWxyz))
  expect(run.encoderObservations.map(e => e.positionRad)).not.toEqual(nominal.encoderObservations.map(e => e.positionRad))
  const fractions = [379 / 2187, 1, 0]
  for (const [index, capture] of run.captures.entries()) {
    expect(capture.sequence as number).toBe(index + 1)
    expect(capture.shotOffsetMs as number).toBe([1000, 3000, 7000][index]!)
    expect(capture.issuedAtMs).toBe(run.shot.startedAtMs! + [1000, 3000, 7000][index]!)
    expect(capture.capturedAtMs).toBe(capture.issuedAtMs)
    expectActualRaster(capture, [4, 0, -1.2])
    expectActualRaster(nominal.captures[index]!, [4, 0, -1.2])
    const measured = independentMagenta(capture.image!.rgba)
    expect(measured.count).toBeGreaterThan(0)
    const expectedPixel: [number, number] = [32 - 40 * Math.tan(8 * Math.PI / 180 * fractions[index]!), 24]
    const errorPx = Math.hypot(measured.centroid![0] - expectedPixel[0], measured.centroid![1] - expectedPixel[1])
    expect(errorPx).toBeLessThanOrEqual(2)
    expect(capture.quality.expectedPixel).toEqual(expectedPixel)
    expect(capture.quality.observedPixel).toEqual(measured.centroid)
    expect(capture.quality.errorPx).toBe(errorPx)
    const physical = run.gimbal.rows.find(row => row.atMs === capture.issuedAtMs)!
    expect(capture.actual!.jointPositionRad).toEqual(physical.positionRad)
    expect(capture.actual!.appliedTorqueNm).toEqual(physical.appliedTorqueNm)
    const facts = { label: 'cinema-disturbed-capture-oracle', sequence: capture.sequence, issuedAtMs: capture.issuedAtMs, capturedAtMs: capture.capturedAtMs, actual: capture.actual, opticalRotation: oracleOpticalRotation(capture.actual!), continuousMarkerPixel: oracleCenterPixel(capture.actual!, [4, 0, -1.2]), imageSha256: createHash('sha256').update(Uint8Array.from(capture.image!.rgba)).digest('hex'), markerPixels: measured.count, observedPixel: measured.centroid, expectedPixel, errorPx }
    const line = JSON.stringify(facts)
    expect(new TextEncoder().encode(line + '\n').length).toBeLessThanOrEqual(2048)
    console.log(line)
  }
  const rows = [...run.gimbal.rows, ...run.gimbal.tail.slice(1)]
  let jerk = 0, slew = 0
  for (let index = 1; index < rows.length; index++) {
    const a = rows[index - 1]!, b = rows[index]!
    expect(b.atMs - a.atMs).toBe(4)
    jerk = Math.max(jerk, ...b.accelerationRadS2.map((n, axis) => Math.abs((n - a.accelerationRadS2[axis]!) / 0.004)))
    slew = Math.max(slew, ...b.appliedTorqueNm.map((n, axis) => Math.abs((n - a.appliedTorqueNm[axis]!) / 0.004)))
  }
  expect(jerk).toBeLessThanOrEqual(6 + 1e-9)
  expect(slew).toBeLessThanOrEqual(0.02 + 1e-9)
  expect(run.evaluation.motion.maxJerkRadS3).toBe(jerk)
  expect(run.evaluation.motion.maxTorqueSlewNmS).toBe(slew)
  expect(run.evaluation.qualified).toBe(true)
  expect(replayMission(run.mission.trace).snapshot().reason).toBe('landed')
}, 70000)

type OracleV3 = [number, number, number]
type OracleMatrix = [OracleV3, OracleV3, OracleV3]
type OracleActual = { bodyPositionM: OracleV3, bodyQuaternionWxyz: [number, number, number, number], jointPositionRad: OracleV3 }

// Independent test oracle: explicit active-vector matrices, no production pose/projector helpers.
function oracleProduct(a: OracleMatrix, b: OracleMatrix): OracleMatrix {
  return a.map(row => [
    row[0] * b[0][0] + row[1] * b[1][0] + row[2] * b[2][0],
    row[0] * b[0][1] + row[1] * b[1][1] + row[2] * b[2][1],
    row[0] * b[0][2] + row[1] * b[1][2] + row[2] * b[2][2],
  ]) as OracleMatrix
}
function oracleVector(matrix: OracleMatrix, vector: OracleV3): OracleV3 {
  return matrix.map(row => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]) as OracleV3
}
function oracleOpticalRotation(actual: OracleActual): OracleMatrix {
  const [w, x, y, z] = actual.bodyQuaternionWxyz
  const body: OracleMatrix = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  const [roll, pitch, yaw] = actual.jointPositionRad
  const cr = Math.cos(roll), sr = Math.sin(roll), cp = Math.cos(pitch), sp = Math.sin(pitch), cy = Math.cos(yaw), sy = Math.sin(yaw)
  const rx: OracleMatrix = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]]
  const ry: OracleMatrix = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]]
  const rz: OracleMatrix = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]]
  // Optical X/Y/Z columns map to body right/down/forward at neutral.
  const neutral: OracleMatrix = [[0, 0, 1], [1, 0, 0], [0, 1, 0]]
  return oracleProduct(oracleProduct(oracleProduct(oracleProduct(body, rz), ry), rx), neutral)
}
function oracleCenterPixel(actual: OracleActual, center: OracleV3): [number, number] {
  const rotation = oracleOpticalRotation(actual), d = center.map((v, i) => v - actual.bodyPositionM[i]!) as OracleV3
  const optical: OracleV3 = [0, 1, 2].map(column => rotation[0][column]! * d[0] + rotation[1][column]! * d[1] + rotation[2][column]! * d[2]) as OracleV3
  if (!(optical[2] > 0)) throw new Error('Independent marker center is behind the optical plane')
  return [32 + 40 * optical[0] / optical[2], 24 + 40 * optical[1] / optical[2]]
}
function oracleCinemaRaster(actual: OracleActual, center: OracleV3): number[] {
  const rotation = oracleOpticalRotation(actual), rgba: number[] = []
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const ray = oracleVector(rotation, [(x + 0.5 - 32) / 40, (y + 0.5 - 24) / 40, 1])
    let color = [16, 20, 24, 255]
    const opticalDepth = ray[0] > 1e-9 ? (center[0] - actual.bodyPositionM[0]) / ray[0] : -1
    if (opticalDepth >= 1 && opticalDepth <= 10) {
      const right = actual.bodyPositionM[1] + opticalDepth * ray[1] - center[1]
      const down = actual.bodyPositionM[2] + opticalDepth * ray[2] - center[2]
      if (right >= -0.4 && right < 0.4 && down >= -0.3 && down < 0.3) {
        color = [96, 104, 112, 255]
        if (right >= -0.12 && right < 0.12 && down >= -0.12 && down < 0.12) color = [240, 20, 180, 255]
        else if (right >= -0.32 && right < -0.20 && down >= -0.20 && down < -0.08) color = [230, 40, 30, 255]
        else if (right >= 0.18 && right < 0.30 && down >= 0.10 && down < 0.22) color = [20, 80, 230, 255]
      }
    }
    rgba.push(...color)
  }
  return rgba
}
function independentMagenta(rgba: number[]) {
  let sumX = 0, sumY = 0, count = 0
  for (let pixel = 0; pixel < 3072; pixel++) {
    const at = pixel * 4
    if (rgba[at] === 240 && rgba[at + 1] === 20 && rgba[at + 2] === 180) { sumX += pixel % 64 + 0.5; sumY += Math.floor(pixel / 64) + 0.5; count++ }
  }
  return { count, centroid: count ? [sumX / count, sumY / count] as [number, number] : null }
}
function expectActualRaster(capture: { actual: OracleActual | null, image: { rgba: number[] } | null }, center: OracleV3) {
  expect(capture.actual).not.toBeNull()
  expect(capture.image).not.toBeNull()
  const expected = oracleCinemaRaster(capture.actual!, center), observed = capture.image!.rgba
  expect(expected.length).toBe(12288)
  expect(observed.length).toBe(12288)
  expect(observed.every((v, i) => v === expected[i])).toBe(true)
}

// Existing pure renderer seam: distinguishable worked poses isolate actual orientation and color signs.
// This adds no injectable world/scenario, driver, new projector or production hook.
test('renderer distinguishes actual body and current joint poses with worked asymmetric marker pixels', () => {
  const fixed = cinemaModel(), center: OracleV3 = [4, 0, -1.2]
  const body: RigidBodyState = { positionM: [0, 0, -1.2], velocityMps: [0, 0, 0], angularRateRadS: [0, 0, 0], accelerationMps2: [0, 0, 0], quaternionWxyz: [1, 0, 0, 0], motorsN: [0, 0, 0, 0], groundContact: false }
  const render = createCinemaRenderer(fixed, center), zero: OracleV3 = [0, 0, 0]
  const neutral = render(body, zero), theta = 8 * Math.PI / 180
  const yawBody: RigidBodyState = { ...body, quaternionWxyz: [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)] }
  const yawed = render(yawBody, zero), jointYaw = render(body, [0, 0, theta])
  const compensated = render(yawBody, [0, 0, -theta])
  for (const [image, actual] of [
    [neutral, { bodyPositionM: body.positionM, bodyQuaternionWxyz: body.quaternionWxyz, jointPositionRad: zero }],
    [yawed, { bodyPositionM: yawBody.positionM, bodyQuaternionWxyz: yawBody.quaternionWxyz, jointPositionRad: zero }],
    [jointYaw, { bodyPositionM: body.positionM, bodyQuaternionWxyz: body.quaternionWxyz, jointPositionRad: [0, 0, theta] as OracleV3 }],
    [compensated, { bodyPositionM: yawBody.positionM, bodyQuaternionWxyz: yawBody.quaternionWxyz, jointPositionRad: [0, 0, -theta] as OracleV3 }],
  ] as const) expectActualRaster({ image, actual }, center)
  expect(yawed.rgba.some((v, i) => v !== neutral.rgba[i])).toBe(true)
  expect(jointYaw.rgba.every((v, i) => v === yawed.rgba[i])).toBe(true)
  expect(compensated.rgba.every((v, i) => v === neutral.rgba[i])).toBe(true)
  expect(independentMagenta(neutral.rgba).centroid).toEqual([32, 24])
  const yawCentroid = independentMagenta(yawed.rgba).centroid!
  // Independently worked centered-forward point under positive8degree down-yaw.
  expect(Math.hypot(yawCentroid[0] - 26.37836661190434, yawCentroid[1] - 24)).toBeLessThanOrEqual(2)
  const projectedYaw = oracleCenterPixel({ bodyPositionM: yawBody.positionM, bodyQuaternionWxyz: yawBody.quaternionWxyz, jointPositionRad: zero }, center)
  expect(Math.abs(projectedYaw[0] - 26.37836661190434)).toBeLessThanOrEqual(1e-12)
  expect(Math.abs(projectedYaw[1] - 24)).toBeLessThanOrEqual(1e-12)
  const offCenter: OracleV3 = [4, 0.4, -1], offImage = createCinemaRenderer(fixed, offCenter)(body, zero)
  expectActualRaster({ image: offImage, actual: { bodyPositionM: body.positionM, bodyQuaternionWxyz: body.quaternionWxyz, jointPositionRad: zero } }, offCenter)
  // Camera-relative[4,.4,.2] has optical[.4,.2,4], so its center is[36,26].
  expect(independentMagenta(offImage.rgba).centroid).toEqual([36, 26])
  const pixel = (x: number, y: number) => offImage.rgba.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)
  expect(pixel(35, 25)).toEqual([240, 20, 180, 255])
  expect(pixel(33, 24)).toEqual([230, 40, 30, 255])
  expect(pixel(38, 27)).toEqual([20, 80, 230, 255])
  expect(pixel(32, 24)).toEqual([96, 104, 112, 255])
  expect(pixel(0, 0)).toEqual([16, 20, 24, 255])
})

test('camera loss retains one real exposure as uncertain at the inclusive ACK deadline without retry', () => {
  const run = simulateCinema({ scenario: 'camera-loss' }), start = run.shot.startedAtMs!, capture = run.captures[0]!
  expect(run.status).toBe('halted')
  expect(run.reason).toBe('ack-deadline')
  expect(run.shot.firstFault).toEqual({ atMs: start + 1080, code: 'ack-deadline' })
  expect(run.captures.length).toBe(1)
  expect(capture.issuedAtMs).toBe(start + 1000)
  expect(capture.deadlineMs).toBe(capture.issuedAtMs + 80)
  expect(capture.capturedAtMs).toBe(capture.issuedAtMs)
  expect(capture.state).toBe('uncertain')
  expect(capture.reason).toBe('ack-deadline')
  expect(capture.ack).toBeNull()
  expectActualRaster(capture, [4, 0, -1.2])
  expect(run.shot.counters.shutterAttempts).toBe(1)
  expect(run.shot.counters.ackReceipts).toBe(0)
  expect(run.shot.counters.confirmedCaptures).toBe(0)
  expect(run.shot.counters.uncertainCaptures).toBe(1)
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0)
  expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.mission.terminalState).toBe('aborted')
  expect(run.mission.boardNeutral).toBe(true)
  expect(replayMission(run.mission.trace).snapshot().state).toBe('aborted')
  expect(run.evaluation.qualified).toBe(false)
}, 70000)

test('wrong ACK scope preserves received metadata and image but never confirms or retries', () => {
  const run = simulateCinema({ scenario: 'wrong-ack' }), start = run.shot.startedAtMs!, capture = run.captures[0]!
  expect(run.status).toBe('halted')
  expect(run.reason).toBe('ack-scope')
  expect(run.shot.firstFault).toEqual({ atMs: start + 1020, code: 'ack-scope' })
  expect(run.captures.length).toBe(1)
  expect(capture.state).toBe('uncertain')
  expect(capture.reason).toBe('ack-scope')
  expect(capture.reference).toBe('55:0,0,0,0,0')
  expect(capture.ack!.reference).toBe('wrong-reference')
  expect(capture.ack!.receivedAtMs).toBe(start + 1020)
  expect(capture.ack!.capturedAtMs).toBe(capture.issuedAtMs)
  expect(capture.pose.capturedAtMs).toBe(capture.issuedAtMs)
  expectActualRaster(capture, [4, 0, -1.2])
  expect(run.shot.counters.shutterAttempts).toBe(1)
  expect(run.shot.counters.ackReceipts).toBe(1)
  expect(run.shot.counters.confirmedCaptures).toBe(0)
  expect(run.shot.counters.uncertainCaptures).toBe(1)
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0)
  expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.mission.terminalState).toBe('aborted')
  expect(run.mission.boardNeutral).toBe(true)
  expect(run.evaluation.qualified).toBe(false)
}, 70000)

test('mechanical limit refuses the unreachable selected prop before any shutter', () => {
  const run = simulateCinema({ scenario: 'mechanical-limit' })
  expect(run.status).toBe('halted')
  expect(run.reason).toBe('joint-goal-limit')
  expect(run.selection.id).toBe('selected-prop')
  expect(run.selection.positionM).toEqual([0.1, 4, -1.2])
  expect(run.shot.startedAtMs).toBeNull()
  expect(run.shot.firstFault!.code).toBe('joint-goal-limit')
  expect(run.captures).toEqual([])
  expect(run.shot.counters.shutterAttempts).toBe(0)
  expect(run.shot.counters.trackingCommands).toBe(0)
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0)
  expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.evaluation.motion.withinMechanicalBounds).toBe(true)
  expect(run.mission.terminalState).toBe('aborted')
  expect(run.mission.boardNeutral).toBe(true)
  expect(run.evaluation.qualified).toBe(false)
}, 70000)

test('RC override keeps native blocked authority and retires cinema without a fabricated capture', () => {
  const run = simulateCinema({ scenario: 'rc-override' })
  expect(run.status).toBe('halted')
  expect(run.reason).toBe('authority-lost')
  expect(run.shot.firstFault).toEqual({ atMs: 5000, code: 'authority-lost' })
  expect(run.shot.retirement.atMs).toBe(5000)
  expect(run.captures).toEqual([])
  expect(run.shot.counters.shutterAttempts).toBe(0)
  expect(run.shot.counters.trackingCommandsAfterRetirement).toBe(0)
  expect(run.shot.counters.shutterAttemptsAfterRetirement).toBe(0)
  expect(run.mission.terminalState).toBe('blocked')
  expect(run.mission.terminalReason).toBe('authority-revoked')
  expect(run.mission.boardNeutral).toBe(true)
  expect(replayMission(run.mission.trace).snapshot().state).toBe('blocked')
  expect(run.evaluation.qualified).toBe(false)
}, 70000)

test('cinema input rejects nonplain own-data violations before invoking getters or proxy traps', () => {
  let getterCalls = 0, proxyTraps = 0
  const getter = Object.defineProperty({}, 'scenario', { enumerable: true, get() { getterCalls++; return 'nominal' } })
  const hidden = Object.defineProperty({}, 'scenario', { value: 'nominal', enumerable: false })
  const proxy = new Proxy({}, { getPrototypeOf() { proxyTraps++; throw new Error('private-proxy') }, ownKeys() { proxyTraps++; throw new Error('private-proxy') }, getOwnPropertyDescriptor() { proxyTraps++; throw new Error('private-proxy') } })
  const invalid: unknown[] = [null, false, 2, 'nominal', [], new Date(0), Object.create(null), Object.create({ scenario: 'nominal' }), { scenario: undefined }, { scenario: ['nominal'] }, { scenario: new String('nominal') }, { scenario: 'private-unknown' }, { seconds: 45 }, { [Symbol('private-key')]: true }, getter, hidden, proxy]
  for (const input of invalid) {
    let error: unknown
    try { simulateCinema(input) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(TypeError)
    expect((error as Error).message).toBe('cinema-input')
  }
  expect(getterCalls).toBe(0)
  expect(proxyTraps).toBe(0)
})

test('cinema result owns detached dense JSON evidence within all frozen component and total bounds', () => {
  const a = simulateCinema(), b = simulateCinema()
  const encoded = JSON.stringify(a), bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
  expect(Object.keys(a)).toEqual(['version', 'evidence', 'profile', 'scenario', 'status', 'reason', 'physicalFlightEnabled', 'physicalGimbalActuationEnabled', 'identityAuthenticated', 'selection', 'model', 'mission', 'shot', 'gimbal', 'targetObservations', 'encoderObservations', 'captures', 'reconciliation', 'evaluation'])
  expect(JSON.stringify(JSON.parse(encoded))).toBe(encoded)
  function domain(value: unknown): void {
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'number') { expect(Number.isFinite(value)).toBe(true); return }
    if (typeof value === 'string') return
    expect(typeof value).toBe('object')
    if (Array.isArray(value)) { expect(Reflect.ownKeys(value).length).toBe(value.length + 1); for (const item of value) domain(item); return }
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) { expect(descriptor.enumerable).toBe(true); expect(Object.hasOwn(descriptor, 'value')).toBe(true); domain(descriptor.value) }
  }
  domain(a)
  const liveMax = Math.max(...a.gimbal.rows.map(bytes)), tailMax = Math.max(...a.gimbal.tail.map(bytes)), encoderMax = Math.max(...a.encoderObservations.map(bytes)), targetMax = Math.max(...a.targetObservations.map(bytes)), captureMax = Math.max(...a.captures.map(bytes))
  expect(a.gimbal.rows.length).toBeLessThanOrEqual(11251)
  expect(a.gimbal.tail.length).toBe(501)
  expect(a.encoderObservations.length).toBeLessThanOrEqual(2251)
  expect(a.targetObservations.length).toBeLessThanOrEqual(2251)
  expect(a.captures.length).toBe(3)
  expect(liveMax).toBeLessThanOrEqual(768)
  expect(tailMax).toBeLessThanOrEqual(768)
  expect(encoderMax).toBeLessThanOrEqual(512)
  expect(targetMax).toBeLessThanOrEqual(640)
  expect(captureMax).toBeLessThanOrEqual(65536)
  expect(a.captures.every(c => bytes(c.image!.rgba) <= 49154)).toBe(true)
  expect(bytes(a.model)).toBeLessThanOrEqual(16384)
  expect(bytes(a.mission.trace) + 1).toBeLessThanOrEqual(8388608)
  const { mission, ...cinema } = a
  expect(bytes({ ...cinema, mission: { ...mission, trace: null } }) + 1).toBeLessThanOrEqual(12582912)
  expect(new TextEncoder().encode(encoded + '\n').length).toBeLessThanOrEqual(20971520)
  const expectedB = JSON.stringify(b)
  a.captures[0]!.image!.rgba[0] = 1
  a.captures[0]!.actual!.jointPositionRad[0] = 1
  a.gimbal.rows[0]!.positionRad[0] = 1
  a.selection.positionM[0] = 1
  a.model.calibration.intrinsics.fx = 1
  expect(JSON.stringify(b)).toBe(expectedB)
  expect(JSON.stringify(simulateCinema())).toBe(expectedB)
  console.log(JSON.stringify({ label: 'cinema-json-bounds', liveMax, tailMax, encoderMax, targetMax, captureMax, traceBytesWithLF: bytes(b.mission.trace) + 1, fullBytesWithLF: new TextEncoder().encode(expectedB + '\n').length }))
}, 70000)
