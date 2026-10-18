import type { VehicleMeasurement, VehicleMeasurementPose, VehiclePayloadCommand } from '../types'
import type { VehicleMissionTrace } from '../../missions/vehicle'
import { replayVehicleMission } from '../../missions/vehicle'
import { qualifySubseaMeasurement } from './sensors'

export interface SubseaInspectionUncertainty { positionSigmaM: number, attitudeSigmaRad: number, timeSigmaMs: number, rangeSigmaM: number }
/** Fixture assumptions, not measured instrument specifications or estimator covariance. */
export const subseaInspectionUncertainty: Readonly<SubseaInspectionUncertainty> = Object.freeze({ positionSigmaM: 0.1, attitudeSigmaRad: 0.02, timeSigmaMs: 2, rangeSigmaM: 0.05 })
export interface SubseaInspectionPathRow { atMs: number, measurement: VehicleMeasurement | null, measurementPose: VehicleMeasurementPose | null }
function validatePose(pose: VehicleMeasurementPose, measurement: VehicleMeasurement): void {
  if (pose.reference !== measurement.reference || pose.capturedAtMs !== measurement.capturedAtMs || pose.positionPredictedToMs !== pose.capturedAtMs || pose.attitudePredictedToMs !== pose.capturedAtMs || pose.attitudePrediction !== 'qualified-gyro-hold' || pose.gyroCapturedAtMs !== pose.attitudeCapturedAtMs || ![pose.positionCapturedAtMs, pose.attitudeCapturedAtMs].every(at => Number.isSafeInteger(at) && at >= 0 && at <= pose.capturedAtMs) || pose.capturedAtMs - pose.positionCapturedAtMs > 200 || pose.capturedAtMs - pose.attitudeCapturedAtMs > 60 || !Array.isArray(pose.positionM) || pose.positionM.length !== 3 || !pose.positionM.every(Number.isFinite) || !Array.isArray(pose.quaternionWxyz) || pose.quaternionWxyz.length !== 4 || !pose.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...pose.quaternionWxyz) - 1) > 0.001) throw new RangeError('Unqualified inspection capture pose provenance')
}
/** Join acknowledged captures to recorded packets and owned capture poses. No physical image or global survey claim. */
export function reduceSubseaInspection(pathInput: SubseaInspectionPathRow[], traceInput: VehicleMissionTrace, uncertaintyInput: SubseaInspectionUncertainty = subseaInspectionUncertainty) {
  if (!Array.isArray(pathInput) || pathInput.length > 9001) throw new RangeError('Inspection path exceeds recording bounds')
  const fields = ['positionSigmaM', 'attitudeSigmaRad', 'timeSigmaMs', 'rangeSigmaM']
  if (!uncertaintyInput || typeof uncertaintyInput !== 'object' || Array.isArray(uncertaintyInput) || ![Object.prototype, null].includes(Object.getPrototypeOf(uncertaintyInput)) || Reflect.ownKeys(uncertaintyInput).length !== fields.length || Object.keys(uncertaintyInput).length !== fields.length || !fields.every(key => Object.prototype.hasOwnProperty.call(uncertaintyInput, key))) throw new RangeError('Invalid subsea inspection uncertainty declaration')
  const uncertainty = structuredClone(uncertaintyInput)
  if (!fields.every(key => { const value = uncertainty[key as keyof SubseaInspectionUncertainty]; return typeof value === 'number' && Number.isFinite(value) && value >= 0 }) || uncertainty.positionSigmaM > 10 || uncertainty.attitudeSigmaRad > 0.5 || uncertainty.timeSigmaMs < 1 || uncertainty.timeSigmaMs > 100 || uncertainty.rangeSigmaM > 10) throw new RangeError('Invalid subsea inspection uncertainty declaration')
  const trace = replayVehicleMission(traceInput).trace(), path = structuredClone(pathInput)
  if (trace.plan.vehicle !== 'subsea') throw new RangeError('Invalid subsea inspection mission context')
  const pending = new Map<string, VehiclePayloadCommand>(), used = new Set<string>()
  const captures = []
  for (const row of trace.rows) {
    const ack = row.observation.payloadAck
    if (ack && ack.operation === 'inspection-capture' && ack.outcome === 'confirmed') {
      const command = pending.get(ack.eventId)
      if (!command || used.has(ack.eventId) || row.result.reason !== 'payload-confirmed' || ack.containerId !== null || ack.taskId !== command.taskId || ack.reference !== command.reference || ack.capturedAtMs < command.issuedAtMs || ack.capturedAtMs >= command.expiresAtMs) throw new RangeError('Unscoped or repeated inspection acknowledgement')
      const matching = path.filter(p => p.measurement !== null && p.measurement.sequence === ack.metadata?.measurementSequence && p.measurement.reference === ack.reference && p.measurement.capturedAtMs === ack.capturedAtMs && p.atMs <= row.observation.nowMs)
      const source = matching.find(p => p.measurementPose !== null)
      if (!source?.measurement || !source.measurementPose) throw new RangeError('Inspection acknowledgement has no recorded capture pose')
      const raw = qualifySubseaMeasurement(source.measurement, source.atMs, ack.reference), pose = source.measurementPose
      if (!raw) throw new RangeError('Unqualified recorded inspection packet')
      validatePose(pose, raw)
      if (raw.values.structureHit !== true || ack.metadata?.structureHit !== true || ack.metadata?.cameraLumaHex !== (raw.values.cameraLuma as number[]).map(n => n.toString(16).padStart(2, '0')).join('') || ack.metadata?.orientationWxyz !== pose.quaternionWxyz.join(',') || ack.metadata?.positionSourceAtMs !== pose.positionCapturedAtMs || ack.metadata?.attitudeSourceAtMs !== pose.attitudeCapturedAtMs || ack.metadata?.gyroSourceAtMs !== pose.gyroCapturedAtMs || ack.metadata?.cameraFrameId !== raw.values.cameraFrameId || ack.metadata?.sonarRangeM !== raw.values.structureRangeM || ack.metadata?.bottomRangeM !== raw.values.bottomRangeM || ack.metadata?.clockSigmaMs !== raw.values.clockSigmaMs || ack.metadata?.evidence !== 'modeled-subsea-capture' || ack.metadata.physicalImageVerified !== false || ack.metadata.physicalSonarVerified !== false || ack.positionM.some((n, i) => n !== pose.positionM[i]) || Math.hypot(...pose.positionM.map((n, i) => n - command.positionM[i]!)) > 0.25 || uncertainty.timeSigmaMs < Number(raw.values.clockSigmaMs)) throw new RangeError('Changed inspection capture identity, pose or uncertainty')
      if (matching.some(p => JSON.stringify(p.measurement) !== JSON.stringify(source.measurement) || JSON.stringify(p.measurementPose) !== JSON.stringify(pose))) throw new RangeError('Conflicting repeated inspection capture')
      const pixels = [...raw.values.cameraLuma as number[]], bytes = [...new TextEncoder().encode('P5\n4 4\n255\n'), ...pixels]
      captures.push({ eventId: ack.eventId, taskId: ack.taskId, capturedAtMs: ack.capturedAtMs, reference: ack.reference, positionM: [...pose.positionM], sonar: { rangeM: Number(raw.values.structureRangeM), bottomRangeM: Number(raw.values.bottomRangeM), frame: 'BODY_FRD' as const, beamDirection: [1, 0, 0], structureHit: true, bottomFrame: 'LOCAL_NED' as const, bottomBeamDirection: [0, 0, 1] }, camera: { format: 'pgm-p5' as const, width: 4, height: 4, maxValue: 255, frameId: String(raw.values.cameraFrameId), pixels, bytes }, pose, raw, uncertainty: { ...uncertainty, basis: 'declared independent fixture assumptions; no measured instrument calibration or covariance qualification' } })
      used.add(ack.eventId)
    }
    if (row.result.payload) pending.set(row.result.payload.eventId, row.result.payload)
  }
  if (!captures.length) throw new RangeError('No confirmed scoped subsea inspection captures')
  return { version: 1, evidence: 'modeled-subsea-inspection' as const, physicalValidation: false as const, metadata: { frame: 'LOCAL_NED' as const, altitudeDatum: 'LOCAL_WATER_SURFACE' as const, reference: captures[0]!.reference, origin: trace.plan.origin, coordinates: 'local fixture alignment only; no global georeferencing', imagery: 'synthetic 4 by 4 luminance fixture; no physical camera acquisition', sonar: 'modeled single forward range and bottom range; no imaging sonar or area coverage', uncertainty: 'one standard deviation declared assumptions; no survey or inspection qualification' }, frames: captures }
}
