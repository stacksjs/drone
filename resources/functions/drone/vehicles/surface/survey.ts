import type { SensorVector } from '../../sensors/types'
export interface SurfacePing {
  id: string, reference: string, capturedAtMs: number, receivedAtMs: number, clockSigmaMs: number
  twoWayTravelS: number, soundSpeedMps: number, draftM: number, waterLevelAboveDatumM: number, datum: string
  timeSigmaS: number, soundSpeedSigmaMps: number, draftSigmaM: number, waterLevelSigmaM: number, motionSigmaM: number
}
export interface SurfaceSurveyPose { reference: string, atMs: number, positionM: SensorVector, rollRad: number, pitchRad: number, yawRad: number, attitudeSigmaRad: number, positionSigmaM: number, timeSigmaMs: number, speedMps: number, provenance?: Omit<VehicleMeasurementPose, 'positionM' | 'quaternionWxyz'> }
export interface SurfaceSounding { id: string, reference: string, capturedAtMs: number, receivedAtMs: number, positionM: SensorVector, depthBelowDatumM: number, verticalSigmaM: number, horizontalSigmaM: number, raw: SurfacePing, pose: SurfaceSurveyPose }
/** Flat, homogeneous water column; vertical single beam. No refraction or multibeam model. */
export function correctSurfaceSounding(pingInput: SurfacePing, poseInput: SurfaceSurveyPose): SurfaceSounding {
  const ping = structuredClone(pingInput), pose = structuredClone(poseInput)
  const numeric = [ping.clockSigmaMs, ping.capturedAtMs, ping.receivedAtMs, ping.twoWayTravelS, ping.soundSpeedMps, ping.draftM, ping.waterLevelAboveDatumM, ping.timeSigmaS, ping.soundSpeedSigmaMps, ping.draftSigmaM, ping.waterLevelSigmaM, ping.motionSigmaM, pose.atMs, pose.rollRad, pose.pitchRad, pose.yawRad, pose.attitudeSigmaRad, pose.positionSigmaM, pose.timeSigmaMs, pose.speedMps, ...pose.positionM]
  if (!Array.isArray(pose.positionM) || pose.positionM.length !== 3 || !numeric.every(Number.isFinite) || ping.clockSigmaMs < 1 || ping.clockSigmaMs > 5 || pose.timeSigmaMs < ping.clockSigmaMs || typeof ping.id !== 'string' || typeof ping.datum !== 'string' || typeof ping.reference !== 'string' || !ping.id || !ping.datum || !ping.reference || ping.reference !== pose.reference || ping.capturedAtMs !== pose.atMs || ping.receivedAtMs < ping.capturedAtMs || ping.receivedAtMs - ping.capturedAtMs > 120 || ping.twoWayTravelS <= 0 || ping.twoWayTravelS > 0.2 || ping.soundSpeedMps < 1300 || ping.soundSpeedMps > 1700 || ping.draftM < 0 || ping.draftM > 3 || Math.abs(pose.rollRad) > 0.05 || Math.abs(pose.pitchRad) > 0.05 || [pose.attitudeSigmaRad, ping.timeSigmaS, ping.soundSpeedSigmaMps, ping.draftSigmaM, ping.waterLevelSigmaM, ping.motionSigmaM, pose.positionSigmaM, pose.timeSigmaMs, pose.speedMps].some(n => n < 0)) throw new RangeError('Unqualified surface sounding or capture-time pose')
  const provenance = pose.provenance
  if (provenance && (provenance.reference !== pose.reference || provenance.capturedAtMs !== pose.atMs || provenance.positionPredictedToMs !== pose.atMs || provenance.attitudePredictedToMs !== pose.atMs || provenance.attitudePrediction !== 'qualified-gyro-hold' || provenance.gyroCapturedAtMs !== provenance.attitudeCapturedAtMs || ![provenance.positionCapturedAtMs, provenance.attitudeCapturedAtMs].every(at => Number.isSafeInteger(at) && at >= 0 && at <= pose.atMs) || pose.atMs - provenance.positionCapturedAtMs > 200 || pose.atMs - provenance.attitudeCapturedAtMs > 60)) throw new RangeError('Invalid sounding capture pose provenance')
  const range = ping.twoWayTravelS * ping.soundSpeedMps / 2
  const vertical = Math.cos(pose.rollRad) * Math.cos(pose.pitchRad)
  const depth = range * vertical + ping.draftM - ping.waterLevelAboveDatumM
  if (depth <= 0) throw new RangeError('Non-positive datum depth')
  const verticalSigmaM = Math.hypot(vertical * ping.soundSpeedMps * ping.timeSigmaS / 2, vertical * ping.twoWayTravelS * ping.soundSpeedSigmaMps / 2, range * Math.sin(pose.rollRad) * Math.cos(pose.pitchRad) * pose.attitudeSigmaRad, range * Math.cos(pose.rollRad) * Math.sin(pose.pitchRad) * pose.attitudeSigmaRad, ping.draftSigmaM, ping.waterLevelSigmaM, ping.motionSigmaM)
  return { id: ping.id, reference: ping.reference, capturedAtMs: ping.capturedAtMs, receivedAtMs: ping.receivedAtMs, positionM: [pose.positionM[0] + range * (Math.cos(pose.yawRad) * Math.sin(pose.pitchRad) * Math.cos(pose.rollRad) + Math.sin(pose.yawRad) * Math.sin(pose.rollRad)), pose.positionM[1] + range * (Math.sin(pose.yawRad) * Math.sin(pose.pitchRad) * Math.cos(pose.rollRad) - Math.cos(pose.yawRad) * Math.sin(pose.rollRad)), pose.positionM[2] + ping.draftM + range * vertical], depthBelowDatumM: depth, verticalSigmaM, horizontalSigmaM: Math.hypot(pose.positionSigmaM, pose.speedMps * pose.timeSigmaMs / 1000, Math.sqrt(3) * range * pose.attitudeSigmaRad), raw: ping, pose }
}
export function exportSurfaceSurvey(input: SurfaceSounding[]) {
  if (!input.length || input.length > 20000) throw new RangeError('Survey must contain 1..20000 soundings')
  const soundings = structuredClone(input), first = soundings[0]!
  const ids = new Set<string>()
  for (const row of soundings) {
    if (ids.has(row.id) || row.id !== row.raw.id || row.capturedAtMs !== row.raw.capturedAtMs || row.receivedAtMs !== row.raw.receivedAtMs || row.reference !== row.raw.reference || row.reference !== first.reference || row.raw.datum !== first.raw.datum) throw new RangeError('Duplicate ping or mixed survey context')
    ids.add(row.id)
    const checked = correctSurfaceSounding(row.raw, row.pose)
    if (JSON.stringify(checked.positionM) !== JSON.stringify(row.positionM) || checked.horizontalSigmaM !== row.horizontalSigmaM) throw new RangeError('Changed survey position or uncertainty')
    if (checked.depthBelowDatumM !== row.depthBelowDatumM || checked.verticalSigmaM !== row.verticalSigmaM || !Number.isFinite(row.horizontalSigmaM) || row.horizontalSigmaM < 0) throw new RangeError('Invalid reduced sounding')
  }
  return { metadata: { version: 1, evidence: 'modeled-single-beam' as const, physicalValidation: false as const, frame: 'LOCAL_NED' as const, horizontalOrigin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, verticalDatum: first.raw.datum, depthConvention: 'positive below declared datum', uncertainty: 'one standard deviation, independent terms, no charting certification', coverage: 'single-beam track only; no full-bottom coverage', correctionModel: 'homogeneous sound speed, fixed draft, observed water level, identity-mounted beam with measured attitude', reference: first.reference }, soundings }
}

import type { VehicleMeasurement, VehicleMeasurementPose } from '../types'
import { quaternionEuler } from '../../estimation/frames'
import { surfacePingFromMeasurement } from './sensors'
/** Reduce only distinct capture-aligned packets. Caller supplies justified horizontal/clock sigmas. */
export function reduceSurfaceSurvey(rows: { atMs: number, measurement: VehicleMeasurement | null, measurementPose: VehicleMeasurementPose | null }[], uncertainty: { positionSigmaM: number, timeSigmaMs: number, attitudeSigmaRad: number }) {
  if (!Number.isFinite(uncertainty.timeSigmaMs) || uncertainty.timeSigmaMs < 1) throw new RangeError('Survey requires a finite clock uncertainty of at least 1 ms')
  const seen = new Set<number>(), soundings: SurfaceSounding[] = []
  for (const row of rows) {
    const m = row.measurement, pose = row.measurementPose
    if (!m || !pose || seen.has(m.sequence)) continue
    if (pose.positionPredictedToMs !== pose.capturedAtMs || pose.attitudePredictedToMs !== pose.capturedAtMs || pose.attitudePrediction !== 'qualified-gyro-hold' || pose.gyroCapturedAtMs !== pose.attitudeCapturedAtMs || ![pose.positionCapturedAtMs, pose.attitudeCapturedAtMs, pose.gyroCapturedAtMs].every(at => Number.isSafeInteger(at) && at >= 0 && at <= pose.capturedAtMs) || pose.capturedAtMs - pose.positionCapturedAtMs > 200 || pose.capturedAtMs - pose.attitudeCapturedAtMs > 60) throw new RangeError('Unqualified capture pose provenance')
    const euler = quaternionEuler(pose.quaternionWxyz)
    const raw = surfacePingFromMeasurement(m, row.atMs)
    if (uncertainty.timeSigmaMs < Number(m.values.clockSigmaMs)) throw new RangeError('Survey clock uncertainty understates the modeled sensor declaration')
    const sounding = correctSurfaceSounding(raw, { reference: pose.reference, atMs: pose.capturedAtMs, positionM: pose.positionM, rollRad: euler[0], pitchRad: euler[1], yawRad: euler[2], attitudeSigmaRad: uncertainty.attitudeSigmaRad, positionSigmaM: uncertainty.positionSigmaM, timeSigmaMs: uncertainty.timeSigmaMs, speedMps: Number(m.values.speedMps), provenance: { capturedAtMs: pose.capturedAtMs, reference: pose.reference, positionCapturedAtMs: pose.positionCapturedAtMs, positionPredictedToMs: pose.positionPredictedToMs, attitudeCapturedAtMs: pose.attitudeCapturedAtMs, attitudePredictedToMs: pose.attitudePredictedToMs, gyroCapturedAtMs: pose.gyroCapturedAtMs, attitudePrediction: pose.attitudePrediction } })
    soundings.push(sounding); seen.add(m.sequence)
  }
  return exportSurfaceSurvey(soundings)
}
