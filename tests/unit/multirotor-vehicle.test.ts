import { expect, test } from 'bun:test'
import { createMultirotorProfile } from '../../resources/functions/drone/vehicles/multirotor/profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import { replayVehicleMission } from '../../resources/functions/drone/missions/vehicle'

// Existing public owned-runtime seam: actual raw sensors, estimator, mission,
// controls and board. This verifies modeled execution, not firmware or flight.
test('a four-motor profile executes the shared mission and lands with replayable observations', () => {
  const run = runVehicleSimulation(createMultirotorProfile(), { seconds: 100 })
  expect(run.vehicle).toBe('quadcopter')
  expect(run.status).toBe('completed')
  expect(run.fault).toBeNull()
  expect(run.navigationEvidence.observedSensors.imu).toBeGreaterThan(100)
  expect(run.navigationEvidence.observedSensors.gnss).toBeGreaterThan(20)
  expect(run.path.some(row => row.positionM && Math.hypot(row.positionM[0] - 2, row.positionM[1] - 1, row.positionM[2] + 1) < .25)).toBe(true)
  expect(run.path.some(row => row.actuators.some(n => n > 0))).toBe(true)
  expect(run.trace.rows.at(-1)!.observation.onGround).toBe(true)
  expect(run.board.actuators).toEqual([0, 0, 0, 0])
  expect(run.board.expiresAtMs).toBeNull()
  expect(run.authority.state).toBe('disarmed')
  expect(replayVehicleMission(run.trace).snapshot()).toEqual(run.mission)
  expect(run.physicalFlightEnabled).toBe(false)
  expect(run.board.physicalActuationEnabled).toBe(false)
}, 30000)

for (const scenario of ['imu-loss', 'position-loss', 'vehicle-sensor-loss', 'rc-override', 'kill', 'host-loss', 'link-loss'] as const) {
  test('the shared four-motor mission preserves independent authority under ' + scenario, () => {
    const run = runVehicleSimulation(createMultirotorProfile(scenario), { seconds: 100 })
    expect(run.status).toBe(scenario === 'host-loss' ? 'host-lost' : 'blocked')
    expect(run.mission.state).not.toBe('completed')
    expect(run.board.actuators).toEqual([0, 0, 0, 0])
    expect(run.board.expiresAtMs).toBeNull()
    expect(run.fault).not.toBeNull()
    expect(run.board.physicalActuationEnabled).toBe(false)
    if (scenario === 'host-loss') {
      expect(run.board.fault).toBe('output-lease-expired')
      expect(run.authority.state).toBe('autonomous')
    }
    else expect(run.authority.state).not.toBe('autonomous')
  }, 30000)
}

test('a four-motor controller rejects rate evidence from a different estimator reference', () => {
  const profile = createMultirotorProfile(), createSession = profile.createSession
  let changed = false
  profile.createSession = () => {
    const session = createSession(), controller = session.createController()
    return { ...session, createController: () => ({ step(context) {
      if (context.enabled && context.nowMs === 2000 && context.controlRate) {
        context.controlRate.reference = '55:99,99,99,99,99'
        changed = true
      }
      return controller.step(context)
    } }) }
  }
  const run = runVehicleSimulation(profile, { seconds: 100 })
  expect(changed).toBe(true)
  expect(run.status).toBe('blocked')
  expect(run.fault).toBe('quad-rate-unqualified')
  expect(run.board.actuators).toEqual([0, 0, 0, 0])
}, 30000)

test('an installed link adapter cannot become a fabricated healthy link when its result fails', () => {
  let getterRead = false
  const badResults: (() => unknown)[] = [() => null, () => undefined, () => { throw new Error('private-radio-detail') },
    () => ({ capturedAtMs: 2001, connected: true }), () => ({ capturedAtMs: 2000, connected: 'yes' }),
    () => ({ capturedAtMs: 2000, get connected() { getterRead = true; return true } })]
  for (const badResult of badResults) {
    const profile = createMultirotorProfile(), createSession = profile.createSession
    profile.createSession = () => ({ ...createSession(), linkObservation(nowMs) {
      return (nowMs < 2000 ? { capturedAtMs: nowMs, connected: true } : badResult()) as { capturedAtMs: number, connected: boolean }
    } })
    const run = runVehicleSimulation(profile, { seconds: 100 })
    expect(run.status).toBe('blocked')
    expect(run.authority.events.some(event => event.reason === 'link-loss')).toBe(true)
    expect(run.board.actuators).toEqual([0, 0, 0, 0])
    expect(run.board.expiresAtMs).toBeNull()
  }
  expect(getterRead).toBe(false)
}, 30000)

test('an installed link adapter preserves source age and cannot override declared link loss', () => {
  for (const scenario of ['nominal', 'link-loss'] as const) {
    const profile = createMultirotorProfile(scenario), createSession = profile.createSession
    profile.createSession = () => ({ ...createSession(), linkObservation: nowMs => ({ capturedAtMs: scenario === 'nominal' ? Math.min(nowMs, 2000) : nowMs, connected: true }) })
    const run = runVehicleSimulation(profile, { seconds: 100 })
    expect(run.status).toBe('blocked')
    expect(run.authority.events.some(event => event.reason === 'link-loss')).toBe(true)
    expect(run.path.at(-1)!.atMs).toBe(scenario === 'nominal' ? 2160 : 5000)
    expect(run.board.actuators).toEqual([0, 0, 0, 0])
  }
}, 30000)
