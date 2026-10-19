import type { SensorVector, ImuMeasurement } from '../sensors/types'
import type { Motors } from '../controls/model'
import type { MissionAction, MissionSnapshot } from './engine'
import type { EstimatorSnapshot } from '../estimation/estimator'
import type { SensorSnapshot } from '../sensors/pipeline'
import type { RigidBodyState } from '../controls/physics'
import type { AuthorityState, AuthorityObservation } from '../authority/supervisor'
import { authorityPolicy } from '../authority/supervisor'
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
/** Qualified external fixture observations. Neither field can increase modeled authority. */
export interface MissionSimulationObservation {
  link?: AuthorityObservation['link']
  battery?: AuthorityObservation['battery']
}
/** Isolated same-epoch inputs after actual supervisor qualification, before the next mission step. */
export interface MissionSimulationContext {
  nowMs: number
  estimate: EstimatorSnapshot
  sensors: SensorSnapshot
  mission: MissionSnapshot
  authority: AuthorityState
  battery: AuthorityObservation['battery']
  link: AuthorityObservation['link']
}
/** Simulation instrumentation keeps model rendering separate from estimated collection decisions. */
export interface MissionSimulationInstrument {
  observation?(nowMs: number): MissionSimulationObservation
  disturbance?(nowMs: number): { windMps?: SensorVector, forceN?: SensorVector, torqueNm?: SensorVector }
  dropSensors?(nowMs: number): { imu?: boolean, position?: boolean }
  render(state: RigidBodyState, nowMs: number): void
  observe(context: MissionSimulationContext): 'abort' | undefined
}

function plainData(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && keys.includes(key) && 'value' in descriptors[key]! && descriptors[key]!.enumerable)
}

function synchronousResult<T>(value: T): T {
  if (value instanceof Promise) {
    // Consume a genuine rejected promise without allowing a late callback to continue the owned loop.
    Promise.prototype.then.call(value, () => {}, () => {})
    throw new TypeError('Mission simulation callbacks must be synchronous')
  }
  return value
}

function qualifiedObservation(value: unknown, nowMs: number, nominalBattery: number, previous: MissionSimulationObservation): MissionSimulationObservation {
  if (!plainData(value, ['link', 'battery'])) throw new TypeError('Invalid mission instrument observation')
  const result: MissionSimulationObservation = {}
  for (const kind of ['link', 'battery'] as const) {
    if (!Object.hasOwn(value, kind)) continue
    const sample = value[kind], field = kind === 'link' ? 'connected' : 'remainingPercent'
    if (!plainData(sample, ['capturedAtMs', field]) || Object.keys(sample).length !== 2 || !Number.isSafeInteger(sample.capturedAtMs) || (sample.capturedAtMs as number) < 0 || (sample.capturedAtMs as number) > nowMs || nowMs - (sample.capturedAtMs as number) > (kind === 'link' ? authorityPolicy.linkAgeMs : authorityPolicy.batteryAgeMs)) throw new TypeError('Invalid mission instrument clock')
    if (kind === 'link' ? typeof sample.connected !== 'boolean' : !Number.isFinite(sample.remainingPercent) || (sample.remainingPercent as number) < 0 || (sample.remainingPercent as number) > nominalBattery) throw new TypeError('Invalid mission instrument resource')
    const prior = previous[kind]
    if (prior && ((sample.capturedAtMs as number) < prior.capturedAtMs || (sample.capturedAtMs === prior.capturedAtMs && sample[field] !== (prior as unknown as Record<string, unknown>)[field]))) throw new TypeError('Replayed mission instrument observation')
    if (kind === 'link') result.link = { capturedAtMs: sample.capturedAtMs as number, connected: sample.connected as boolean }
    else result.battery = { capturedAtMs: sample.capturedAtMs as number, remainingPercent: sample.remainingPercent as number }
  }
  return result
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
  let previousObservation: MissionSimulationObservation = {}
  const transitions: { atMs: number, taskId: string, state: string, reason: string }[] = []
  const path: { atMs: number, estimatedPositionM: number[] | null, truthPositionM: number[], targetM: number[] | null, state: string, taskId: string }[] = []
  const triggers: { atMs: number, taskId: string, channel: string, evidence: 'simulated-event' }[] = []
  try { for (let nowMs = 0; nowMs <= seconds * 1000; nowMs += 4) {
    command = board.tick(nowMs).motorsN
    if (nowMs > 600) truth = body.step(command, 0.004, options.instrument?.disturbance?.(nowMs))
    const dropped = options.instrument?.dropSensors?.(nowMs)
    feed.capture(truth, nowMs, dropped?.imu, dropped?.position)
    sensors = feed.advanceTo(nowMs)
    estimate = estimator.update(sensors)
    if (nowMs < 600 || nowMs % 20 !== 0) continue
    const nominalBattery = scenario === 'reserve' && nowMs >= 5000 ? 29 : (scenario === 'branch-return' ? 75 : 100) - plan.power.hoverW * Math.max(0, nowMs - 600) / 3600000 / plan.power.availableWh * 100
    let supplied: MissionSimulationObservation = {}, instrumentInvalid = false
    try {
      const provider = options.instrument?.observation
      const update = provider === undefined ? {} : qualifiedObservation(synchronousResult(provider(nowMs)), nowMs, nominalBattery, previousObservation)
      // Omission or withdrawal is not a new measurement and cannot restore a resource or refresh its age.
      supplied = qualifiedObservation({ ...previousObservation, ...update }, nowMs, 100, previousObservation)
      previousObservation = supplied
    }
    catch { instrumentInvalid = true }
    const batteryPercent = instrumentInvalid ? 0 : Math.min(supplied.battery?.remainingPercent ?? nominalBattery, nominalBattery)
    const runtime = board.snapshot()
    const observation = {
      kind: 'simulation' as const, nowMs, estimate,
      runtime: { bootId: runtime.bootId, capturedAtMs: nowMs, watchdogHealthy: runtime.fault === null },
      rc: { capturedAtMs: nowMs, connected: true, armSwitch: true, override: scenario === 'rc-override' && nowMs >= 5000 },
      interlocks: { capturedAtMs: nowMs, killActive: false, onGround: nowMs === 600 || truth.groundContact, motorsStopped: truth.motorsN.every(n => n < 0.01) },
      battery: { capturedAtMs: supplied.battery?.capturedAtMs ?? nowMs, remainingPercent: batteryPercent }, link: instrumentInvalid ? { capturedAtMs: nowMs, connected: false } : supplied.link ?? { capturedAtMs: nowMs, connected: true },
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
    let instrumentAbort = instrumentInvalid
    if (options.instrument) {
      try {
        if (synchronousResult(options.instrument.render(structuredClone(truth), nowMs)) !== undefined) throw new TypeError('Invalid mission render callback result')
        const result = synchronousResult(options.instrument.observe(structuredClone({ nowMs, estimate, sensors, mission, authority: supervisor.snapshot().state, battery: observation.battery, link: observation.link })))
        if (result !== undefined) instrumentAbort = true
      }
      catch { instrumentAbort = true }
    }
    if (scenario === 'pause-resume' && nowMs === 5000) action = 'pause'
    if ((scenario === 'pause-resume' || scenario === 'recovery') && nowMs === 7000) action = 'resume'
    if (scenario === 'abort' && nowMs === 5000) action = 'abort'
    if (instrumentAbort) action = 'abort'
    if (scenario === 'recovery' && nowMs === 5000 && !instrumentAbort) {
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
