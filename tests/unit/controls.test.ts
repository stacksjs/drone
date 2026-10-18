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
