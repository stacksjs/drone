import type { MissionPlan, MissionTask } from '../missions/plan'
import type { SensorVector } from '../sensors/types'
import type { SurveyCapture, SurveyPlan, SurveyPose, SurveyRun } from './types'
import type { MissionSimulationInstrument } from '../missions/simulation'
import { simulateMission } from '../missions/simulation'
import { validateMission } from '../missions/plan'
import { rotateBodyToNed } from '../controls/physics'
import { nedToGeodetic } from '../estimation/frames'
import { predictVehicleMeasurementPose } from '../vehicles/measurements'
import { createSurveyPlan } from './planner'
import { projectSurveyFootprint } from './geometry'
import { exampleSurveyConfig } from './fixtures'
import { createSurveyCamera } from './camera'

export const surveyScenarios = ['nominal', 'crosshatch', 'terrain', 'camera-loss', 'wrong-ack', 'imu-loss', 'position-loss', 'rc-override', 'abort'] as const
export type SurveyScenario = typeof surveyScenarios[number]

/** Compile only what the existing owned quad mission can execute within its retained bounds. */
export function compileSurveyMission(input: SurveyPlan): MissionPlan {
  const plan = createSurveyPlan(input.config), config = plan.config
  if (JSON.stringify(plan) !== JSON.stringify(input)) throw new TypeError('Survey plan differs from validated configuration')
  const first = plan.lanes[0]!.fromM
  const timeout = (a: SensorVector, b: SensorVector) => Math.max(2500, Math.ceil((Math.hypot(...a.map((n, i) => n - b[i]!)) / config.speedMps + 2) * 1000))
  const tasks: MissionTask[] = [{ id: 'takeoff', kind: 'takeoff', positionM: [0, 0, first[2]], timeoutMs: 10000, next: `${plan.lanes[0]!.id}-start` }]
  let previous: SensorVector = [0, 0, first[2]]
  for (const [index, lane] of plan.lanes.entries()) {
    tasks.push({ id: `${lane.id}-start`, kind: 'waypoint', positionM: lane.fromM, timeoutMs: timeout(previous, lane.fromM), next: `${lane.id}-end` })
    tasks.push({ id: `${lane.id}-end`, kind: 'waypoint', positionM: lane.toM, timeoutMs: timeout(lane.fromM, lane.toM), next: index + 1 < plan.lanes.length ? `${plan.lanes[index + 1]!.id}-start` : 'return' })
    previous = lane.toM
  }
  const rallyM: SensorVector = [0, 0, first[2]]
  tasks.push({ id: 'return', kind: 'return', timeoutMs: timeout(previous, rallyM), next: 'land' }, { id: 'land', kind: 'land', positionM: [0, 0, 0], timeoutMs: 10000 })
  return validateMission({ version: 1, id: config.id, frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'FLAT_ORIGIN_PLANE', origin: config.origin, fence: { radiusM: 12, minDownM: -5 }, rallyM, power: config.power, speedMps: config.speedMps, start: 'takeoff', tasks }).plan
}

/** Owned raw sensor, estimator, mission and quad physics collection. Camera truth never supplies a geotag. */
export function simulateSurvey(options: { config?: unknown, scenario?: SurveyScenario, seconds?: number } = {}): SurveyRun {
  const scenario = options.scenario ?? 'nominal', seconds = options.seconds ?? 100
  if (!surveyScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 120) throw new RangeError('Invalid survey scenario or duration (8..120 seconds)')
  const config = options.config === undefined ? exampleSurveyConfig() : structuredClone(options.config)
  if (options.config === undefined && scenario === 'crosshatch') (config as ReturnType<typeof exampleSurveyConfig>).crosshatch = true
  if (options.config === undefined && scenario === 'terrain') (config as ReturnType<typeof exampleSurveyConfig>).terrain.gradient = [0.04, -0.03]
  const plan = createSurveyPlan(config), mission = compileSurveyMission(plan)
  if (plan.config.calibration.evidence !== 'synthetic' || plan.config.calibration.output.width * plan.config.calibration.output.height > 65536) throw new RangeError('Owned mapping fixture requires synthetic calibration and at most 65536 pixels')
  const camera = createSurveyCamera(plan, scenario === 'camera-loss' ? 'loss' : scenario === 'wrong-ack' ? 'wrong-ack' : 'none')
  const captures: SurveyCapture[] = []
  let pending: Omit<SurveyCapture, 'rgba' | 'acknowledgedAtMs'> | null = null
  let reason: string | null = null, sequence = 0, lastAt = -Infinity
  let lastLane = '', lastPosition: SensorVector | null = null, lastReference: string | null = null
  const fail = (message: string): 'abort' => { reason ??= message; pending = null; camera.close(); return 'abort' }
  const instrument: MissionSimulationInstrument = {
    dropSensors(nowMs) { return { imu: scenario === 'imu-loss' && nowMs >= 7000 && nowMs < 9000, position: scenario === 'position-loss' && nowMs >= 7000 && nowMs < 9000 } },
    render: camera.render,
    observe({ nowMs, estimate, sensors, mission: state, authority }) {
      if (reason) return 'abort'
      if (state.state !== 'running') return undefined
      if (authority !== 'autonomous') { reason = 'collection-authority-lost'; camera.close(); return undefined }
      try {
        if (pending) {
          const ack = camera.poll(nowMs)
          if (ack) {
            if (ack.sessionId !== pending.sessionId || ack.sequence !== pending.sequence || ack.reference !== pending.pose.reference || ack.issuedAtMs !== pending.issuedAtMs || ack.capturedAtMs !== pending.capturedAtMs || ack.acknowledgedAtMs > pending.issuedAtMs + 80 || ack.rgba.length !== pending.width * pending.height * 4) return fail('camera-ack-scope-or-timing')
            captures.push({ ...pending, rgba: ack.rgba, acknowledgedAtMs: ack.acknowledgedAtMs }); pending = null
          }
          else if (nowMs >= pending.issuedAtMs + 80) return fail('camera-ack-deadline')
        }
        const imu = sensors.sensors.find(sensor => sensor.kind === 'imu')?.observation
        const pose = predictVehicleMeasurementPose(estimate, imu, nowMs)
        if (!pose || (lastReference && lastReference !== pose.reference)) return fail('capture-pose-unqualified')
        lastReference = pose.reference
        const lane = plan.lanes.find(item => `${item.id}-end` === state.taskId)
        if (!lane || pending) return undefined
        const distance = lastPosition ? Math.hypot(...pose.positionM.map((n, i) => n - lastPosition![i]!)) : Infinity
        const interval = nowMs - lastAt
        if (lastLane === lane.id && distance < plan.captureSpacingM * 0.8) return undefined
        if (interval < plan.config.minTriggerIntervalMs) return undefined
        if (captures.length >= 256) return fail('capture-capacity')
        const { width, height } = plan.config.calibration.output
        const lever = rotateBodyToNed(pose.quaternionWxyz, plan.config.calibration.extrinsics.translationM)
        const cameraPositionM = pose.positionM.map((n, i) => n + lever[i]!) as SensorVector
        const p = estimate.localPosition!
        const surveyPose: SurveyPose = { capturedAtMs: nowMs, reference: pose.reference, positionM: pose.positionM, quaternionWxyz: pose.quaternionWxyz, cameraPositionM, geodetic: nedToGeodetic(cameraPositionM, plan.config.origin), positionSigmaM: Math.sqrt(Math.max(...p.covarianceBlocks.map(block => block.positionM2))) + plan.config.calibration.uncertainty.translationSigmaM + 0.001, attitudeSigmaRad: 0.003 + nowMs / 1000000, headingAlignment: 'initial-simulation-north', positionCapturedAtMs: pose.positionCapturedAtMs, attitudeCapturedAtMs: pose.attitudeCapturedAtMs, attitudePrediction: 'qualified-gyro-hold' }
        const id = `photo-${String(++sequence).padStart(4, '0')}`
        pending = { id, filename: `${id}.png`, laneId: lane.id, sessionId: 'mapping-session-1', sequence, issuedAtMs: nowMs, capturedAtMs: nowMs, exposureTimeUs: plan.config.exposureTimeUs, timestampReference: 'synthetic-exposure-midpoint', clockDomain: 'fixture-monotonic-ms', clockUncertaintyMs: plan.config.calibration.timing.clockUncertaintyMs, calibrationId: plan.config.calibration.id, pose: surveyPose, width, height, footprintM: projectSurveyFootprint(plan, pose.positionM, pose.quaternionWxyz), rtk: { status: 'unavailable', reason: 'Synthetic GNSS has no RTK correction solution' }, ppk: { status: 'unavailable', reason: 'No raw carrier-phase observations or base station' }, gcps: { status: 'unavailable', reason: 'No independently surveyed ground control observations' } }
        camera.request({ sessionId: pending.sessionId, sequence, issuedAtMs: nowMs, reference: pose.reference })
        lastAt = nowMs; lastLane = lane.id; lastPosition = [...pose.positionM]
      }
      catch { return fail('capture-render-or-pose-failed') }
      return undefined
    },
  }
  try {
    const run = simulateMission({ plan: mission, seconds, scenario: scenario === 'rc-override' ? 'rc-override' : scenario === 'abort' ? 'abort' : 'nominal', instrument })
    if (pending) reason ??= 'uncertain-pending-capture'
    const status = run.mission.state === 'completed' && !reason ? 'completed' : run.mission.state === 'blocked' ? 'blocked' : run.mission.state === 'aborted' ? 'aborted' : 'incomplete'
    return { version: 1, evidence: 'owned-mapping-physics-simulation', physicalFlightEnabled: false, collectionOnly: true, reconstructionPerformed: false, plan, mission, trace: run.trace, status, reason: reason ?? run.mission.reason, captures, boardNeutral: run.board.motorsN.every(n => n === 0), path: run.path.map(row => ({ atMs: row.atMs, positionM: row.estimatedPositionM as SensorVector | null, targetM: row.targetM as SensorVector | null, taskId: row.taskId, state: row.state })) }
  }
  finally { camera.close() }
}
