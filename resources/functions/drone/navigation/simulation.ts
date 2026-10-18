import type { ImuMeasurement } from '../sensors/types'
import type { Motors } from '../controls/model'
import type { MissionAction, MissionSnapshot } from '../missions/engine'
import type { NavigationDecision, NavigationIntent } from './navigator'
import type { NavigationMap, NavigationPose } from './perception'
import { detectNavigationMap } from './perception'
import { createNavigationSensorFeed } from './sensors'
import { createNavigator } from './navigator'
import { createAuthoritySupervisor } from '../authority/supervisor'
import { createSimulatedOutputWatchdog } from '../authority/watchdog'
import { createRigidBody } from '../controls/physics'
import { createPhysicsSensorFeed } from '../controls/sensors'
import { createEstimator } from '../estimation/estimator'
import { createSimulatedMultirotorController } from '../controls/controller'
import { createMissionEngine, observeMission } from '../missions/engine'
import { exampleMission, validateMission } from '../missions/plan'
export const navigationScenarios = ['avoid-land', 'replan', 'range-loss', 'range-delay', 'position-loss', 'landing-loss', 'rc-override'] as const
export type NavigationScenario = typeof navigationScenarios[number]
/** Actual owned raw-sensor/estimator/control pipeline, with a separately ticking modeled board. */
export function simulateNavigation(options: { scenario?: NavigationScenario, seconds?: number } = {}) {
  const scenario = options.scenario ?? 'avoid-land'
  const seconds = options.seconds ?? 70
  if (!navigationScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 120) throw new RangeError('Invalid navigation scenario or duration (8..120 seconds)')
  const missionPlan = exampleMission()
  missionPlan.tasks = [
    { id: 'takeoff', kind: 'takeoff', positionM: [0, 0, -1.2], timeoutMs: 12000, next: 'approach' },
    // Two authored legs budget the inflated obstacle detour and settling inside v1's
    // 20-second task limit, independently of which equal-cost side a platform selects.
    { id: 'approach', kind: 'waypoint', positionM: [2.5, -2.5, -1.275], timeoutMs: 20000, next: 'survey' },
    // Author the fixed-origin waypoint at the same height as the declared 1.2 m clearance
    // over the fixture's D=-0.03N plane. Acceptance must not chase a different altitude.
    { id: 'survey', kind: 'waypoint', positionM: [5, 0, -1.35], timeoutMs: 20000, next: 'return' },
    { id: 'return', kind: 'return', timeoutMs: 20000, next: 'land' },
    { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 12000 },
  ]
  missionPlan.rallyM = [0, 0, -1.2]
  const { plan, worstCaseMs, requiredWh } = validateMission(missionPlan)
  // The sensor fixture has this geodetic world origin. Other plans remain valid for policy replay only.
  if (plan.origin.latitudeDeg !== 0 || plan.origin.longitudeDeg !== 0 || plan.origin.ellipsoidHeightM !== 100) throw new TypeError('Physics fixture requires origin 0,0,100 WGS84 ellipsoid')
  const engine = createMissionEngine(plan)
  const supervisor = createAuthoritySupervisor({ sessionId: 123n, bootId: 55n })
  const board = createSimulatedOutputWatchdog({ sessionId: 123n, bootId: 55n })
  const body = createRigidBody({ positionM: [0, 0, -0.1], groundDownM: -0.1, groundGradient: [-0.03, 0] })
  const feed = createPhysicsSensorFeed(0)
  const rangeFeed = createNavigationSensorFeed(scenario === 'range-delay' ? 240 : 60)
  const navigator = createNavigator({ fenceRadiusM: plan.fence.radiusM, minDownM: plan.fence.minDownM })
  let rangeMap: NavigationMap | null = null
  let navigation: NavigationDecision = { state: 'released', reason: 'not-started', targetM: null, route: [], marginM: null, perceptionAgeMs: null, mode: 'route', replans: 0, physicalFlightEnabled: false }
  let lastRangeSequence = 0
  let minTruthClearanceM = Infinity
  let maxLatencyMs = 0
  let detectionFault = false
  const navTrace: { atMs: number, navigation: NavigationDecision, positionM: number[], truthPositionM: number[] }[] = []
  const estimator = createEstimator({ origin: plan.origin, gravityCorrection: 'initialization-only' })
  const controller = createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
  let truth = body.snapshot()
  let estimate = estimator.snapshot(0)
  let sensors = feed.advanceTo(0)
  let command: Motors = [0, 0, 0, 0]
  let mission: MissionSnapshot = engine.snapshot()
  let lastTask = ''
  let lastState = ''
  const transitions: { atMs: number, taskId: string, state: string, reason: string }[] = []
  const path: { atMs: number, estimatedPositionM: number[] | null, truthPositionM: number[], targetM: number[] | null, state: string, taskId: string }[] = []
  const triggers: { atMs: number, taskId: string, channel: string, evidence: 'simulated-event' }[] = []
  for (let nowMs = 0; nowMs <= seconds * 1000; nowMs += 4) {
    command = board.tick(nowMs).motorsN
    if (nowMs > 600) truth = body.step(command, 0.004)
    feed.capture(truth, nowMs, scenario === 'position-loss' && nowMs >= 6000)
    sensors = feed.advanceTo(nowMs)
    estimate = estimator.update(sensors)
    const obstacles = [{ id: 'post', northM: 2.5, eastM: 0, radiusM: 0.25 }, ...(scenario === 'replan' && nowMs >= 5000 ? [{ id: 'second-post', northM: 3.4, eastM: 2.5, radiusM: 0.25 }] : [])]
    for (const obstacle of obstacles) minTruthClearanceM = Math.min(minTruthClearanceM, Math.hypot(truth.positionM[0] - obstacle.northM, truth.positionM[1] - obstacle.eastM) - obstacle.radiusM - 0.3)
    if (estimate.localPosition && estimate.attitude && estimate.health.tilt && estimate.health.localPosition && !(scenario === 'range-loss' && nowMs >= 6000)) {
      const pose: NavigationPose = { reference: `${estimate.bootId}:${Object.values(estimate.resets).join(',')}`, atMs: nowMs, positionM: [...estimate.localPosition.positionM] as [number, number, number], quaternionWxyz: [...estimate.attitude.quaternionWxyz], positionSigmaM: 0.02 }
      rangeFeed.capture(nowMs, truth, pose, { obstacles, groundNorthSlope: -0.03, landingM: [0.1, 0.06, -0.003] }, scenario === 'landing-loss' && mission.taskId === 'land')
    }
    const packet = rangeFeed.advanceTo(nowMs)
    if (packet && packet.packet.sequence !== lastRangeSequence) {
      lastRangeSequence = packet.packet.sequence
      maxLatencyMs = Math.max(maxLatencyMs, packet.packet.receivedAtMs - packet.packet.capturedAtMs)
      try { rangeMap = detectNavigationMap(packet.packet, packet.pose); maxLatencyMs = Math.max(maxLatencyMs, rangeMap.latencyMs) }
      catch { rangeMap = null; detectionFault = true }
    }
    if (nowMs < 600 || nowMs % 20 !== 0) continue
    const batteryPercent = 100 - plan.power.hoverW * Math.max(0, nowMs - 600) / 3600000 / plan.power.availableWh * 100
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
    const action: MissionAction | undefined = nowMs === 600 ? 'start' : undefined
    mission = engine.step(missionInput, action)
    const task = plan.tasks.find(t => t.id === mission.taskId)!
    const goal = 'positionM' in task ? task.positionM : plan.rallyM
    const intent: NavigationIntent = task.kind === 'land' ? { mode: 'land', siteId: 'pad', expectedM: [0, 0, 0] } : { mode: task.kind === 'return' ? 'rtl' : 'route', goalM: goal, clearanceM: 1.2 }
    if (['running', 'paused'].includes(mission.state)) navigation = navigator.step(missionInput, rangeMap, intent)
    else navigation = { state: mission.state === 'completed' ? 'released' : 'blocked', reason: navigation?.state === 'blocked' ? navigation.reason : `mission-${mission.state}`, targetM: null, route: [], marginM: null, perceptionAgeMs: null, mode: intent.mode, replans: navigation?.replans ?? 0, physicalFlightEnabled: false }
    if (mission.payload) triggers.push({ atMs: nowMs, ...mission.payload, evidence: 'simulated-event' })
    if ((mission.state === 'running' || mission.state === 'paused') && navigation?.targetM) send('renew', navigation.targetM)
    else { send('disarm'); board.revoke() }
    const imuObservation = sensors.sensors.find(s => s.kind === 'imu')?.observation
    const measurement = imuObservation?.value as ImuMeasurement | undefined
    const output = controller.step({ kind: 'simulation', enabled: supervisor.snapshot().state === 'autonomous', nowMs, estimate, angularRateRadS: measurement?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: imuObservation?.estimatedCaptureMs ?? -Infinity, target: { positionM: supervisor.snapshot().target?.positionM ?? [0, 0, 0], yawRad: 0, issuedAtMs: nowMs } })
    const frame = supervisor.gate(output, nowMs)
    if (frame) board.accept(frame, nowMs)
    else board.revoke()
    if (navigation && (nowMs % 100 === 0 || navigation.state === 'blocked')) navTrace.push({ atMs: nowMs, navigation, positionM: [...missionInput.positionM], truthPositionM: [...truth.positionM] })
    if (mission.taskId !== lastTask || mission.state !== lastState) {
      transitions.push({ atMs: nowMs, taskId: mission.taskId, state: mission.state, reason: mission.reason })
      lastTask = mission.taskId; lastState = mission.state
    }
    if (nowMs % 200 === 0 || !['running', 'paused'].includes(mission.state)) path.push({ atMs: nowMs, estimatedPositionM: estimate.localPosition?.positionM ?? null, truthPositionM: [...truth.positionM], targetM: mission.targetM, state: mission.state, taskId: mission.taskId })
    if (!['running', 'paused'].includes(mission.state)) break
  }
  return { evidence: 'owned-navigation-physics-simulation' as const, physicalFlightEnabled: false, boardOutputsInhibited: true, scenario, mission, navigation, metrics: { minTruthClearanceM, maxLatencyMs, detectionFault, precisionLandingErrorM: Math.hypot(truth.positionM[0] - 0.1, truth.positionM[1] - 0.06) }, navTrace, budget: { worstCaseMs, requiredWh }, transitions, triggers, path, trace: engine.trace(), authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: truth.positionM }
}
