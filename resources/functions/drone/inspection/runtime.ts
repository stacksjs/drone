import type { InspectionAssetObservation, InspectionCapture, InspectionRangePacket, InspectionRun, InspectionScenario } from './types'
import type { SensorVector, ImuMeasurement } from '../sensors/types'
import type { VehicleMeasurementPose } from '../vehicles/types'
import type { MissionSimulationInstrument } from '../missions/simulation'
import { simulateMission } from '../missions/simulation'
import { rotateBodyToNed } from '../controls/physics'
import { predictVehicleMeasurementPose } from '../vehicles/measurements'
import { createModeledCamera } from '../payloads/modeled-camera'
import { createInspectionPlan } from './planner'
import { exampleInspectionConfig } from './fixtures'
import { renderInspectionImage, renderInspectionRange, inspectCaptureQuality } from './camera'

export const inspectionScenarios = ['nominal', 'wind', 'gnss-loss', 'structure-motion', 'camera-loss', 'wrong-ack', 'pause-resume', 'abort', 'rc-override'] as const
const distance = (a: SensorVector, b: SensorVector) => Math.hypot(...a.map((n, i) => n - b[i]!))
/** Capture decisions consume estimated poses and measured face points. Truth is confined to sensor renderers. */
export function simulateInspection(options: { config?: unknown, scenario?: InspectionScenario, seconds?: number, visitId?: string } = {}): InspectionRun {
  const scenario = options.scenario ?? 'nominal', seconds = options.seconds ?? 60, visitId = options.visitId ?? 'inspection-visit-1'
  if (!inspectionScenarios.includes(scenario) || !Number.isInteger(seconds) || seconds < 8 || seconds > 120 || !/^[a-z][a-z0-9-]{0,63}$/.test(visitId)) throw new RangeError('Invalid inspection scenario, visit or duration (8..120 seconds)')
  const plan = createInspectionPlan(options.config ?? exampleInspectionConfig()), config = plan.config
  if (config.calibration.evidence !== 'synthetic' || config.calibration.output.width * config.calibration.output.height > 65536 || config.calibration.timing.clockUncertaintyMs > 5) throw new RangeError('Owned inspection requires bounded synthetic calibration and at most 5 ms clock uncertainty')
  const camera = createModeledCamera((body, nowMs) => {
    const image = renderInspectionImage(plan, body, modeledCenter(nowMs))
    return { rgba: image.rgba, thermalCentiKelvin: image.thermalCentiKelvin }
  }, { fault: scenario === 'camera-loss' ? 'loss' : scenario === 'wrong-ack' ? 'wrong-ack' : 'none', faultAfterMs: 0 })
  const captures: InspectionCapture[] = []
  let pending: Omit<InspectionCapture, 'image' | 'quality' | 'acknowledgedAtMs'> | null = null
  let pendingMotion = { velocityMps: 0, angularRateRadS: 0 }
  let packet: InspectionRangePacket | null = null, rangeSequence = 0, sequence = 0
  let reason: string | null = null, reference: string | null = null, lastRangeSequence = 0
  let minimumObservedSeparationM: number | null = null
  const capturedStations = new Set<string>()
  function modeledCenter(nowMs: number): SensorVector {
    return scenario === 'structure-motion' && nowMs >= 10000 && nowMs < 12000 ? [config.asset.centerM[0] - 0.8, config.asset.centerM[1], config.asset.centerM[2]] : [...config.asset.centerM]
  }
  const fail = (message: string): 'abort' => { reason ??= message; pending = null; camera.close(); return 'abort' }
  function observeAsset(pose: VehicleMeasurementPose, positionSigmaM: number, attitudeSigmaRad: number, nowMs: number): InspectionAssetObservation {
    const p = packet
    if (!p || p.version !== 1 || p.evidence !== 'modeled-asset-range' || p.assetId !== config.asset.id || p.revision !== config.asset.revision || !Number.isSafeInteger(p.sequence) || p.sequence <= lastRangeSequence || p.capturedAtMs !== nowMs || p.receivedAtMs !== nowMs || !Number.isFinite(p.rangeSigmaM) || p.rangeSigmaM <= 0 || p.rangeSigmaM > 0.05 || !Number.isFinite(p.clockUncertaintyMs) || p.clockUncertaintyMs < 0 || p.clockUncertaintyMs > 5 || p.pointsBodyM.length !== 3 || p.pointsBodyM.some(point => point.length !== 3 || point.some(n => !Number.isFinite(n)))) throw new RangeError('Unqualified asset range packet')
    lastRangeSequence = p.sequence
    const points = p.pointsBodyM.map(point => rotateBodyToNed(pose.quaternionWxyz, point).map((n, i) => n + pose.positionM[i]!) as SensorVector)
    const [bl, br, tl] = points as [SensorVector, SensorVector, SensorVector]
    const u = br.map((n, i) => n - bl[i]!) as SensorVector, v = tl.map((n, i) => n - bl[i]!) as SensorVector
    const cross: SensorVector = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const norm = Math.hypot(...cross), normal = cross.map(n => n / norm) as SensorVector
    if (!Number.isFinite(norm) || norm < 0.01 || Math.abs(Math.hypot(...u) - config.asset.widthM) > 0.04 || Math.abs(Math.hypot(...v) - config.asset.heightM) > 0.04 || Math.abs(u.reduce((n, x, i) => n + x * v[i]!, 0)) > 0.02 || normal[0] > -0.98 || Math.abs(u[1] / config.asset.widthM - 1) > 0.03 || Math.abs(v[2] / config.asset.heightM + 1) > 0.03) throw new RangeError('Asset geometry registration failed')
    const centerM = br.map((n, i) => (n + tl[i]!) / 2) as SensorVector
    const lever = rotateBodyToNed(pose.quaternionWxyz, config.calibration.extrinsics.translationM)
    const cameraPositionM = pose.positionM.map((n, i) => n + lever[i]!) as SensorVector
    const cameraSeparationM = cameraPositionM.reduce((sum, n, i) => sum + (n - centerM[i]!) * normal[i]!, 0)
    const uncertaintyM = config.asset.registrationSigmaM + p.rangeSigmaM + positionSigmaM + Math.max(...p.pointsBodyM.map(point => Math.hypot(...point))) * attitudeSigmaRad
    return { sequence: p.sequence, capturedAtMs: p.capturedAtMs, receivedAtMs: p.receivedAtMs, reference: pose.reference, centerM, normalNed: normal, uncertaintyM, registrationDisplacementM: distance(centerM, config.asset.centerM), cameraSeparationM }
  }
  const instrument: MissionSimulationInstrument = {
    disturbance(nowMs) { return { windMps: scenario === 'wind' && nowMs >= 8000 ? [0.15, 0.25 * Math.sin(nowMs / 1100), 0] : [0, 0, 0] } },
    dropSensors(nowMs) { return { position: scenario === 'gnss-loss' && nowMs >= 10000 && nowMs < 12000 } },
    render(body, nowMs) {
      camera.render(body, nowMs)
      packet = renderInspectionRange(plan, body, nowMs, ++rangeSequence, modeledCenter(nowMs))
      const separation = modeledCenter(nowMs)[0] - body.positionM[0] - config.clearance.bodyRadiusM
      minimumObservedSeparationM = minimumObservedSeparationM === null ? separation : Math.min(minimumObservedSeparationM, separation)
    },
    observe({ nowMs, estimate, sensors, mission, authority }) {
      if (reason) return 'abort'
      if (mission.state !== 'running' && mission.state !== 'paused') return undefined
      if (authority !== 'autonomous') { reason = 'inspection-authority-lost'; pending = null; camera.close(); return undefined }
      const imu = sensors.sensors.find(s => s.kind === 'imu')?.observation
      const pose = predictVehicleMeasurementPose(estimate, imu, nowMs)
      // Mission policy and authority retain their own estimator-loss outcome.
      if (!pose || !estimate.localPosition || nowMs - (estimate.localPosition.capturedAtMs ?? -Infinity) > 200) { reason = 'inspection-pose-unqualified'; pending = null; camera.close(); return undefined }
      if (reference !== null && reference !== pose.reference) return fail('inspection-reference-changed')
      reference = pose.reference
      try {
        const velocityMps = Math.hypot(...estimate.localPosition.velocityMps)
        const rates = (imu?.value as ImuMeasurement | undefined)?.angularRateRadS ?? [0, 0, 0]
        const angularRateRadS = Math.hypot(...rates), clockSeconds = config.calibration.timing.clockUncertaintyMs / 1000
        const attitudeSigmaRad = 0.003 + config.calibration.uncertainty.rotationSigmaRad + nowMs / 1000000 + 35 * clockSeconds
        const positionSigmaM = Math.sqrt(Math.max(...estimate.localPosition.covarianceBlocks.map(block => block.positionM2))) + config.calibration.uncertainty.translationSigmaM + velocityMps * clockSeconds + Math.hypot(...config.calibration.extrinsics.translationM) * attitudeSigmaRad
        if (positionSigmaM > config.quality.maxPoseSigmaM || attitudeSigmaRad > config.quality.maxAttitudeSigmaRad) return fail('inspection-pose-uncertainty')
        const assetObservation = observeAsset(pose, positionSigmaM, attitudeSigmaRad, nowMs)
        if (assetObservation.registrationDisplacementM > config.clearance.assetMotionBoundM + config.asset.registrationSigmaM + positionSigmaM) return fail('inspection-asset-moved')
        const stopping = velocityMps * config.clearance.reactionMs / 1000 + velocityMps ** 2 / (2 * config.clearance.brakingAccelerationMps2)
        const required = config.clearance.minSeparationM + config.clearance.bodyRadiusM + Math.max(config.clearance.positionBoundM, assetObservation.uncertaintyM) + config.clearance.assetMotionBoundM + stopping
        if (assetObservation.cameraSeparationM < required) return fail('inspection-clearance-unqualified')
        if (pending) {
          const ack = camera.poll(nowMs)
          if (ack) {
            if (ack.sessionId !== pending.sessionId || ack.sequence !== pending.sequence || ack.reference !== pending.pose.reference || ack.issuedAtMs !== pending.issuedAtMs || ack.capturedAtMs !== pending.capturedAtMs || ack.acknowledgedAtMs > pending.issuedAtMs + 80 || ack.acknowledgedAtMs > nowMs || !ack.thermalCentiKelvin || ack.rgba.length !== config.calibration.output.width * config.calibration.output.height * 4) return fail('inspection-camera-ack-scope-or-timing')
            const capture = { ...pending, acknowledgedAtMs: ack.acknowledgedAtMs, image: { ...config.calibration.output, rgba: ack.rgba, thermalCentiKelvin: ack.thermalCentiKelvin } }
            captures.push({ ...capture, quality: inspectCaptureQuality(plan, capture, pendingMotion) }); pending = null
          }
          else if (nowMs >= pending.issuedAtMs + 80) return fail('inspection-camera-ack-deadline')
        }
        if (mission.state !== 'running' || pending) return undefined
        const station = plan.stations.find(s => `capture-${s.id}` === mission.taskId)
        if (!station || capturedStations.has(station.id) || distance(pose.positionM, station.vehiclePositionM) > config.quality.maxStationOffsetM || velocityMps > 0.15 || angularRateRadS > 0.1) return undefined
        const lever = rotateBodyToNed(pose.quaternionWxyz, config.calibration.extrinsics.translationM)
        const cameraPositionM = pose.positionM.map((n, i) => n + lever[i]!) as SensorVector
        pending = { id: `capture-${String(++sequence).padStart(4, '0')}`, visitId, stationId: station.id, assetId: config.asset.id, revision: config.asset.revision, sessionId: visitId, sequence, issuedAtMs: nowMs, capturedAtMs: nowMs, calibrationId: config.calibration.id, clockUncertaintyMs: config.calibration.timing.clockUncertaintyMs, exposureTimeUs: config.exposureTimeUs, pose, cameraPositionM, positionSigmaM, attitudeSigmaRad, assetObservation }
        pendingMotion = { velocityMps, angularRateRadS }
        camera.request({ sessionId: pending.sessionId, sequence, issuedAtMs: nowMs, reference: pose.reference })
        capturedStations.add(station.id)
      }
      catch { return fail('inspection-range-or-camera-failed') }
      return undefined
    },
  }
  try {
    const run = simulateMission({ plan: plan.mission, seconds, scenario: scenario === 'pause-resume' || scenario === 'abort' || scenario === 'rc-override' ? scenario : 'nominal', instrument })
    if (pending) reason ??= 'inspection-uncertain-pending-capture'
    if (run.mission.state === 'completed' && captures.length !== plan.stations.length) reason ??= 'inspection-missing-stations'
    const status = run.mission.state === 'completed' && !reason ? 'completed' : run.mission.state === 'blocked' ? 'blocked' : run.mission.state === 'aborted' ? 'aborted' : 'incomplete'
    return { version: 1, evidence: 'owned-inspection-physics-simulation', physicalFlightEnabled: false, physicalInspectionVerified: false, visitId, scenario, plan, trace: run.trace, status, reason: reason ?? run.mission.reason, captures, boardNeutral: run.board.motorsN.every(n => n === 0), minimumObservedSeparationM, path: run.path.map(row => ({ atMs: row.atMs, positionM: row.estimatedPositionM as SensorVector | null, targetM: row.targetM as SensorVector | null, taskId: row.taskId, state: row.state })) }
  }
  finally { camera.close() }
}
