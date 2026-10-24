import { describe, expect, test } from 'bun:test'
import { createGroundPlant, groundModel } from '../../resources/functions/drone/vehicles/ground/plant'

describe('owned ground vehicle', () => {
  test('torque reaches wheel inertia before chassis acceleration and neutral coasts', () => {
    const plant = createGroundPlant()
    const first = plant.step([0.1, 0.1, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
    expect(first.positionM).toEqual([0, 0, 0])
    // tau=0.1*3Nm; alpha=tau/0.08kgm2; dt=0.004s, before contact slip exists.
    expect(first.details.leftWheelRadS).toBeCloseTo(0.015, 10)
    for (let i = 0; i < 1000; i++) plant.step([0.2, 0.2, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
    const moving = plant.snapshot()
    expect(moving.positionM[0]).toBeGreaterThan(0.5)
    expect(moving.positionM[1]).toBeCloseTo(0, 10)
    expect(moving.velocityMps[0]).toBeGreaterThan(0)
    const coast = plant.step([0, 0, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
    expect(coast.velocityMps[0]).toBeGreaterThan(0)
    expect(groundModel.trackM).toBe(0.6)
  })
})

import { createGroundOdometry, groundStoppingEnvelope } from '../../resources/functions/drone/vehicles/ground/odometry'
import { createGroundProfile, groundMission } from '../../resources/functions/drone/vehicles/ground/profile'
import { groundContext, groundPacket, groundPayloadContext } from '../fixtures/ground/context'

test('raw encoder travel is calibrated and corrected using owned estimator data', () => {
  const odometry = createGroundOdometry()
  const first = groundContext(1000)
  expect(odometry.step(first.measurement, first.estimate, first.nowMs).healthy).toBe(true)
  const next = groundContext(1100)
  next.measurement!.values.encoderCounts = [100, 100]
  const fused = odometry.step(next.measurement, next.estimate, next.nowMs)
  // 100 / 4096 revolutions * circumference 0.3*pi = 0.0230097118m.
  expect(fused.wheelSpeedMps).toBeCloseTo(0.2300971182, 8)
  expect(fused.positionM[0]).toBeCloseTo(0.0184077695, 8)
  expect(fused.speedMps).toBeCloseTo(0.0460194236, 8)
  next.measurement!.values.encoderCounts = [99999, 99999]
  expect(odometry.step(next.measurement, next.estimate, next.nowMs).reason).toBe('ground-sensor-replay')
})

test('qualified wheel sensors reject stale, reordered, wrong calibration and unhealthy localization', () => {
  for (const fault of ['stale', 'calibration', 'future', 'reference', 'localization', 'origin']) {
    const c = groundContext(), odometry = createGroundOdometry()
    if (fault === 'stale') c.measurement!.capturedAtMs = c.nowMs - 160
    if (fault === 'calibration') c.measurement!.values.calibration = 'wrong'
    if (fault === 'future') c.measurement!.receivedAtMs += 1
    if (fault === 'reference') c.measurement!.reference = '2:0,0,0,0,0'
    if (fault === 'origin') c.estimate.localPosition!.origin!.ellipsoidHeightM = 101
    if (fault === 'localization') c.estimate.health.localPosition = false
    expect(odometry.step(c.measurement, c.estimate, c.nowMs).healthy).toBe(false)
  }
  const odometry = createGroundOdometry(), c = groundContext()
  expect(odometry.step(c.measurement, c.estimate, c.nowMs).healthy).toBe(true)
  c.estimate.nowMs += 20
  expect(odometry.step(c.measurement, c.estimate, c.nowMs + 20).healthy).toBe(true)
  const old = groundPacket(980)
  expect(odometry.step(old, c.estimate, c.nowMs + 20).reason).toBe('ground-sensor-replay')
})

test('proximity and implement hazards latch and revoke mower and drive outputs', () => {
  for (const [key, value, reason] of [['personMm', 1500, 'ground-person-proximity'], ['obstacleMm', 500, 'ground-obstacle-stopping-envelope'], ['emergency', true, 'ground-emergency-stop'], ['guardClosed', false, 'ground-implement-interlock']] as const) {
    const session = createGroundProfile().createSession(), controller = session.createController(), c = groundContext()
    expect(controller.step(c).actuators[0]).toBeGreaterThan(0)
    const hazard = groundContext(1020)
    hazard.measurement!.values[key] = value
    expect(controller.step(hazard)).toMatchObject({ inhibited: true, reason, actuators: [0, 0, 0, 1] })
    expect(controller.step(groundContext(1040))).toMatchObject({ inhibited: true, reason, actuators: [0, 0, 0, 1] })
  }
  expect(groundStoppingEnvelope(1, 100, 0.1)).toBeCloseTo(1.95, 10)
})

test('payload acknowledgement is scoped once and mower requires stationary guarded surface', () => {
  const session = createGroundProfile().createSession(), port = session.createPayload!(), controller = session.createController(), c = groundContext()
  const command = { eventId: 'ground-mowing-coverage:1:0,0,0,0,0:enable', taskId: 'enable', operation: 'mower-enable' as const, containerId: null, issuedAtMs: 1000, expiresAtMs: 1500, positionM: [0, 0, 0] as [number, number, number], reference: c.measurement!.reference }
  port.observe!(groundPayloadContext(c, command))
  port.request(command)
  expect(port.poll(1059)).toBe(null)
  expect(port.poll(1060)).toMatchObject({ eventId: 'ground-mowing-coverage:1:0,0,0,0,0:enable', capturedAtMs: 1000, outcome: 'confirmed' })
  expect(controller.step(c).actuators[2]).toBe(1)
  expect(() => port.request(command)).toThrow()
  c.enabled = false
  expect(controller.step(c).actuators).toEqual([0, 0, 0, 1])
  const moving = groundContext(1100); moving.measurement!.values.stopped = false
  const movingCommand = { ...command, eventId: 'mower-2', issuedAtMs: 1100 }
  port.observe!(groundPayloadContext(moving, movingCommand))
  port.request(movingCommand)
  expect(port.poll(1160)).toMatchObject({ outcome: 'rejected' })
  const plan = groundMission('logistics')
  expect(plan.tasks.find(t => t.kind === 'payload')).toMatchObject({ operation: 'material-drop', containerId: 'tray-1' })
})

import { planGroundCoverage } from '../../resources/functions/drone/vehicles/ground/coverage'
test('coverage strips cover the declared rectangle at measured-swath spacing without changing caller configuration', () => {
  const options = { lengthM: 3, lanes: 2, swathM: 0.8 }
  const plan = planGroundCoverage(options)
  expect(plan.pointsM).toEqual([[3, 0, 0], [3, 0.8, 0], [0, 0.8, 0]])
  expect(plan.modeledStripAreaM2).toBeCloseTo(4.8, 10)
  expect(plan.footprintM).toMatchObject({ minNorth: 0, maxNorth: 3, minEast: -0.4 })
  expect(plan.footprintM.maxEast).toBeCloseTo(1.2, 10)
  options.swathM = 100
  expect(plan.swathM).toBe(0.8)
  expect(() => planGroundCoverage(options)).toThrow()
})

test('differential wheel forces yaw clockwise in NED and low grip limits chassis acceleration', () => {
  const normal = createGroundPlant(), ice = createGroundPlant({ friction: 0.015 })
  for (let i = 0; i < 250; i++) {
    normal.step([-0.25, 0.25, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
    ice.step([1, 1, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  }
  expect(normal.snapshot().angularRateRadS[2]).toBeGreaterThan(0.1)
  expect(normal.snapshot().quaternionWxyz[3]).toBeGreaterThan(0)
  // Coulomb contact force <= mu*m*g, therefore acceleration <= mu*g independently of wheel speed.
  expect(ice.snapshot().velocityMps[0]).toBeLessThanOrEqual(0.015 * 9.80665)
  expect(Number(ice.snapshot().details.leftWheelRadS) * 0.15).toBeGreaterThan(ice.snapshot().velocityMps[0] + 1)
  const original = normal.snapshot(); original.positionM[0] = 100
  expect(normal.snapshot().positionM[0]).not.toBe(100)
})

test('sustained encoder and GNSS disagreement rejects traction rather than trusting wheel travel', () => {
  const odometry = createGroundOdometry()
  const initial = groundContext()
  odometry.step(initial.measurement, initial.estimate, initial.nowMs)
  let final
  for (let t = 1020; t <= 1240; t += 20) {
    const c = groundContext(t)
    c.measurement!.values.encoderCounts = [(t - 1000) * 5, (t - 1000) * 5]
    final = odometry.step(c.measurement, c.estimate, c.nowMs)
  }
  expect(final).toMatchObject({ healthy: false, reason: 'ground-traction-loss' })
})

test('normally engaged neutral brake stops modeled nominal motion inside declared braking distance', () => {
  const plant = createGroundPlant(), environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
  for (let i = 0; i < 800; i++) plant.step([0.3, 0.3, 0, 0], 0.004, environment)
  const before = plant.snapshot(), speed = before.velocityMps[0]
  expect(speed).toBeGreaterThan(0.6)
  let elapsed = 0
  while (plant.snapshot().velocityMps[0] > 0.02 && elapsed < 4) { plant.step([0, 0, 0, 1], 0.004, environment); elapsed += 0.004 }
  const distance = plant.snapshot().positionM[0] - before.positionM[0]
  // Independent constant 0.5m/s² braking bound; actual viscous/slip transient must fit below it.
  expect(distance).toBeLessThan(speed ** 2 / (2 * 0.5))
  expect(elapsed).toBeLessThan(speed / 0.5)
  expect(plant.snapshot().velocityMps[0]).toBeLessThan(0.02)
  expect(createGroundProfile().actuators.map(a => a.neutral)).toEqual([0, 0, 0, 1])
})

test('implement port rejects superficially safe booleans without qualified wheel calibration', () => {
  const session = createGroundProfile().createSession(), port = session.createPayload!(), c = groundContext()
  c.measurement!.values.calibration = 'unverified-radius'
  const command = { eventId: 'bad-calibration', taskId: 'enable', operation: 'mower-enable' as const, containerId: null, issuedAtMs: 1000, expiresAtMs: 1500, positionM: [0, 0, 0] as [number, number, number], reference: '1:0,0,0,0,0' }
  port.observe!(groundPayloadContext(c, command))
  port.request(command)
  expect(port.poll(1060)).toMatchObject({ outcome: 'rejected' })
})

test('lateral slip consumes the contact friction budget instead of rotating velocity without force', () => {
  const mu = 0.04, plant = createGroundPlant({ friction: mu }), environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
  for (let i = 0; i < 1000; i++) plant.step([1, 1, 0, 0], 0.004, environment)
  let maximum = 0, lateral = 0
  for (let i = 0; i < 1000; i++) {
    const before = plant.snapshot(), after = plant.step([-0.5, 1, 0, 0], 0.004, environment)
    const acceleration = Math.hypot((after.velocityMps[0] - before.velocityMps[0]) / 0.004, (after.velocityMps[1] - before.velocityMps[1]) / 0.004)
    const dragBound = Math.abs(Number(before.details.speedMps)) * 4 / 25
    expect(acceleration).toBeLessThanOrEqual(mu * 9.80665 + dragBound + 1e-10)
    maximum = Math.max(maximum, acceleration)
    lateral = Math.max(lateral, Math.abs(Number(after.details.lateralMps)))
  }
  expect(lateral).toBeGreaterThan(0.01)
  expect(maximum).toBeGreaterThan(0.1)
})

test('material tray is consumed once and command position is checked before acknowledgement', () => {
  const port = createGroundProfile('logistics').createSession().createPayload!(), c = groundContext()
  const command = { eventId: 'drop-1', taskId: 'drop', operation: 'material-drop' as const, containerId: 'tray-1', issuedAtMs: 1000, expiresAtMs: 1500, positionM: [0, 0, 0] as [number, number, number], reference: '1:0,0,0,0,0' }
  port.observe!(groundPayloadContext(c, command))
  port.request(command)
  expect(port.poll(1060)).toMatchObject({ outcome: 'confirmed' })
  const again = { ...command, eventId: 'drop-2' }
  port.observe!(groundPayloadContext(c, again))
  port.request(again)
  expect(port.poll(1060)).toMatchObject({ outcome: 'rejected' })
  expect(() => port.poll(1059)).toThrow()
  const distant = createGroundProfile().createSession().createPayload!()
  const distantCommand = { ...command, eventId: 'mower-away', operation: 'mower-enable' as const, containerId: null, positionM: [10, 0, 0] as [number, number, number] }
  distant.observe!(groundPayloadContext(c, distantCommand))
  distant.request(distantCommand)
  expect(distant.poll(1060)).toMatchObject({ outcome: 'rejected' })
})

test('differential moment uses measured track and yaw inertia in the first force-producing step', () => {
  const plant = createGroundPlant(), environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
  plant.step([-0.1, 0.1, 0, 0], 0.004, environment)
  const second = plant.step([-0.1, 0.1, 0, 0], 0.004, environment)
  // First wheel speed +/-0.015rad/s gives +/-0.36N contact forces on step2.
  // Moment=(.36-(-.36))*.3=.216Nm; deltaYawRate=.216/3*.004=.000288rad/s.
  expect(second.angularRateRadS[2]).toBeCloseTo(0.000288, 12)
})

test('mowing and materials logistics execute through the common owned sensor estimator mission runtime', async () => {
  const { runVehicleSimulation } = await import('../../resources/functions/drone/vehicles/runtime')
  for (const scenario of ['nominal', 'logistics']) {
    const result = runVehicleSimulation(createGroundProfile(scenario), { scenario, seconds: 120 })
    expect(result.status).toBe('completed')
    expect(result.mission.state).toBe('completed')
    expect(result.path.some(row => row.truthPositionM[0] > 2.7)).toBe(true)
    expect(result.path.some(row => row.truthPositionM[1] > 0.7)).toBe(true)
    expect(Math.hypot(...result.finalTruthPositionM)).toBeLessThan(0.25)
    expect(result.board.actuators).toEqual([0, 0, 0, 1])
    expect(result.trace.rows.some(row => row.observation.payloadAck?.outcome === 'confirmed')).toBe(true)
    expect(result.trace.rows.at(-1)!.observation.onGround).toBe(true)
    expect(Math.hypot(...result.trace.rows.at(-1)!.observation.velocityMps!)).toBeLessThanOrEqual(0.1)
  }
}, 60000)

test('ground runtime revokes every declared hazard and keeps manual and host failures independent', async () => {
  const { runVehicleSimulation } = await import('../../resources/functions/drone/vehicles/runtime')
  for (const scenario of ['low-traction', 'obstacle', 'people', 'manual', 'localization-loss', 'emergency', 'implement-open', 'sensor-loss', 'host-loss']) {
    const result = runVehicleSimulation(createGroundProfile(scenario), { scenario, seconds: 15 })
    expect(result.status).toBe(scenario === 'host-loss' ? 'host-lost' : 'blocked')
  }
}, 60000)

import { join } from 'node:path'
test('native GroundSimulate command parses real options and reports a bounded modeled mission', async () => {
  const command = (args: string[]) => Bun.spawn([process.execPath, '--no-env-file', `--config=${join(import.meta.dir, '../fixtures/process/bunfig.toml')}`, join(import.meta.dir, '../fixtures/ground/cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' })
  const child = command(['ground:simulate', '--scenario', 'logistics', '--seconds', '120'])
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(stderr).toBe('')
  expect(code).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.status).toBe('completed')
  expect(result.recordedMissionRows).toBeGreaterThan(10)
  const invalid = command(['ground:simulate', '--seconds', '1.5'])
  const [, invalidError, invalidCode] = await Promise.all([new Response(invalid.stdout).text(), new Response(invalid.stderr).text(), invalid.exited])
  expect(invalidCode).toBe(1)
  expect(invalidError).toContain('integer from 2 to 180')
}, 180000)

test('implement commands must match the current pending mission event before an action can occur', () => {
  const session = createGroundProfile().createSession(), port = session.createPayload!(), c = groundContext()
  const authorized = { eventId: 'scoped-enable', taskId: 'enable', operation: 'mower-enable' as const, containerId: null, issuedAtMs: 1000, expiresAtMs: 1500, positionM: [0, 0, 0] as [number, number, number], reference: '1:0,0,0,0,0' }
  port.observe!(groundPayloadContext(c, authorized))
  port.request({ ...authorized, operation: 'material-drop', containerId: 'tray-1' })
  expect(port.poll(1060)).toMatchObject({ outcome: 'rejected' })
  expect(session.createController().step(c).actuators[2]).toBe(0)
})

test('the same reusable ground profile starts isolated complete runs without retained closed payload state', async () => {
  const { runVehicleSimulation } = await import('../../resources/functions/drone/vehicles/runtime')
  for (const scenario of ['nominal', 'logistics']) {
    const profile = createGroundProfile(scenario)
    const first = runVehicleSimulation(profile, { scenario, seconds: 120 })
    const second = runVehicleSimulation(profile, { scenario, seconds: 120 })
    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    expect(second.trace).toEqual(first.trace)
  }
})

test('ground rejects stale estimator time and stale or future position prediction epochs', () => {
  for (const fault of ['stale-clock', 'future-clock', 'invalid-clock', 'stale-prediction', 'future-prediction', 'invalid-prediction']) {
    const c = groundContext()
    if (fault === 'stale-clock') c.estimate.nowMs -= 1
    if (fault === 'future-clock') c.estimate.nowMs += 1
    if (fault === 'invalid-clock') c.estimate.nowMs = NaN
    if (fault === 'stale-prediction') { c.estimate.localPosition!.capturedAtMs = c.nowMs - 100; c.estimate.localPosition!.predictedToMs = c.nowMs - 41 }
    if (fault === 'future-prediction') c.estimate.localPosition!.predictedToMs = c.nowMs + 1
    if (fault === 'invalid-prediction') c.estimate.localPosition!.predictedToMs = NaN
    expect(createGroundOdometry().step(c.measurement, c.estimate, c.nowMs).healthy).toBe(false)
    const session = createGroundProfile().createSession()
    expect(session.createController().step(c)).toMatchObject({ inhibited: true, actuators: [0, 0, 0, 1], reason: 'ground-localization-loss' })
    const port = session.createPayload!()
    const command = { eventId: 'time-enable', taskId: 'enable', operation: 'mower-enable' as const, containerId: null, issuedAtMs: 1000, expiresAtMs: 1500, positionM: [0, 0, 0] as [number, number, number], reference: '1:0,0,0,0,0' }
    port.observe!(groundPayloadContext(c, command))
    port.request(command)
    expect(port.poll(1060)).toMatchObject({ outcome: 'rejected' })
  }
})

test('concurrent ground sessions isolate mower authority, payload events, close state and measurement sequence', () => {
  const profile = createGroundProfile(), a = profile.createSession(), b = profile.createSession()
  const aController = a.createController(), bController = b.createController(), aPort = a.createPayload!(), bPort = b.createPayload!(), c = groundContext()
  const command = { eventId: 'session-enable', taskId: 'enable', operation: 'mower-enable' as const, containerId: null, issuedAtMs: 1000, expiresAtMs: 1500, positionM: [0, 0, 0] as [number, number, number], reference: '1:0,0,0,0,0' }
  aPort.observe!(groundPayloadContext(c, command))
  bPort.observe!(groundPayloadContext(c, command))
  aPort.request(command)
  expect(aController.step(c).actuators[2]).toBe(1)
  expect(bController.step(c).actuators[2]).toBe(0)
  expect(bPort.poll(1060)).toBe(null)
  expect(aPort.poll(1060)).toMatchObject({ outcome: 'confirmed' })
  aPort.close()
  bPort.request(command)
  expect(bPort.poll(1060)).toMatchObject({ outcome: 'confirmed' })
  expect(bController.step(c).actuators[2]).toBe(1)
  const aPlant = a.createPlant(), bPlant = b.createPlant()
  expect(a.renderMeasurement(aPlant.snapshot(), 1000, command.reference).sequence).toBe(1)
  expect(a.renderMeasurement(aPlant.snapshot(), 1020, command.reference).sequence).toBe(2)
  expect(b.renderMeasurement(bPlant.snapshot(), 1000, command.reference).sequence).toBe(1)
  aPlant.step([1, 1, 0, 0], 0.004, { windMps: [0, 0, 0], currentMps: [0, 0, 0] })
  expect(bPlant.snapshot().details.leftWheelRadS).toBe(0)
})
