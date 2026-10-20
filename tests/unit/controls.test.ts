import { expect, test } from 'bun:test'
import { allocateQuadX, quadXWrench } from '../../resources/functions/drone/controls/allocation'

test('independent quad-X force and moment cases use FRD signs and SI units', () => {
  expect(quadXWrench([5, 5, 5, 5])).toEqual({ thrustN: 20, torqueNm: [0, 0, 0] })
  expect(quadXWrench([4, 4, 6, 6]).torqueNm[0]).toBeCloseTo(0.64, 12)
  expect(quadXWrench([6, 4, 4, 6]).torqueNm[1]).toBeCloseTo(0.64, 12)
  expect(quadXWrench([6, 4, 6, 4]).torqueNm[2]).toBeCloseTo(0.08, 12)
  const mixed = allocateQuadX({ thrustN: 20, torqueNm: [0.64, 0, 0] }, [5, 5, 5, 5], 0.1)
  expect(mixed.motorsN).toEqual([4, 4, 6, 6])
})

import { createBoundedPid } from '../../resources/functions/drone/controls/pid'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'
test('PID derivative follows measurement and saturated error cannot wind up the integral', () => {
  const pid = createBoundedPid({ kp: 2, ki: 1, kd: 0, integralLimit: 0.5, outputLimit: 1, derivativeTauS: 0.03, trackingGain: 2 })
  for (let i = 0; i < 500; i++) expect(pid.step(10, 0, 0.02)).toBe(1)
  expect(pid.state().integral).toBe(0)
  expect(pid.step(0, 0, 0.02)).toBe(0)
  pid.track(-10, 0.02)
  expect(pid.state().integral).toBeCloseTo(-0.4, 12)
  pid.reset(); expect(pid.state()).toEqual({ integral: 0, derivative: 0 })
  expect(() => pid.step(1, 0, NaN)).toThrow()
})
test('rigid-body free fall and roll moment follow independent Newton/Euler cases', () => {
  const falling = createRigidBody({ positionM: [0, 0, -10] })
  const a = falling.step([0, 0, 0, 0], 0.004)
  expect(a.accelerationMps2[2]).toBeCloseTo(9.80665, 12)
  expect(a.velocityMps[2]).toBeCloseTo(0.0392266, 12)
  const rolling = createRigidBody({ positionM: [0, 0, -10], motorsN: [4, 4, 6, 6] })
  expect(rolling.step([4, 4, 6, 6], 0.004).angularRateRadS[0]).toBeCloseTo(0.08533333333333333, 12)
})

import { createSimulatedMultirotorController } from '../../resources/functions/drone/controls/controller'
import type { SimulatedControlInput } from '../../resources/functions/drone/controls/controller'
import { createEstimatorReplay } from '../../resources/functions/drone/estimation/replay'
import { createEstimator } from '../../resources/functions/drone/estimation/estimator'
import { createSensorReplay } from '../../resources/functions/drone/sensors/replay'
import motion from '../fixtures/estimation/motion-v1.json'
import { simulateMultirotor } from '../../resources/functions/drone/controls/simulation'
const prototypeEstimate = createEstimatorReplay(motion).advanceTo(1040).estimate
function controlInput(nowMs = 1000): SimulatedControlInput {
  const estimate = structuredClone(prototypeEstimate)
  estimate.nowMs = nowMs
  estimate.attitude!.quaternionWxyz = [1, 0, 0, 0]; estimate.attitude!.capturedAtMs = nowMs
  estimate.localPosition!.positionM = [0, 0, -1]; estimate.localPosition!.velocityMps = [0, 0, 0]
  estimate.localPosition!.capturedAtMs = nowMs; estimate.localPosition!.predictedToMs = nowMs
  return { kind: 'simulation', enabled: true, nowMs, estimate, angularRateRadS: [0, 0, 0], rateCapturedAtMs: nowMs, target: { positionM: [0, 0, -1], yawRad: 0, issuedAtMs: nowMs } }
}
const controller = () => createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
test('hover control requests mg newtons and zero torque from an owned estimator input', () => {
  const result = controller().step(controlInput())
  expect(result.inhibited).toBe(false)
  expect(result.desiredWrench!.thrustN).toBeCloseTo(14.709975, 10)
  expect(result.desiredWrench!.torqueNm).toEqual([0, 0, 0])
  expect(result.motorsN).toEqual([0.8, 0.8, 0.8, 0.8])
  expect(result.boardOutputsInhibited).toBe(true)
  expect(result.physicalFlightEnabled).toBe(false)
})
test('motor clipping, slew and inhibition keep actual achieved moments visible', () => {
  const result = allocateQuadX({ thrustN: 1000, torqueNm: [100, 100, 100] }, [0, 0, 0, 0], 0.02)
  expect(result.motorsN.every(n => n >= 0 && n <= 0.8)).toBe(true)
  expect(result.achieved.thrustN).toBeLessThan(4)
  expect(result.limited).toBe(true)
  expect(allocateQuadX({ thrustN: 0, torqueNm: [0, 0, 0] }, [10, 10, 10, 10], 0.02, false).motorsN).toEqual([0, 0, 0, 0])
  expect(() => allocateQuadX({ thrustN: NaN, torqueNm: [0, 0, 0] }, [0, 0, 0, 0], 0.02)).toThrow()
})
test('controller health, frame, freshness and reset faults latch zero commands', () => {
  const faults: ((input: SimulatedControlInput) => void)[] = [
    input => { input.estimate.health.tilt = false },
    input => { input.estimate.health.localPosition = false },
    input => { input.estimate.evidence = 'handshake' },
    input => { input.estimate.bootId = 90n },
    input => { input.estimate.resets.attitude++ },
    input => { input.estimate.localPosition!.origin!.ellipsoidHeightM++ },
    input => { input.estimate.localPosition!.capturedAtMs = NaN },
    input => { input.estimate.attitude!.capturedAtMs = input.nowMs - 61 },
    input => { input.estimate.attitude!.quaternionWxyz[0] = 2 },
    input => { input.angularRateRadS[1] = Infinity },
    input => { input.rateCapturedAtMs-- },
    input => { input.target.issuedAtMs = input.nowMs - 201 },
    input => { input.target.issuedAtMs++ },
  ]
  for (const change of faults) {
    const c = controller(); c.step(controlInput())
    const bad = controlInput(1020); change(bad)
    expect(c.step(bad).motorsN).toEqual([0, 0, 0, 0])
    expect(c.step(controlInput(1040)).inhibited).toBe(true)
    c.reset(); expect(c.step(controlInput(1060)).inhibited).toBe(false)
  }
})
test('disabled control clears integrators, while reversed or missed schedules latch inhibition', () => {
  const c = controller(); c.step(controlInput())
  expect(c.step(controlInput(1000)).reason).toBe('control-clock-discontinuity')
  expect(c.step(controlInput(1020)).inhibited).toBe(true)
  c.reset(); c.step(controlInput())
  expect(c.step(controlInput(1100)).reason).toBe('control-schedule-gap')
  const disabled = controlInput(1120); disabled.enabled = false
  expect(c.step(disabled).motorsN).toEqual([0, 0, 0, 0])
  expect(c.step(controlInput(1140)).inhibited).toBe(false)
})
test('persistent simulated saturation keeps every integral and motor command bounded', () => {
  const c = controller(); let motors = [0, 0, 0, 0]
  for (let i = 0; i < 200; i++) {
    const input = controlInput(1000 + i * 20); input.target.positionM = [50, 50, -50]
    const result = c.step(input)
    expect(result.inhibited).toBe(false)
    expect(result.integrals.velocity.every(n => Math.abs(n) <= 1.5)).toBe(true)
    expect(result.integrals.rate.every(n => Math.abs(n) <= 0.12)).toBe(true)
    expect(result.motorsN.every((n, j) => n >= 0 && n <= 10 && Math.abs(n - motors[j]!) <= 0.800001)).toBe(true)
    motors = result.motorsN
  }
})
test('owned estimator feedback stabilizes hover, steps, modeled wind and additional sensor delay', () => {
  for (const scenario of ['hover', 'step', 'wind', 'delay'] as const) {
    const result = simulateMultirotor({ scenario, seconds: 20 })
    expect(result.metrics.active).toBe(true)
    expect(result.metrics.firstInhibitMs).toBeNull()
    expect(result.metrics.finalPositionErrorM).toBeLessThan(scenario === 'wind' ? 0.2 : 0.05)
    expect(result.metrics.tailPositionRmsM).toBeLessThan(scenario === 'wind' ? 0.2 : 0.05)
    expect(result.metrics.maxTiltRad).toBeLessThan(0.44)
    expect(result.metrics.groundContacts).toBe(0)
    expect(result.metrics.maxCommandSlewNPerS).toBeLessThan(40.000001)
    expect(result.estimate.health.absoluteHeading).toBe(false)
    expect(result.boardOutputsInhibited).toBe(true)
    expect(result.trace.every(row => row.motorsN.every(n => Number.isFinite(n) && n >= 0 && n <= 10))).toBe(true)
  }
}, 60000)
test('IMU loss inhibits simulated commands and does not silently resume when packets return', () => {
  const result = simulateMultirotor({ scenario: 'imu-loss', seconds: 8 })
  expect(result.metrics.firstInhibitMs).toBeGreaterThanOrEqual(3000)
  expect(result.metrics.firstInhibitMs!).toBeLessThanOrEqual(3080)
  expect(result.control!.motorsN).toEqual([0, 0, 0, 0])
  expect(result.trace.filter(row => row.atMs >= 3200).every(row => row.inhibited)).toBe(true)
  expect(result.metrics.groundContacts).toBeGreaterThan(0) // Inhibition is not a landing controller.
}, 30000)
test('nominal integration converges across physics steps and excessive latency cannot start control', () => {
  const first = simulateMultirotor({ scenario: 'step', seconds: 20, physicsStepMs: 4 })
  const fine = simulateMultirotor({ scenario: 'step', seconds: 20, physicsStepMs: 2 })
  expect(Math.hypot(...first.state.positionM.map((n, i) => n - fine.state.positionM[i]!))).toBeLessThan(0.03)
  const stale = simulateMultirotor({ seconds: 3, sensorDelayMs: 100 })
  expect(stale.metrics.active).toBe(false)
  expect(stale.control!.motorsN).toEqual([0, 0, 0, 0])
  expect(() => simulateMultirotor({ seconds: 61 })).toThrow()
  expect(() => simulateMultirotor({ sensorDelayMs: -1 })).toThrow()
}, 60000)

test('NED position and yaw demands produce independent expected attitude/torque signs', () => {
  for (const [target, axis, sign] of [ [[1, 0, -1], 1, -1], [[0, 1, -1], 0, 1] ] as const) {
    const input = controlInput(); input.target.positionM = [...target]
    const output = controller().step(input)
    expect(Math.sign(output.desiredRatesRadS![axis])).toBe(sign)
    expect(Math.sign(output.desiredWrench!.torqueNm[axis])).toBe(sign)
  }
  const climb = controlInput(); climb.target.positionM[2] = -2
  expect(controller().step(climb).desiredWrench!.thrustN).toBeGreaterThan(14.709975)
  const yaw = controlInput(); yaw.target.yawRad = Math.PI / 2
  expect(controller().step(yaw).desiredWrench!.torqueNm[2]).toBeGreaterThan(0)
})
test('measurement derivative avoids a setpoint kick and motor lag follows its known time constant', () => {
  const pid = createBoundedPid({ kp: 0, ki: 0, kd: 1, integralLimit: 0, outputLimit: 100, derivativeTauS: 0.02, trackingGain: 0 })
  pid.step(0, 0, 0.02)
  expect(pid.step(10, 0, 0.02)).toBe(0)
  expect(pid.step(0, 1, 0.02)).toBe(-25)
  const body = createRigidBody({ positionM: [0, 0, -10] })
  for (let i = 0; i < 10; i++) body.step([5, 5, 5, 5], 0.004)
  expect(body.snapshot().motorsN[0]).toBeCloseTo(5 * (1 - Math.exp(-1)), 12)
})
import { command } from '@stacksjs/testing'
test('native Stacks controls CLI executes physics and rejects unknown scenarios and invalid latency', async () => {
  const result = await command(['controls:simulate', '--scenario', 'hover', '--seconds', '3']).withTimeout(30000)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout).metrics.active).toBe(true)
  const invalid = await command(['controls:simulate', '--scenario', 'aircraft']).withTimeout(30000)
  expect(invalid.exitCode).toBe(1)
  const delay = await command(['controls:simulate', '--sensor-delay-ms', 'nan']).withTimeout(30000)
  expect(delay.exitCode).toBe(1)
}, 60000)

test('an uncertain estimator snapshot must be re-evaluated at the control tick', () => {
  const uncertain = structuredClone(motion)
  for (const row of uncertain.records) {
    const bytes = Uint8Array.fromHex(row.hex)
    if (bytes[3] !== 1) continue
    const v = new DataView(bytes.buffer); v.setUint32(40, 40000, true)
    v.setUint32(124, Bun.hash.crc32(bytes.subarray(0, 124)), true); row.hex = bytes.toHex()
  }
  const estimator = createEstimator()
  const replay = createSensorReplay(uncertain, { onUpdate: frame => { estimator.update(frame) } })
  replay.advanceTo(1032)
  const estimate = estimator.snapshot(1032)
  expect(estimate.health.tilt).toBe(true)
  const input = controlInput(1060); input.estimate = estimate; input.rateCapturedAtMs = estimate.attitude!.capturedAtMs!
  expect(controller().step(input).inhibited).toBe(true)
  expect(estimator.snapshot(1060).health.tilt).toBe(false)
})

// Cargo public body seam: verifies actual Newton/Euler behavior and structural datum, not delivery or release hardware.
test('carried point mass changes actual acceleration while legacy bodies retain their exact public shape', () => {
  const legacy = createRigidBody()
  expect(Object.keys(legacy)).toEqual(['snapshot', 'step'])
  expect(Object.keys(legacy.snapshot())).toEqual(['positionM', 'velocityMps', 'angularRateRadS', 'accelerationMps2', 'quaternionWxyz', 'motorsN', 'groundContact'])
  const initial = { positionM: [0, 0, -10] as [number, number, number], motorsN: [3.67749375, 3.67749375, 3.67749375, 3.67749375] as [number, number, number, number], carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0 } }
  const loaded = createRigidBody(initial)
  expect(Object.keys(loaded)).toEqual(['snapshot', 'step', 'loadSnapshot', 'separateCarriedLoad'])
  expect(loaded.loadSnapshot()).toEqual({ properties: { id: 'cargo-point-100g', phase: 'attached', pointMassKg: 0.1, forwardM: 0, totalMassKg: 1.6, cgBodyM: [0, 0, 0], inertiaDiagonalKgM2: [0.03, 0.03, 0.05] }, centerPositionM: [0, 0, -10], centerVelocityMps: [0, 0, 0] })
  const state = loaded.step(initial.motorsN, 0.004)
  expect(state.accelerationMps2[0]).toBe(0)
  expect(state.accelerationMps2[1]).toBe(0)
  expect(state.accelerationMps2[2]).toBeCloseTo(0.612915625, 12)
  expect(state.velocityMps[2]).toBeCloseTo(0.0024516625, 12)
  const freefall = createRigidBody({ positionM: [0, 0, -10], carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0 } })
  expect(freefall.step([0, 0, 0, 0], 0.004).accelerationMps2[2]).toBe(9.80665)
})

type CargoVector = [number, number, number]
type CargoQuaternion = [number, number, number, number]
const cargoVectorAdd = (a: CargoVector, b: CargoVector): CargoVector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const cargoVectorSubtract = (a: CargoVector, b: CargoVector): CargoVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cargoVectorScale = (a: CargoVector, n: number): CargoVector => [a[0] * n, a[1] * n, a[2] * n]
const cargoDot = (a: CargoVector, b: CargoVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cargoOrbitalCross = (a: CargoVector, b: CargoVector): CargoVector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
// Independent direction-cosine matrix, rather than the plant's cross-product rotation helper.
function cargoRotation(q: CargoQuaternion): CargoVector[] {
  const [w, x, y, z] = q
  return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]]
}
function cargoMatrixVector(matrix: CargoVector[], v: CargoVector): CargoVector {
  return matrix.map(row => cargoDot(row, v)) as CargoVector
}
function cargoNextQuaternion(q: CargoQuaternion, rate: CargoVector, dt: number): CargoQuaternion {
  const norm = Math.hypot(...rate), half = norm * dt / 2, scalar = Math.cos(half), factor = norm < 1e-12 ? dt / 2 : Math.sin(half) / norm
  const [a, b, c] = rate.map(n => n * factor), [w, x, y, z] = q
  const next = [w * scalar - x * a! - y * b! - z * c!, w * a! + x * scalar + y * c! - z * b!, w * b! - x * c! + y * scalar + z * a!, w * c! + x * b! - y * a! + z * scalar]
  return next.map(n => n / Math.hypot(...next)) as CargoQuaternion
}
function cargoExpectVector(actual: number[], expected: number[], absoluteTolerance = 1e-12) {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) expect(Math.abs(actual[i]! - expected[i]!)).toBeLessThanOrEqual(absoluteTolerance)
}
function cargoRotatingBody() {
  const body = createRigidBody({ positionM: [1, -2, -20], motorsN: [3.67749375, 3.67749375, 3.67749375, 3.67749375], carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0.08 } })
  for (let i = 0; i < 100; i++) body.step([3.67749375, 3.67749375, 3.67749375, 3.67749375], 0.004, { forceN: [0.4, -0.3, 0.2], torqueNm: [0.12, 0.17, 0.14] })
  return body
}
function cargoExpectedStep(before: ReturnType<ReturnType<typeof createRigidBody>['snapshot']>, command: [number, number, number, number], dt: number, force: CargoVector, torque: CargoVector, wind: CargoVector) {
  const [wx, wy, wz] = before.angularRateRadS
  const motors = before.motorsN.map((n, i) => n + (command[i]! - n) * (1 - Math.exp(-dt / 0.04))) as [number, number, number, number]
  const [a, b, c, d] = motors, thrust = a + b + c + d
  // Component Euler equations use the literal combined inertia in BOTH gyroscopic coupling and inverse inertia.
  const alpha: CargoVector = [(0.16 * (-a - b + c + d) + torque[0] - (0.0506 - 0.0306) * wy * wz - 0.01 * wx) / 0.03, (0.16 * (a - b - c + d) - 0.005 * thrust + torque[1] - (0.03 - 0.0506) * wz * wx - 0.01 * wy) / 0.0306, (0.02 * (a - b + c - d) + torque[2] - (0.0306 - 0.03) * wx * wy - 0.01 * wz) / 0.0506]
  const rate = cargoVectorAdd(before.angularRateRadS, cargoVectorScale(alpha, dt)), q = cargoNextQuaternion(before.quaternionWxyz, rate, dt), rotation = cargoRotation(q)
  const center0 = cargoVectorAdd(before.positionM, cargoMatrixVector(cargoRotation(before.quaternionWxyz), [0.005, 0, 0]))
  const centerVelocity0 = cargoVectorAdd(before.velocityMps, cargoMatrixVector(cargoRotation(before.quaternionWxyz), [0, 0.005 * wz, -0.005 * wy]))
  const thrustNed = cargoMatrixVector(rotation, [0, 0, -thrust])
  const centerAcceleration = thrustNed.map((n, i) => (n + force[i]! - 0.4 * (centerVelocity0[i]! - wind[i]!)) / 1.6 + (i === 2 ? 9.80665 : 0)) as CargoVector
  const centerVelocity = cargoVectorAdd(centerVelocity0, cargoVectorScale(centerAcceleration, dt)), center = cargoVectorAdd(center0, cargoVectorScale(centerVelocity, dt))
  const [p, qRate, r] = rate
  const accelerationLever: CargoVector = [-0.005 * (qRate * qRate + r * r), 0.005 * (alpha[2] + p * qRate), 0.005 * (-alpha[1] + p * r)]
  return { alpha, rate, q, motors, center, centerVelocity, centerAcceleration, position: cargoVectorSubtract(center, cargoMatrixVector(rotation, [0.005, 0, 0])), velocity: cargoVectorSubtract(centerVelocity, cargoMatrixVector(rotation, [0, 0.005 * r, -0.005 * qRate])), acceleration: cargoVectorSubtract(centerAcceleration, cargoMatrixVector(rotation, accelerationLever)), tangentialOnlyAcceleration: cargoVectorSubtract(centerAcceleration, cargoMatrixVector(rotation, [0, 0.005 * alpha[2], -0.005 * alpha[1]])) }
}

test('forward cargo mass shifts pitch torque and its structural datum follows independent multi-axis Euler and CG equations', () => {
  const first = createRigidBody({ positionM: [0, 0, -10], motorsN: [3.67749375, 3.67749375, 3.67749375, 3.67749375], carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0.08 } })
  const properties = first.loadSnapshot().properties
  expect(properties.totalMassKg).toBe(1.6)
  cargoExpectVector(properties.cgBodyM, [0.005, 0, 0])
  cargoExpectVector(properties.inertiaDiagonalKgM2, [0.03, 0.0306, 0.0506])
  expect(first.step([3.67749375, 3.67749375, 3.67749375, 3.67749375], 0.004).angularRateRadS[1]).toBeCloseTo(-0.00961436274509804, 12)
  const body = cargoRotatingBody(), before = body.snapshot()
  expect(before.angularRateRadS.every(n => Math.abs(n) > 0.1)).toBe(true)
  expect(Math.abs(before.quaternionWxyz[0])).toBeLessThan(0.999)
  expect(Math.hypot(...before.velocityMps)).toBeGreaterThan(0.01)
  const expected = cargoExpectedStep(before, [4, 3, 2, 5], 0.004, [0.8, -0.4, 0.1], [0.07, -0.02, 0.03], [0.5, -0.2, 0.1])
  const actual = body.step([4, 3, 2, 5], 0.004, { forceN: [0.8, -0.4, 0.1], torqueNm: [0.07, -0.02, 0.03], windMps: [0.5, -0.2, 0.1] })
  cargoExpectVector(actual.angularRateRadS, expected.rate)
  cargoExpectVector(actual.quaternionWxyz, expected.q)
  cargoExpectVector(actual.motorsN, expected.motors)
  cargoExpectVector(actual.positionM, expected.position)
  cargoExpectVector(actual.velocityMps, expected.velocity)
  cargoExpectVector(actual.accelerationMps2, expected.acceleration)
  cargoExpectVector(body.loadSnapshot().centerPositionM, expected.center)
  cargoExpectVector(body.loadSnapshot().centerVelocityMps, expected.centerVelocity)
  expect(actual.groundContact).toBe(false)
})

test('zero-ejection cargo separation conserves independent airborne P H K U at a nonidentity moving pose', () => {
  const body = cargoRotatingBody(), before = body.snapshot(), centerBefore = body.loadSnapshot()
  const rotation = cargoRotation(before.quaternionWxyz), [wx, wy, wz] = before.angularRateRadS
  const pC = cargoVectorAdd(before.positionM, cargoMatrixVector(rotation, [0.005, 0, 0]))
  const vC = cargoVectorAdd(before.velocityMps, cargoMatrixVector(rotation, [0, 0.005 * wz, -0.005 * wy]))
  const pP = cargoVectorAdd(before.positionM, cargoMatrixVector(rotation, [0.08, 0, 0]))
  const vP = cargoVectorAdd(before.velocityMps, cargoMatrixVector(rotation, [0, 0.08 * wz, -0.08 * wy]))
  cargoExpectVector(centerBefore.centerPositionM, pC)
  cargoExpectVector(centerBefore.centerVelocityMps, vC)
  expect(before.angularRateRadS.every(n => Math.abs(n) > 0.1)).toBe(true)
  expect(Math.hypot(...before.velocityMps)).toBeGreaterThan(0.01)
  expect(Math.abs(before.quaternionWxyz[0])).toBeLessThan(0.999)
  expect(before.groundContact).toBe(false)
  const event = body.separateCarriedLoad()
  expect(event.outcome).toBe('separated')
  if (event.outcome !== 'separated') throw new Error('Expected a prescribed separation')
  expect(Object.keys(event)).toEqual(['outcome', 'reason', 'before', 'after', 'parcel'])
  expect(Object.keys(event.before)).toEqual(['properties', 'bodyPositionM', 'bodyVelocityMps', 'quaternionWxyz', 'angularRateRadS', 'actualMotorsN', 'centerPositionM', 'centerVelocityMps'])
  expect(event.reason).toBe('prescribed-zero-ejection')
  const after = body.snapshot()
  for (const key of ['positionM', 'velocityMps', 'quaternionWxyz', 'angularRateRadS', 'motorsN', 'accelerationMps2'] as const) cargoExpectVector(after[key], before[key])
  cargoExpectVector(event.before.centerPositionM, pC)
  cargoExpectVector(event.before.centerVelocityMps, vC)
  cargoExpectVector(event.after.bodyPositionM, before.positionM)
  cargoExpectVector(event.after.bodyVelocityMps, before.velocityMps)
  cargoExpectVector(event.after.centerPositionM, before.positionM)
  cargoExpectVector(event.after.centerVelocityMps, before.velocityMps)
  cargoExpectVector(event.parcel.positionM, pP)
  cargoExpectVector(event.parcel.velocityMps, vP)
  expect(Math.hypot(...cargoVectorSubtract(vP, before.velocityMps))).toBeGreaterThan(0.01)
  expect(event.parcel.massKg).toBe(0.1)
  expect(event.after.properties).toEqual({ id: 'cargo-point-100g', phase: 'separated', pointMassKg: 0.1, forwardM: 0.08, totalMassKg: 1.5, cgBodyM: [0, 0, 0], inertiaDiagonalKgM2: [0.03, 0.03, 0.05] })
  const origin: CargoVector = [1, -2, 0.5]
  const momentumBefore = cargoVectorScale(pC.map((_, i) => vC[i]!) as CargoVector, 1.6)
  const baseMomentum = cargoVectorScale(before.velocityMps, 1.5), parcelMomentum = cargoVectorScale(event.parcel.velocityMps, 0.1)
  const momentumAfter = cargoVectorAdd(baseMomentum, parcelMomentum)
  const angularBefore = cargoVectorAdd(cargoOrbitalCross(cargoVectorSubtract(pC, origin), momentumBefore), cargoMatrixVector(rotation, [0.03 * wx, 0.0306 * wy, 0.0506 * wz]))
  const angularAfter = cargoVectorAdd(cargoVectorAdd(cargoOrbitalCross(cargoVectorSubtract(event.after.bodyPositionM, origin), baseMomentum), cargoMatrixVector(rotation, [0.03 * wx, 0.03 * wy, 0.05 * wz])), cargoOrbitalCross(cargoVectorSubtract(event.parcel.positionM, origin), parcelMomentum))
  const kineticBefore = 0.5 * 1.6 * cargoDot(vC, vC) + 0.5 * (0.03 * wx ** 2 + 0.0306 * wy ** 2 + 0.0506 * wz ** 2)
  const kineticAfter = 0.5 * 1.5 * cargoDot(event.after.bodyVelocityMps, event.after.bodyVelocityMps) + 0.5 * (0.03 * wx ** 2 + 0.03 * wy ** 2 + 0.05 * wz ** 2) + 0.5 * 0.1 * cargoDot(event.parcel.velocityMps, event.parcel.velocityMps)
  const potentialBefore = -1.6 * 9.80665 * pC[2], potentialAfter = -1.5 * 9.80665 * event.after.bodyPositionM[2] - 0.1 * 9.80665 * event.parcel.positionM[2]
  for (const [pre, post] of [...momentumBefore.map((n, i) => [n, momentumAfter[i]!] as const), ...angularBefore.map((n, i) => [n, angularAfter[i]!] as const), [kineticBefore, kineticAfter], [potentialBefore, potentialAfter]]) expect(Math.abs(pre! - post!)).toBeLessThanOrEqual(1e-10 + 1e-10 * Math.max(Math.abs(pre!), Math.abs(post!)))
  const saved = { body: body.snapshot(), load: body.loadSnapshot() }
  event.before.bodyPositionM[0] = 900; event.after.properties.cgBodyM[0] = 900; event.parcel.velocityMps[0] = 900
  expect({ body: body.snapshot(), load: body.loadSnapshot() }).toEqual(saved)
  const duplicate = body.separateCarriedLoad()
  expect(duplicate).toEqual({ outcome: 'refused', reason: 'already-separated' })
  expect(Object.isFrozen(duplicate)).toBe(true)
  expect({ body: body.snapshot(), load: body.loadSnapshot() }).toEqual(saved)
})

import type { GnssMeasurement, ImuMeasurement } from '../../resources/functions/drone/sensors/types'
import { createPhysicsSensorFeed } from '../../resources/functions/drone/controls/sensors'
test('real quantized IMU and GNSS measure the cargo structural datum including tangential and centripetal lever terms', () => {
  const body = cargoRotatingBody(), before = body.snapshot()
  const expected = cargoExpectedStep(before, [4, 3, 2, 5], 0.004, [0.8, -0.4, 0.1], [0.07, -0.02, 0.03], [0.5, -0.2, 0.1])
  const actual = body.step([4, 3, 2, 5], 0.004, { forceN: [0.8, -0.4, 0.1], torqueNm: [0.07, -0.02, 0.03], windMps: [0.5, -0.2, 0.1] })
  const rotation = cargoRotation(expected.q), transpose = [0, 1, 2].map(i => rotation.map(row => row[i]!) as CargoVector)
  const bodySpecific = cargoMatrixVector(transpose, [expected.acceleration[0], expected.acceleration[1], expected.acceleration[2] - 9.80665])
  const centerSpecific = cargoMatrixVector(transpose, [expected.centerAcceleration[0], expected.centerAcceleration[1], expected.centerAcceleration[2] - 9.80665])
  const tangentialOnly = cargoMatrixVector(transpose, [expected.tangentialOnlyAcceleration[0], expected.tangentialOnlyAcceleration[1], expected.tangentialOnlyAcceleration[2] - 9.80665])
  const quantized = (value: CargoVector, dither: number): CargoVector => value.map((n, i) => Math.round(n / 9.80665 * 2048 + (i === 0 ? dither : 0)) * 16 * 9.80665 / 32768) as CargoVector
  const firstExpected = quantized(bodySpecific, 0)
  expect(firstExpected.some((n, i) => Math.abs(n - quantized(centerSpecific, 0)[i]!) > 0.004)).toBe(true)
  expect(firstExpected.some((n, i) => Math.abs(n - quantized(tangentialOnly, 0)[i]!) > 0.004)).toBe(true)
  const feed = createPhysicsSensorFeed(0)
  feed.capture(actual, 100)
  const first = feed.advanceTo(104), imu = first.sensors.find(s => s.kind === 'imu')!.observation!, gnss = first.sensors.find(s => s.kind === 'gnss')!.observation!
  expect(first.bootId).toBe(55n)
  expect(imu.healthy).toBe(true); expect(gnss.healthy).toBe(true)
  expect(imu.sequence).toBe(1); expect(imu.capturedUs).toBe(1100000n); expect(imu.estimatedCaptureMs).toBe(100); expect(imu.receivedAtMs).toBe(104)
  const converted = imu.value as ImuMeasurement
  expect(converted.frame).toBe('BODY_FRD')
  cargoExpectVector(converted.specificForceMps2, firstExpected)
  const gyroExpected = expected.rate.map(n => Math.round(n * 180 / Math.PI / 2000 * 32768) * 2000 / 32768 * Math.PI / 180)
  cargoExpectVector(converted.angularRateRadS, gyroExpected)
  const fix = gnss.value as GnssMeasurement
  expect(fix.frame).toBe('WGS84_GEODETIC_NED_VELOCITY')
  expect(gnss.capturedUs).toBe(1100000n); expect(gnss.receivedAtMs).toBe(104)
  expect(fix.latitudeDeg).toBe(Math.round(expected.position[0] / 6335539.3272928195 * 180 / Math.PI * 1e7) / 1e7)
  expect(fix.longitudeDeg).toBe(Math.round(expected.position[1] / 6378237 * 180 / Math.PI * 1e7) / 1e7)
  expect(fix.ellipsoidHeightM).toBe(Math.round((100 - expected.position[2]) * 1000) / 1000)
  cargoExpectVector(fix.velocityNedMps, expected.velocity.map(n => Math.round(n * 1000) / 1000))
  feed.capture(actual, 120)
  const second = feed.advanceTo(124), nextImu = second.sensors.find(s => s.kind === 'imu')!.observation!
  expect(nextImu.sequence).toBe(2); expect(nextImu.capturedUs).toBe(1120000n); expect(nextImu.receivedAtMs).toBe(124)
  cargoExpectVector((nextImu.value as ImuMeasurement).specificForceMps2, quantized(bodySpecific, 1))
  expect(second.sensors.find(s => s.kind === 'gnss')!.observation!.capturedUs).toBe(1100000n)
})

test('configured cargo constructor captures exact own data and rejects malformed records without invoking accessors', () => {
  const valid = () => ({ positionM: [0, 0, -10] as CargoVector, motorsN: [1, 2, 3, 4] as [number, number, number, number], carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0.08 } })
  let getterCalls = 0
  const accessorLoad = Object.defineProperty({}, 'carriedPointLoad', { enumerable: true, get() { getterCalls++; return valid().carriedPointLoad } })
  const accessorMass = Object.defineProperty({ id: 'cargo-point-100g', forwardM: 0.08 }, 'massKg', { enumerable: true, get() { getterCalls++; return 0.1 } })
  const accessorPosition = Object.defineProperty({ carriedPointLoad: valid().carriedPointLoad }, 'positionM', { enumerable: true, get() { getterCalls++; return [0, 0, -10] } })
  const accessorTuple = [0, 0, -10]
  Object.defineProperty(accessorTuple, '1', { enumerable: true, get() { getterCalls++; return 0 } })
  const sparse = [0, , -10]
  const malformed: unknown[] = [
    { carriedPointLoad: undefined }, { carriedPointLoad: null }, { carriedPointLoad: [] },
    { carriedPointLoad: Object.assign(Object.create(null), valid().carriedPointLoad) },
    Object.assign(Object.create(null), valid()), Object.assign(Object.create({ inherited: true }), valid()),
    Object.defineProperty({}, 'carriedPointLoad', { value: valid().carriedPointLoad }),
    accessorLoad, accessorPosition, { carriedPointLoad: accessorMass }, { ...valid(), positionM: accessorTuple },
    { ...valid(), positionM: sparse }, { ...valid(), positionM: new Float64Array([0, 0, -10]) },
    { ...valid(), positionM: Object.assign([0, 0, -10], { extra: 1 }) },
    { ...valid(), positionM: [0, 0, -1000001] }, { ...valid(), motorsN: [0, 0, 0, 10.1] },
    { ...valid(), groundGradient: [0.1, 0.1] }, { ...valid(), groundDownM: 0.1 },
    { ...valid(), groundDownM: undefined }, { ...valid(), groundGradient: undefined },
    { ...valid(), positionM: undefined }, { ...valid(), motorsN: undefined },
    { ...valid(), extra: true }, { ...valid(), [Symbol('private')]: true },
    ...[0, -0.1, 0.250001, NaN, Infinity, '0.1', new Number(0.1)].map(massKg => ({ ...valid(), carriedPointLoad: { ...valid().carriedPointLoad, massKg } })),
    ...[-0.100001, 0.100001, NaN, Infinity, '0.08'].map(forwardM => ({ ...valid(), carriedPointLoad: { ...valid().carriedPointLoad, forwardM } })),
    ...['', 'Cargo', 'cargo point', 'a'.repeat(41), new String('cargo')].map(id => ({ ...valid(), carriedPointLoad: { ...valid().carriedPointLoad, id } })),
    { ...valid(), carriedPointLoad: { ...valid().carriedPointLoad, unknown: true } },
    { ...valid(), carriedPointLoad: { ...valid().carriedPointLoad, [Symbol('private')]: true } },
  ]
  for (const input of malformed) {
    let failure: unknown
    try { createRigidBody(input as never) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(TypeError)
    expect((failure as Error).message).toBe('cargo-load-constructor')
  }
  expect(getterCalls).toBe(0)
  for (const forwardM of [-0.1, 0.1]) expect(createRigidBody({ carriedPointLoad: { id: 'cargo', massKg: 0.25, forwardM } }).loadSnapshot().properties.forwardM).toBe(forwardM)
  const input = valid(), body = createRigidBody(input), preserved = body.snapshot()
  input.carriedPointLoad.massKg = 0.2; input.carriedPointLoad.forwardM = -0.1; input.positionM[0] = 500; input.motorsN[0] = 10
  expect(body.snapshot()).toEqual(preserved)
  expect(body.loadSnapshot().properties.pointMassKg).toBe(0.1)
  expect(body.loadSnapshot().properties.forwardM).toBe(0.08)
  const snapshot = body.loadSnapshot(); snapshot.properties.cgBodyM[0] = 500; snapshot.centerVelocityMps[0] = 500
  expect(body.loadSnapshot().properties.cgBodyM[0]).toBeCloseTo(0.005, 12)
  expect(body.loadSnapshot().centerVelocityMps[0]).toBe(0)
  const rejectArgument = body.separateCarriedLoad as (...args: unknown[]) => unknown
  expect(() => rejectArgument(undefined)).toThrow('cargo-load-separation-arguments')
  expect(body.loadSnapshot().properties.phase).toBe('attached')
  const legacy = createRigidBody(), legacyBefore = legacy.snapshot()
  expect(() => (legacy as unknown as { separateCarriedLoad(): unknown }).separateCarriedLoad()).toThrow(TypeError)
  expect(legacy.snapshot()).toEqual(legacyBefore)
})

test('configured structural-point contact reconstructs the next CG state consistently on a sloping plane', () => {
  const body = createRigidBody({ positionM: [1, 0, -0.001], groundGradient: [-0.02, 0.01], carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0.08 } })
  for (let i = 0; i < 25; i++) {
    const state = body.step([0, 0, 0, 0], 0.004, { torqueNm: [0.2, 0.3, -0.1] }), center = body.loadSnapshot(), rotation = cargoRotation(state.quaternionWxyz)
    const [wx, wy, wz] = state.angularRateRadS
    expect(state.groundContact).toBe(true)
    expect(state.positionM[2]).toBeCloseTo(-0.02 * state.positionM[0] + 0.01 * state.positionM[1], 12)
    expect(state.velocityMps[2]).toBeLessThanOrEqual(0)
    expect(state.accelerationMps2[2]).toBe(0)
    cargoExpectVector(center.centerPositionM, cargoVectorAdd(state.positionM, cargoMatrixVector(rotation, [0.005, 0, 0])))
    cargoExpectVector(center.centerVelocityMps, cargoVectorAdd(state.velocityMps, cargoMatrixVector(rotation, [0, 0.005 * wz, -0.005 * wy])))
    expect(Number.isFinite(wx)).toBe(true)
  }
})

test('separated cargo restores actual base inertia and mass without creating a fresh acceleration sample at the event', () => {
  const body = createRigidBody({ positionM: [0, 0, -10], motorsN: [6, 4, 4, 6], carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0.08 } })
  const before = body.snapshot(), event = body.separateCarriedLoad()
  expect(body.snapshot()).toEqual(before)
  expect(event.outcome).toBe('separated')
  if (event.outcome !== 'separated') throw new Error('Expected a prescribed separation')
  expect('accelerationMps2' in event.before).toBe(false)
  expect('accelerationMps2' in event.after).toBe(false)
  const state = body.step([6, 4, 4, 6], 0.004)
  cargoExpectVector(state.angularRateRadS, [0, 0.08533333333333333, 0])
  const pitch = 0.08533333333333333 * 0.004, expectedQ: CargoQuaternion = [Math.cos(pitch / 2), 0, Math.sin(pitch / 2), 0]
  const force = cargoMatrixVector(cargoRotation(expectedQ), [0, 0, -20])
  cargoExpectVector(state.accelerationMps2, [force[0] / 1.5, force[1] / 1.5, force[2] / 1.5 + 9.80665])
  expect(body.loadSnapshot().properties.phase).toBe('separated')
})

test('absent cargo options preserve legacy simulator own keys and explicit BigInt identity serialization', () => {
  const result = simulateMultirotor()
  expect(Object.keys(result)).toEqual(['evidence', 'scenario', 'seconds', 'physicsStepMs', 'additionalSensorDelayMs', 'physicalFlightEnabled', 'boardOutputsInhibited', 'headingAlignment', 'gravityCorrection', 'supportWarmupMs', 'model', 'response', 'metrics', 'state', 'estimate', 'control', 'trace', 'authority'])
  expect(Object.keys(result.state)).toEqual(['positionM', 'velocityMps', 'angularRateRadS', 'accelerationMps2', 'quaternionWxyz', 'motorsN', 'groundContact'])
  expect(result.estimate.bootId).toBe(55n)
  expect(JSON.stringify(result, (key, value) => typeof value === 'bigint' ? String(value) : value)).toContain('"bootId":"55"')
  expect('cargoLoadEvidence' in result).toBe(false)
})


test('configured cargo constructor bounds errors from its own-load descriptor probe', () => {
  const target = { carriedPointLoad: { id: 'cargo-point-100g', massKg: 0.1, forwardM: 0.08 } }
  expect(Object.hasOwn(target, 'carriedPointLoad')).toBe(true)
  const input = new Proxy(target, {
    getOwnPropertyDescriptor(target, name) {
      if (name === 'carriedPointLoad') throw new Error('private descriptor detail')
      return Reflect.getOwnPropertyDescriptor(target, name)
    },
  })
  let failure: unknown
  try { createRigidBody(input) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(TypeError)
  expect((failure as Error).message).toBe('cargo-load-constructor')
})
