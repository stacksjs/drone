import type { CameraFrame, ImageBox } from '../camera/types'
import type { ImuMeasurement, SensorVector } from '../sensors/types'
import type { Motors } from '../controls/model'
import type { RigidBodyState } from '../controls/physics'
import type { VisionCameraEpoch, VisionCapturePose, VisionDepthObservation, VisionMetricObservation, VisionTargetFix } from './types'
import type { NavigationMap } from '../navigation/perception'
import { createVisualTracker } from '../camera/tracker'
import { createPhysicsSensorFeed } from '../controls/sensors'
import { createRigidBody, rotateNedToBody } from '../controls/physics'
import { createEstimator } from '../estimation/estimator'
import { geodeticToNed, quaternionEuler } from '../estimation/frames'
import { predictVehicleMeasurementPose, vehicleReference } from '../vehicles/measurements'
import { createAuthoritySupervisor } from '../authority/supervisor'
import { createSimulatedOutputWatchdog } from '../authority/watchdog'
import { createSimulatedMultirotorController } from '../controls/controller'
import { observeMission } from '../missions/engine'
import { createNavigationSensorFeed } from '../navigation/sensors'
import { detectNavigationMap } from '../navigation/perception'
import { navigationGoal } from '../navigation/navigator'
import { createVisionLocalizer } from './geometry'
import { exampleVisionCalibration, exampleVisionValidation } from './fixtures'
import { createVisionTargetFusion } from './fusion'

export const visionScenarios = ['follow', 'crossing', 'occlusion', 'camera-loss', 'depth-loss', 'identity-drift', 'target-loss', 'pose-reset', 'rc-override'] as const
export type VisionScenario = typeof visionScenarios[number]
export interface VisionSimulationRow {
  nowMs: number
  state: 'initializing' | 'hovering' | 'following' | 'blocked' | 'released'
  reason: string
  selectedLockId: string | null
  frameSequence: number | null
  positionM: SensorVector | null
  targetM: SensorVector | null
  visionM: SensorVector | null
  fusedM: SensorVector | null
  sigmaM: number | null
  targetTruthM: SensorVector
  errorM: number | null
  outputNeutral: boolean
}

/** Independent forward renderer. Plant truth stops at synthetic measurement generation and evaluation. */
function renderTarget(truth: RigidBodyState, point: SensorVector): { box: ImageBox, pixel: [number, number], depthM: number } | null {
  const body = rotateNedToBody(truth.quaternionWxyz, point.map((n, i) => n - truth.positionM[i]!) as SensorVector)
  // Independently stated hardware fixture: camera 8 cm forward, optical RDF -> body FRD [z,x,y].
  const z = body[0] - 0.08, x = body[1] / z, y = body[2] / z
  if (z < 2 || z > 12) return null
  const radial = 1 + 0.04 * (x * x + y * y)
  const pixel: [number, number] = [320 + 400 * x * radial, 240 + 400 * y * radial]
  const width = 0.12, height = 0.2, cx = pixel[0] / 640, cy = pixel[1] / 480
  if (cx < width / 2 || cx > 1 - width / 2 || cy < height / 2 || cy > 1 - height / 2) return null
  return { box: { x: cx - width / 2, y: cy - height / 2, width, height }, pixel, depthM: z }
}

/** Independent selected GNSS receiver model with wire-like degree/height quantization. */
function targetGnssPosition(point: SensorVector, sequence: number): SensorVector {
  const latitudeDeg = Math.round(point[0] / 6335539.3272928195 * 180 / Math.PI * 1e7) / 1e7
  const longitudeDeg = Math.round(point[1] / 6378237 * 180 / Math.PI * 1e7) / 1e7
  const quantized = geodeticToNed({ latitudeDeg, longitudeDeg, ellipsoidHeightM: Math.round((100 - point[2]) * 1000) / 1000 }, { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 })
  return [quantized[0] + 0.01 + 0.012 * Math.sin(sequence * 0.7), quantized[1] - 0.008 + 0.01 * Math.cos(sequence * 0.9), quantized[2] + 0.005 * Math.sin(sequence * 0.5)]
}

/** Sensor/estimator, metric vision, explicit pairing, follow navigation, authority and rigid-body integration. */
export function simulateVision(options: { scenario?: VisionScenario, seconds?: number } = {}) {
  const scenario = options.scenario ?? 'follow', seconds = options.seconds ?? 20
  if (!visionScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 30) throw new RangeError('Invalid vision scenario or duration (8..30 seconds)')
  const calibration = exampleVisionCalibration(), localizer = createVisionLocalizer(calibration, exampleVisionValidation())
  const tracker = createVisualTracker({ maxAgeMs: 200 })
  const fusion = createVisionTargetFusion()
  const feed = createPhysicsSensorFeed(0), rangeFeed = createNavigationSensorFeed(40)
  const estimator = createEstimator({ origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, gravityCorrection: 'initialization-only' })
  const body = createRigidBody({ positionM: [0, 0, -0.1], groundDownM: -0.1 })
  const supervisor = createAuthoritySupervisor({ sessionId: 171n, bootId: 55n })
  const board = createSimulatedOutputWatchdog({ sessionId: 171n, bootId: 55n })
  const controller = createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
  const sessionId = 'vision-simulation-camera', targetId = 'selected-person'
  type Packet = { frame: CameraFrame, camera: VisionCameraEpoch, depth: VisionDepthObservation | null, pose: VisionCapturePose, fix: VisionTargetFix | null, targetTruthM: SensorVector }
  const queue: Packet[] = [], path: VisionSimulationRow[] = []
  let latest: Packet | null = null, metric: VisionMetricObservation | null = null
  let truth = body.snapshot(), estimate = estimator.snapshot(0), sensors = feed.advanceTo(0)
  let map: NavigationMap | null = null, rangeSequence = 0, cameraSequence = 0
  let commandedM: SensorVector = [0, 0, -1.2]
  let paired = false, blocked: string | null = null, selectedAtMs: number | null = null
  let followingStartedM: SensorVector | null = null, followEndM: SensorVector | null = null
  let maxTargetErrorM = 0, maxThreeSigmaRatio = 0, maxVisualErrorM = 0, maxVisualThreeSigmaRatio = 0, minSeparationM = Infinity, maxTrackingGapMs = 0
  let maxHeadingDriftRad = 0
  const targetAt = (atMs: number): SensorVector => [5 + 0.2 * atMs / 1000, 0, -1.2]
  for (let nowMs = 0; nowMs <= seconds * 1000; nowMs += 4) {
    // Restore the modeled inputs after two seconds. A good stream alone must never reauthorize motion.
    const faultActive = nowMs >= 10000 && nowMs < 12000
    const command: Motors = board.tick(nowMs).motorsN
    if (nowMs > 600) truth = body.step(command, 0.004)
    feed.capture(truth, nowMs)
    sensors = feed.advanceTo(nowMs)
    estimate = estimator.update(sensors)
    if (scenario === 'pose-reset' && nowMs === 10000) { estimate = estimator.reset(nowMs); metric = null }
    const imu = sensors.sensors.find(s => s.kind === 'imu')?.observation
    const capturePose = predictVehicleMeasurementPose(estimate, imu, nowMs)
    if (capturePose && nowMs % 100 === 0) {
      const positionSigmaM = Math.sqrt(Math.max(...estimate.localPosition!.covarianceBlocks.map(b => b.positionM2)))
      const pose: VisionCapturePose = { evidence: 'synthetic', reference: capturePose.reference, capturedAtMs: nowMs, positionM: [...capturePose.positionM], quaternionWxyz: [...capturePose.quaternionWxyz], positionSigmaM, attitudeSigmaRad: 0.005 + nowMs / 1000 * 0.001, clockUncertaintyMs: 1, headingAlignment: 'initial-simulation-north' }
      const headingDelta = quaternionEuler(capturePose.quaternionWxyz)[2] - quaternionEuler(truth.quaternionWxyz)[2]
      const headingDifference = Math.abs(Math.atan2(Math.sin(headingDelta), Math.cos(headingDelta)))
      maxHeadingDriftRad = Math.max(maxHeadingDriftRad, headingDifference)
      rangeFeed.capture(nowMs, truth, { reference: pose.reference, atMs: nowMs, positionM: [...pose.positionM], quaternionWxyz: [...pose.quaternionWxyz], positionSigmaM }, { obstacles: [], groundNorthSlope: 0, landingM: [0, 0, 0] })
      if (!(scenario === 'camera-loss' && faultActive)) {
        const sequence = ++cameraSequence, targetTruthM = targetAt(nowMs), rendered = renderTarget(truth, targetTruthM)
        const detections: CameraFrame['detections'] = rendered && !(scenario === 'occlusion' && faultActive) ? [{ label: 'person', confidence: 0.99, box: rendered.box }] : []
        if (scenario === 'crossing' && faultActive && rendered) detections.push({ label: 'person', confidence: 0.99, box: { ...rendered.box, x: rendered.box.x + 0.01 } })
        const frame: CameraFrame = { sequence, capturedAtMs: nowMs, receivedAtMs: nowMs + 40, detections }
        const camera: VisionCameraEpoch = { cameraId: calibration.cameraId, sessionId, modeId: calibration.modeId, frameSequence: sequence, capturedAtMs: nowMs, receivedAtMs: nowMs + 40 }
        const depth: VisionDepthObservation | null = !rendered || scenario === 'depth-loss' && faultActive ? null : { evidence: 'synthetic', sourceId: 'registered-depth', sequence, calibrationId: calibration.id, cameraSessionId: sessionId, frameSequence: sequence, candidateId: `${sequence}:0`, capturedAtMs: nowMs, receivedAtMs: nowMs + 40, pixel: rendered.pixel, opticalDepthM: rendered.depthM + (scenario === 'identity-drift' && faultActive ? 2 : 0), sigmaM: 0.03, clockUncertaintyMs: 1 }
        const fix: VisionTargetFix | null = scenario === 'target-loss' && faultActive ? null : { evidence: 'synthetic', sourceId: 'chosen-gnss', sessionId: 'chosen-gnss-session', targetId, reference: pose.reference, sequence, capturedAtMs: nowMs, receivedAtMs: nowMs + 40, positionM: targetGnssPosition(targetTruthM, sequence), sigmaM: 0.04 }
        queue.push({ frame, camera, depth, pose, fix, targetTruthM })
      }
    }
    while (queue[0] && queue[0].frame.receivedAtMs <= nowMs) {
      latest = queue.shift()!
      tracker.update(latest.frame, nowMs)
      // This fixed operator script chooses one shown detection once. Loss never selects a replacement.
      if (nowMs === 3040 && tracker.snapshot(nowMs).candidates[0]) {
        tracker.select(tracker.snapshot(nowMs).candidates[0]!.id, latest.frame.sequence, nowMs)
        selectedAtMs = nowMs
      }
      try { metric = localizer.localize({ nowMs, tracking: tracker.snapshot(nowMs), camera: latest.camera, depth: latest.depth, pose: latest.pose }) }
      catch { metric = null }
    }
    const range = rangeFeed.advanceTo(nowMs)
    if (range && range.packet.sequence !== rangeSequence) {
      rangeSequence = range.packet.sequence
      try { map = detectNavigationMap(range.packet, range.pose) }
      catch { map = null }
    }
    if (nowMs < 600 || nowMs % 20 !== 0) continue
    if (scenario === 'rc-override' && nowMs === 10000) tracker.fail('RC override; select and pair again')
    const tracking = tracker.snapshot(nowMs)
    if (!paired && selectedAtMs !== null && tracking.confirmed && tracking.selected && metric) {
      fusion.pair({ cameraSessionId: sessionId, lockId: tracking.selected.id, calibrationId: calibration.id, depthSourceId: 'registered-depth', targetSourceId: 'chosen-gnss', targetSessionId: 'chosen-gnss-session', targetId, reference: metric.reference, visualToTargetOffsetM: [0, 0, 0], offsetSigmaM: 0.02 }, tracking, nowMs)
      paired = true
    }
    const fused = fusion.step({ nowMs, tracking, vision: metric, fix: latest?.fix ?? null })
    if (paired && fused.state === 'lost') blocked ??= fused.reason
    if (paired && !capturePose) blocked ??= 'capture-pose-unqualified'
    if (scenario === 'rc-override' && nowMs >= 10000) blocked ??= 'rc-override'
    if (fused.target) {
      const sourceTruth = latest?.targetTruthM ?? targetAt(fused.target.capturedAtMs)
      const errorM = Math.hypot(...fused.target.positionM.map((n, i) => n - sourceTruth[i]!))
      maxTargetErrorM = Math.max(maxTargetErrorM, errorM)
      maxThreeSigmaRatio = Math.max(maxThreeSigmaRatio, errorM / (3 * fused.target.sigmaM))
      maxTrackingGapMs = Math.max(maxTrackingGapMs, nowMs - fused.target.capturedAtMs)
    }
    if (metric && latest) {
      const targetTruthM = latest.targetTruthM
      const errorM = Math.hypot(...metric.positionM.map((n, i) => n - targetTruthM[i]!))
      maxVisualErrorM = Math.max(maxVisualErrorM, errorM)
      maxVisualThreeSigmaRatio = Math.max(maxVisualThreeSigmaRatio, errorM / (3 * metric.sigmaM))
    }
    minSeparationM = Math.min(minSeparationM, Math.hypot(...truth.positionM.map((n, i) => n - targetAt(nowMs)[i]!)))
    const runtime = board.snapshot()
    const observation = { kind: 'simulation' as const, nowMs, estimate, runtime: { bootId: runtime.bootId, capturedAtMs: nowMs, watchdogHealthy: runtime.fault === null }, rc: { capturedAtMs: nowMs, connected: true, armSwitch: true, override: scenario === 'rc-override' && faultActive }, interlocks: { capturedAtMs: nowMs, killActive: false, onGround: nowMs === 600 || truth.groundContact, motorsStopped: truth.motorsN.every(n => n < 0.01) }, battery: { capturedAtMs: nowMs, remainingPercent: 95 }, link: { capturedAtMs: nowMs, connected: true } }
    const send = (action: 'arm' | 'engage' | 'renew' | 'disarm') => {
      const s = supervisor.snapshot()
      return supervisor.update(observation, { version: 1, sessionId: s.sessionId, bootId: s.bootId, epoch: s.epoch, sequence: s.sequence + 1, issuedAtMs: nowMs, action, mode: 'position', leaseMs: 100, target: { positionM: commandedM, yawRad: 0 } })
    }
    supervisor.update(observation)
    if (nowMs === 600) { send('arm'); send('engage') }
    if (!blocked && fused.target) {
      const mission = observeMission({ estimate, authority: supervisor.snapshot().state, batteryPercent: 95, onGround: observation.interlocks.onGround })
      if (!mission.healthy || !map || map.reference !== vehicleReference(estimate) || nowMs - map.capturedAtMs > 200) blocked = 'follow-navigation-observation-lost'
      else {
        try { commandedM = navigationGoal({ mode: 'follow', targetId, offsetM: [-3, 0, 0], clearanceM: 1.2 }, mission, map, fused.target) }
        catch { blocked = 'selected-follow-target-unqualified' }
      }
      followingStartedM ??= [...truth.positionM]
      followEndM = [...truth.positionM]
    }
    const ended = nowMs === seconds * 1000
    if (blocked || ended) { send('disarm'); board.revoke() }
    else send('renew')
    if (!blocked && supervisor.snapshot().state !== 'autonomous' && !ended) blocked = `authority-${supervisor.snapshot().reason}`
    const measurement = imu?.value as ImuMeasurement | undefined
    const output = controller.step({ kind: 'simulation', enabled: !blocked && !ended && supervisor.snapshot().state === 'autonomous', nowMs, estimate, angularRateRadS: measurement?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: imu?.estimatedCaptureMs ?? -Infinity, target: { positionM: supervisor.snapshot().target?.positionM ?? [0, 0, 0], yawRad: 0, issuedAtMs: nowMs } })
    const frame = supervisor.gate(output, nowMs)
    if (frame) board.accept(frame, nowMs)
    else board.revoke()
    if (nowMs % 100 === 0 || ended) {
      const targetTruthM = latest?.targetTruthM ?? targetAt(nowMs)
      path.push({ nowMs, state: blocked ? 'blocked' : ended ? 'released' : fused.target ? 'following' : 'hovering', reason: blocked ?? (ended ? 'authored-follow-complete-outputs-released' : fused.reason), selectedLockId: tracking.selected?.id ?? null, frameSequence: tracking.sequence, positionM: estimate.localPosition ? [...estimate.localPosition.positionM] as SensorVector : null, targetM: blocked || ended ? null : [...commandedM], visionM: metric ? [...metric.positionM] : null, fusedM: fused.target ? [...fused.target.positionM] : null, sigmaM: fused.target?.sigmaM ?? null, targetTruthM: [...targetTruthM], errorM: fused.target ? Math.hypot(...fused.target.positionM.map((n, i) => n - targetTruthM[i]!)) : null, outputNeutral: board.snapshot().motorsN.every(n => n === 0) })
    }
  }
  if (!paired) blocked ??= 'operator-selection-or-qualified-metric-target-unavailable'
  if (scenario !== 'follow' && fusion.snapshot().state !== 'lost') blocked ??= 'authored-fault-not-observed'
  return { evidence: 'owned-vision-physics-simulation' as const, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, status: blocked ? 'blocked' as const : 'completed' as const, reason: blocked ?? 'authored-follow-complete-outputs-released', scenario, calibration: localizer.report, fusion: fusion.snapshot(), metrics: { maxTargetErrorM, maxThreeSigmaRatio, maxVisualErrorM, maxVisualThreeSigmaRatio, minSeparationM, followTravelM: followingStartedM && followEndM ? Math.hypot(...followEndM.map((n, i) => n - followingStartedM[i]!)) : 0, maxTrackingGapMs, maxHeadingDriftRad }, path, authority: supervisor.snapshot(), board: board.snapshot(), finalTruthPositionM: [...truth.positionM] as SensorVector }
}
