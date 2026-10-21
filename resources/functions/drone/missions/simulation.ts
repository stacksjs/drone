import { types as nodeTypes } from 'node:util'
import type { SensorVector, ImuMeasurement } from '../sensors/types'
import type { Motors } from '../controls/model'
import type { MissionAction, MissionSnapshot, MissionEngine, TaskMotionMissionEngine, TaskMotionMissionSnapshot, TaskMotionMissionTrace, TaskMotionMissionDeclaration } from './engine'
import type { MissionPlan, TaskMotionMissionPlan } from './plan'
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
import { createMissionEngine, createTaskMotionMissionEngine, observeMission, recoverMission } from './engine'
import { exampleMission, validateMission, validateTaskMotionMission } from './plan'
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

export interface TaskMotionMissionSimulationContext {
  nowMs: number
  estimate: EstimatorSnapshot
  sensors: SensorSnapshot
  mission: TaskMotionMissionSnapshot
  authority: AuthorityState
  battery: AuthorityObservation['battery']
  link: AuthorityObservation['link']
}
export interface TaskMotionMissionSimulationInstrument {
  render(state: RigidBodyState, nowMs: number): void
  observe(context: TaskMotionMissionSimulationContext): 'abort' | TaskMotionMissionDeclaration | null | undefined
  observation?(nowMs: number): MissionSimulationObservation
}
type SimulationBudget = { worstCaseMs: number, requiredWh: number }
type Transition = { atMs: number, taskId: string, state: string, reason: string }
type Trigger = { atMs: number, taskId: string, channel: string, evidence: 'simulated-event' }
type SimulationPath = { atMs: number, estimatedPositionM: number[] | null, truthPositionM: number[], targetM: number[] | null, state: string, taskId: string }
type AuthoritySnapshot = ReturnType<ReturnType<typeof createAuthoritySupervisor>['snapshot']>
type BoardSnapshot = ReturnType<ReturnType<typeof createSimulatedOutputWatchdog>['snapshot']>
interface LegacySimulationRun {
  evidence: 'owned-mission-physics-simulation'
  physicalFlightEnabled: boolean
  boardOutputsInhibited: boolean
  scenario: MissionScenario
  recovered: boolean
  mission: MissionSnapshot
  budget: SimulationBudget
  transitions: Transition[]
  triggers: Trigger[]
  path: SimulationPath[]
  trace: ReturnType<MissionEngine['trace']>
  authority: AuthoritySnapshot
  board: BoardSnapshot
  finalTruthPositionM: SensorVector
}
export interface TaskMotionMissionSimulationRun {
  version: 4
  evidence: 'owned-task-motion-mission-physics-simulation'
  physicalFlightEnabled: false
  boardOutputsInhibited: true
  mission: TaskMotionMissionSnapshot
  budget: SimulationBudget
  transitions: Transition[]
  triggers: Trigger[]
  path: { atMs: number, estimatedPositionM: SensorVector | null, truthPositionM: SensorVector, targetM: SensorVector | null, state: string, taskId: string }[]
  trace: TaskMotionMissionTrace
  authority: AuthoritySnapshot
  board: BoardSnapshot
  finalTruthPositionM: SensorVector
}
interface CapturedTaskMotionInstrument {
  render(state: RigidBodyState, nowMs: number): unknown
  observe(context: TaskMotionMissionSimulationContext): unknown
  observation?: (nowMs: number) => unknown
}
type WorldArm = { kind: 'legacy', engine: MissionEngine, mission: MissionSnapshot, scenario: MissionScenario, recovered: boolean, options: { instrument?: MissionSimulationInstrument } } | { kind: 'task-motion', engine: TaskMotionMissionEngine, mission: TaskMotionMissionSnapshot, instrument: CapturedTaskMotionInstrument | undefined }
type WorldResult = { kind: 'legacy', run: LegacySimulationRun } | { kind: 'task-motion', run: TaskMotionMissionSimulationRun }
const intrinsicThen = Promise.prototype.then
function taskMotionUnavailable(): never { throw new RangeError('task-motion-mission-simulation-unavailable') }
function vector(values: number[]): SensorVector {
  if (values.length !== 3 || values.some(v => !Number.isFinite(v))) taskMotionUnavailable()
  return [values[0]!, values[1]!, values[2]!]
}
function taskMotionSynchronous(value: unknown): unknown {
  // Initial classification never reads a caller's then/prototype or unwraps a proxy.
  if (!nodeTypes.isProxy(value) && nodeTypes.isPromise(value)) {
    try { intrinsicThen.call(value, () => {}, () => {}) } catch { /* Producer effects are not an owned-loop continuation. */ }
    throw new TypeError('Asynchronous readiness instrument')
  }
  return value
}
function ownData(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError()
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
  if (keys.some(k => typeof k !== 'string' || !allowed.includes(k)) || required.some(k => !Object.hasOwn(descriptors, k))) throw new TypeError()
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (typeof key !== 'string') throw new TypeError()
    const d = descriptors[key]!
    if (!d.enumerable || !Object.hasOwn(d, 'value')) throw new TypeError()
    out[key] = d.value
  }
  return out
}
function captureTaskMotionObservation(value: unknown): MissionSimulationObservation {
  const data = ownData(value, ['link', 'battery'], [])
  const out: MissionSimulationObservation = {}
  if (Object.hasOwn(data, 'link')) {
    const link = ownData(data.link, ['capturedAtMs', 'connected'], ['capturedAtMs', 'connected'])
    if (typeof link.capturedAtMs !== 'number' || typeof link.connected !== 'boolean') throw new TypeError()
    out.link = { capturedAtMs: link.capturedAtMs, connected: link.connected }
  }
  if (Object.hasOwn(data, 'battery')) {
    const battery = ownData(data.battery, ['capturedAtMs', 'remainingPercent'], ['capturedAtMs', 'remainingPercent'])
    if (typeof battery.capturedAtMs !== 'number' || typeof battery.remainingPercent !== 'number') throw new TypeError()
    out.battery = { capturedAtMs: battery.capturedAtMs, remainingPercent: battery.remainingPercent }
  }
  return out
}
/** Concrete native-v4 execution on the same owned body/feed/estimator/control loop as v1. */
export function simulateTaskMotionMission(options: { plan: unknown, seconds?: number, instrument?: TaskMotionMissionSimulationInstrument }): TaskMotionMissionSimulationRun {
  let plan: TaskMotionMissionPlan, budget: SimulationBudget, seconds: number, instrument: CapturedTaskMotionInstrument | undefined
  try {
    const d = ownData(options, ['plan', 'seconds', 'instrument'], ['plan'])
    seconds = Object.hasOwn(d, 'seconds') ? (typeof d.seconds === 'number' ? d.seconds : NaN) : 45
    if (!Number.isInteger(seconds) || seconds < 8 || seconds > 45) throw new TypeError()
    const validated = validateTaskMotionMission(d.plan)
    plan = validated.plan; budget = { worstCaseMs: validated.worstCaseMs, requiredWh: validated.requiredWh }
    assertMissionSimulationOrigin(plan.origin)
    if (Object.hasOwn(d, 'instrument')) {
      const callbacks = ownData(d.instrument, ['render', 'observe', 'observation'], ['render', 'observe'])
      const render = callbacks.render, observe = callbacks.observe, observation = callbacks.observation
      if (typeof render !== 'function' || nodeTypes.isProxy(render) || typeof observe !== 'function' || nodeTypes.isProxy(observe) || Object.hasOwn(callbacks, 'observation') && (typeof observation !== 'function' || nodeTypes.isProxy(observation))) throw new TypeError()
      instrument = { render: (state, n) => Reflect.apply(render, undefined, [state, n]), observe: context => Reflect.apply(observe, undefined, [context]), ...(typeof observation === 'function' ? { observation: (n: number) => Reflect.apply(observation, undefined, [n]) } : {}) }
    }
  }
  catch { throw new TypeError('task-motion-mission-simulation-input') }
  try {
    const engine = createTaskMotionMissionEngine(plan)
    const result = runWorld(plan, budget, seconds, { kind: 'task-motion', engine, mission: engine.snapshot(), instrument })
    if (result.kind !== 'task-motion') taskMotionUnavailable()
    return result.run
  }
  catch { taskMotionUnavailable() }
}

/** The raw sensor fixture has one geodetic world, including for preflight callers. */
export function assertMissionSimulationOrigin(origin: MissionPlan['origin']): void {
  if (origin.latitudeDeg !== 0 || origin.longitudeDeg !== 0 || origin.ellipsoidHeightM !== 100) throw new TypeError('Physics fixture requires origin 0,0,100 WGS84 ellipsoid')
}

/** Actual owned raw-sensor/estimator/control pipeline, with a separately ticking modeled board. */
export function simulateMission(options: { plan?: unknown, scenario?: MissionScenario, seconds?: number, instrument?: MissionSimulationInstrument } = {}): LegacySimulationRun {
  const scenario = options.scenario ?? 'nominal'
  const seconds = options.seconds ?? 45
  if (!missionScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 120) throw new RangeError('Invalid mission scenario or duration (8..120 seconds)')
  const { plan, worstCaseMs, requiredWh } = validateMission(options.plan ?? exampleMission())
  // The sensor fixture has this geodetic world origin. Other plans remain valid for policy replay only.
  assertMissionSimulationOrigin(plan.origin)
  const engine = createMissionEngine(plan)
  const result = runWorld(plan, { worstCaseMs, requiredWh }, seconds, { kind: 'legacy', engine, mission: engine.snapshot(), scenario, recovered: false, options })
  if (result.kind !== 'legacy') throw new TypeError('Invalid mission simulation projection')
  return result.run
}

function runWorld(plan: MissionPlan | TaskMotionMissionPlan, budget: { worstCaseMs: number, requiredWh: number }, seconds: number, arm: WorldArm): WorldResult {
  const scenario = arm.kind === 'legacy' ? arm.scenario : 'nominal'
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
  let lastTask = ''
  let lastState = ''
  let previousObservation: MissionSimulationObservation = {}
  const transitions: { atMs: number, taskId: string, state: string, reason: string }[] = []
  const path: { atMs: number, estimatedPositionM: number[] | null, truthPositionM: number[], targetM: number[] | null, state: string, taskId: string }[] = []
  const triggers: { atMs: number, taskId: string, channel: string, evidence: 'simulated-event' }[] = []
  try { for (let nowMs = 0; nowMs <= seconds * 1000; nowMs += 4) {
    command = board.tick(nowMs).motorsN
    if (nowMs > 600) truth = body.step(command, 0.004, arm.kind === 'legacy' ? arm.options.instrument?.disturbance?.(nowMs) : undefined)
    const dropped = arm.kind === 'legacy' ? arm.options.instrument?.dropSensors?.(nowMs) : undefined
    feed.capture(truth, nowMs, dropped?.imu, dropped?.position)
    sensors = feed.advanceTo(nowMs)
    estimate = estimator.update(sensors)
    if (nowMs < 600 || nowMs % 20 !== 0) continue
    const nominalBattery = scenario === 'reserve' && nowMs >= 5000 ? 29 : (scenario === 'branch-return' ? 75 : 100) - plan.power.hoverW * Math.max(0, nowMs - 600) / 3600000 / plan.power.availableWh * 100
    let supplied: MissionSimulationObservation = {}, instrumentInvalid = false
    try {
      const provider = arm.kind === 'legacy' ? arm.options.instrument?.observation : arm.instrument?.observation
      const update = provider === undefined ? {} : qualifiedObservation(arm.kind === 'legacy' ? synchronousResult(provider(nowMs)) : captureTaskMotionObservation(taskMotionSynchronous(provider(nowMs))), nowMs, nominalBattery, previousObservation)
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
    const send = (action: 'arm' | 'engage' | 'renew' | 'disarm', targetM = arm.mission.targetM) => {
      const s = supervisor.snapshot()
      return supervisor.update(observation, { version: 1, sessionId: s.sessionId, bootId: s.bootId, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: nowMs, action, mode: 'position', leaseMs: 100, target: { positionM: targetM ?? [0, 0, 0], yawRad: 0 } })
    }
    supervisor.update(observation)
    // This fixture is an explicit operator script. The mission engine never arms itself.
    if (nowMs === 600) { send('arm'); send('engage', [0, 0, 0]) }
    const missionInput = observeMission({ estimate, authority: supervisor.snapshot().state, batteryPercent, onGround: observation.interlocks.onGround })
    let instrumentAbort = instrumentInvalid
    if (arm.kind === 'legacy') {
      let action: MissionAction | undefined = nowMs === 600 ? 'start' : undefined
      if (arm.options.instrument) {
        try {
          if (synchronousResult(arm.options.instrument.render(structuredClone(truth), nowMs)) !== undefined) throw new TypeError('Invalid mission render callback result')
          const result = synchronousResult(arm.options.instrument.observe(structuredClone({ nowMs, estimate, sensors, mission: arm.mission, authority: supervisor.snapshot().state, battery: observation.battery, link: observation.link })))
          if (result !== undefined) instrumentAbort = true
        }
        catch { instrumentAbort = true }
      }
      if (scenario === 'pause-resume' && nowMs === 5000) action = 'pause'
      if ((scenario === 'pause-resume' || scenario === 'recovery') && nowMs === 7000) action = 'resume'
      if (scenario === 'abort' && nowMs === 5000) action = 'abort'
      if (instrumentAbort) action = 'abort'
      if (scenario === 'recovery' && nowMs === 5000 && !instrumentAbort) {
        arm.engine = recoverMission(JSON.parse(JSON.stringify(arm.engine.trace())), missionInput)
        arm.mission = arm.engine.snapshot(); arm.recovered = true
      }
      else arm.mission = arm.engine.step(missionInput, action)
    }
    else {
      let readiness: unknown = null
      if (arm.instrument) {
        try {
          if (taskMotionSynchronous(arm.instrument.render(structuredClone(truth), nowMs)) !== undefined) throw new TypeError('Invalid readiness render result')
          const result = taskMotionSynchronous(arm.instrument.observe(structuredClone({ nowMs, estimate, sensors, mission: arm.mission, authority: supervisor.snapshot().state, battery: observation.battery, link: observation.link })))
          if (result === 'abort') instrumentAbort = true
          else readiness = result
        }
        catch { instrumentAbort = true }
      }
      arm.mission = arm.engine.step(missionInput, instrumentAbort ? 'abort' : nowMs === 600 ? 'start' : undefined, instrumentAbort ? null : readiness)
    }
    const mission = arm.mission
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
  if (arm.kind === 'legacy') return { kind: 'legacy', run: { evidence: 'owned-mission-physics-simulation', physicalFlightEnabled: false, boardOutputsInhibited: true, scenario, recovered: arm.recovered, mission: arm.mission, budget, transitions, triggers, path, trace: arm.engine.trace(), authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: truth.positionM } }
  if (transitions.length > 2221 || triggers.length > 32 || path.length > 224) taskMotionUnavailable()
  return { kind: 'task-motion', run: { version: 4, evidence: 'owned-task-motion-mission-physics-simulation', physicalFlightEnabled: false, boardOutputsInhibited: true, mission: arm.mission, budget, transitions, triggers, path: path.map(row => ({ ...row, estimatedPositionM: row.estimatedPositionM ? vector(row.estimatedPositionM) : null, truthPositionM: vector(row.truthPositionM), targetM: row.targetM ? vector(row.targetM) : null })), trace: arm.engine.trace(), authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: vector(truth.positionM) } }
}
