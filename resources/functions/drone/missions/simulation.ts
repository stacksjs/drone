import type { ImuMeasurement } from '../sensors/types'
import type { Motors } from '../controls/model'
import type { MissionAction, MissionSnapshot } from './engine'
import type { EstimatorSnapshot } from '../estimation/estimator'
import type { SensorSnapshot } from '../sensors/pipeline'
import type { RigidBodyState } from '../controls/physics'
import type { AuthorityState } from '../authority/supervisor'
import { createAuthoritySupervisor } from '../authority/supervisor'
import { createSimulatedOutputWatchdog } from '../authority/watchdog'
import { createRigidBody } from '../controls/physics'
import { createPhysicsSensorFeed } from '../controls/sensors'
import { createEstimator } from '../estimation/estimator'
import { createSimulatedMultirotorController } from '../controls/controller'
import { createMissionEngine, observeMission, recoverMission } from './engine'
import { exampleMission, validateMission } from './plan'
export const missionScenarios = ['nominal', 'pause-resume', 'recovery', 'abort', 'rc-override', 'reserve', 'branch-return'] as const
export type MissionScenario = typeof missionScenarios[number]
/** Simulation instrumentation keeps model rendering separate from estimated collection decisions. */
export interface MissionSimulationInstrument {
  dropSensors?(nowMs: number): { imu?: boolean, position?: boolean }
  render(state: RigidBodyState, nowMs: number): void
  observe(context: { nowMs: number, estimate: EstimatorSnapshot, sensors: SensorSnapshot, mission: MissionSnapshot, authority: AuthorityState }): 'abort' | undefined
}
/** Actual owned raw-sensor/estimator/control pipeline, with a separately ticking modeled board. */
export function simulateMission(options: { plan?: unknown, scenario?: MissionScenario, seconds?: number, instrument?: MissionSimulationInstrument } = {}) {
  const scenario = options.scenario ?? 'nominal'
  const seconds = options.seconds ?? 45
  if (!missionScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 120) throw new RangeError('Invalid mission scenario or duration (8..120 seconds)')
  const { plan, worstCaseMs, requiredWh } = validateMission(options.plan ?? exampleMission())
  // The sensor fixture has this geodetic world origin. Other plans remain valid for policy replay only.
  if (plan.origin.latitudeDeg !== 0 || plan.origin.longitudeDeg !== 0 || plan.origin.ellipsoidHeightM !== 100) throw new TypeError('Physics fixture requires origin 0,0,100 WGS84 ellipsoid')
  let engine = createMissionEngine(plan)
  const supervisor = createAuthoritySupervisor({ sessionId: 123n, bootId: 55n })
  const board = createSimulatedOutputWatchdog({ sessionId: 123n, bootId: 55n })
  const body = createRigidBody({ positionM: [0, 0, -0.1], groundDownM: -0.1 })
  const feed = createPhysicsSensorFeed(0)
  const estimator = createEstimator({ origin: plan.origin, gravityCorrection: 'initialization-only' })
  const controller = createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
  let truth = body.snapshot()
  let estimate = estimator.snapshot(0)
  let sensors = feed.advanceTo(0)
  let command: Motors = [0, 0, 0, 0]
  let mission: MissionSnapshot = engine.snapshot()
  let lastTask = ''
  let lastState = ''
  let recovered = false
  const transitions: { atMs: number, taskId: string, state: string, reason: string }[] = []
  const path: { atMs: number, estimatedPositionM: number[] | null, truthPositionM: number[], targetM: number[] | null, state: string, taskId: string }[] = []
  const triggers: { atMs: number, taskId: string, channel: string, evidence: 'simulated-event' }[] = []
  try { for (let nowMs = 0; nowMs <= seconds * 1000; nowMs += 4) {
    command = board.tick(nowMs).motorsN
    if (nowMs > 600) truth = body.step(command, 0.004)
    const dropped = options.instrument?.dropSensors?.(nowMs)
    feed.capture(truth, nowMs, dropped?.imu, dropped?.position)
    sensors = feed.advanceTo(nowMs)
    estimate = estimator.update(sensors)
    if (nowMs < 600 || nowMs % 20 !== 0) continue
    const batteryPercent = scenario === 'reserve' && nowMs >= 5000 ? 29 : (scenario === 'branch-return' ? 75 : 100) - plan.power.hoverW * Math.max(0, nowMs - 600) / 3600000 / plan.power.availableWh * 100
    const runtime = board.snapshot()
    const observation = {
      kind: 'simulation' as const, nowMs, estimate,
      runtime: { bootId: runtime.bootId, capturedAtMs: nowMs, watchdogHealthy: runtime.fault === null },
      rc: { capturedAtMs: nowMs, connected: true, armSwitch: true, override: scenario === 'rc-override' && nowMs >= 5000 },
      interlocks: { capturedAtMs: nowMs, killActive: false, onGround: nowMs === 600 || truth.groundContact, motorsStopped: truth.motorsN.every(n => n < 0.01) },
      battery: { capturedAtMs: nowMs, remainingPercent: batteryPercent }, link: { capturedAtMs: nowMs, connected: true },
    }
    const send = (action: 'arm' | 'engage' | 'renew' | 'disarm', targetM = mission.targetM) => {
      const s = supervisor.snapshot()
      return supervisor.update(observation, { version: 1, sessionId: s.sessionId, bootId: s.bootId, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: nowMs, action, mode: 'position', leaseMs: 100, target: { positionM: targetM ?? [0, 0, 0], yawRad: 0 } })
    }
    supervisor.update(observation)
    // This fixture is an explicit operator script. The mission engine never arms itself.
    if (nowMs === 600) { send('arm'); send('engage', [0, 0, 0]) }
    const missionInput = observeMission({ estimate, authority: supervisor.snapshot().state, batteryPercent, onGround: observation.interlocks.onGround })
    let action: MissionAction | undefined = nowMs === 600 ? 'start' : undefined
    if (options.instrument) {
      try {
        options.instrument.render(structuredClone(truth), nowMs)
        if (options.instrument.observe({ nowMs, estimate: structuredClone(estimate), sensors: structuredClone(sensors), mission: structuredClone(mission), authority: supervisor.snapshot().state }) === 'abort') action = 'abort'
      }
      catch { action = 'abort' }
    }
    if (scenario === 'pause-resume' && nowMs === 5000) action = 'pause'
    if ((scenario === 'pause-resume' || scenario === 'recovery') && nowMs === 7000) action = 'resume'
    if (scenario === 'abort' && nowMs === 5000) action = 'abort'
    if (scenario === 'recovery' && nowMs === 5000) {
      engine = recoverMission(JSON.parse(JSON.stringify(engine.trace())), missionInput)
      mission = engine.snapshot(); recovered = true
    }
    else mission = engine.step(missionInput, action)
    if (mission.payload) triggers.push({ atMs: nowMs, ...mission.payload, evidence: 'simulated-event' })
    if (mission.state === 'running' || mission.state === 'paused') send('renew')
    else { send('disarm'); board.revoke() }
    const imuObservation = sensors.sensors.find(s => s.kind === 'imu')?.observation
    const measurement = imuObservation?.value as ImuMeasurement | undefined
    const output = controller.step({ kind: 'simulation', enabled: supervisor.snapshot().state === 'autonomous', nowMs, estimate, angularRateRadS: measurement?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: imuObservation?.estimatedCaptureMs ?? -Infinity, target: { positionM: supervisor.snapshot().target?.positionM ?? [0, 0, 0], yawRad: 0, issuedAtMs: nowMs } })
    const frame = supervisor.gate(output, nowMs)
    if (frame) board.accept(frame, nowMs)
    else board.revoke()
    if (mission.taskId !== lastTask || mission.state !== lastState) {
      transitions.push({ atMs: nowMs, taskId: mission.taskId, state: mission.state, reason: mission.reason })
      lastTask = mission.taskId; lastState = mission.state
    }
    if (nowMs % 200 === 0 || !['running', 'paused'].includes(mission.state)) path.push({ atMs: nowMs, estimatedPositionM: estimate.localPosition?.positionM ?? null, truthPositionM: [...truth.positionM], targetM: mission.targetM, state: mission.state, taskId: mission.taskId })
    if (!['running', 'paused'].includes(mission.state)) break
  } }
  finally { board.revoke() }
  return { evidence: 'owned-mission-physics-simulation' as const, physicalFlightEnabled: false, boardOutputsInhibited: true, scenario, recovered, mission, budget: { worstCaseMs, requiredWh }, transitions, triggers, path, trace: engine.trace(), authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: truth.positionM }
}
