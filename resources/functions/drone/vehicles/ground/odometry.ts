import type { EstimatorSnapshot } from '../../estimation/estimator'
import type { VehicleMeasurement } from '../types'
import { groundModel } from './plant'

export interface GroundObservation {
  healthy: boolean
  reason: string
  positionM: [number, number, number]
  speedMps: number
  wheelSpeedMps: number
  yawRad: number
  yawRateRadS: number
  obstacleM: number
  personM: number
  onSurface: boolean
  stopped: boolean
  guardClosed: boolean
  emergency: boolean
  uncertaintyM: number
}
/** Encoder counts are calibrated to wheel travel, integrated at IMU yaw, then corrected against owned GNSS estimates. */
export function createGroundOdometry() {
  let previous: VehicleMeasurement | null = null, signature = '', position: [number, number, number] = [0, 0, 0], wheelSpeed = 0, wheelYawRate = 0, slipSince: number | null = null
  let lastNow = -1
  function invalid(reason: string): GroundObservation { return { healthy: false, reason, positionM: [...position], speedMps: 0, wheelSpeedMps: wheelSpeed, yawRad: 0, yawRateRadS: 0, obstacleM: 0, personM: 0, onSurface: false, stopped: false, guardClosed: false, emergency: true, uncertaintyM: 100 } }
  return {
    step(packet: VehicleMeasurement | null, estimate: EstimatorSnapshot, nowMs: number): GroundObservation {
      if (!Number.isFinite(nowMs) || nowMs < lastNow) return invalid('ground-clock-reversal')
      lastNow = nowMs
      const p = estimate.localPosition, a = estimate.attitude
      const reference = `${estimate.bootId}:${Object.values(estimate.resets).join(',')}`
      if (estimate.evidence !== 'fixture' || !estimate.health.localPosition || !estimate.health.tilt || !p || !a || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'WGS84_ELLIPSOID' || p.capturedAtMs === null || nowMs - p.capturedAtMs > 200 || p.capturedAtMs > nowMs || a.capturedAtMs === null || nowMs - a.capturedAtMs > 60 || a.capturedAtMs > nowMs || ![...p.positionM, ...p.velocityMps, ...a.eulerRad, ...a.quaternionWxyz].every(Number.isFinite)) return invalid('ground-localization-loss')
      if (!packet || packet.version !== 1 || packet.vehicle !== 'ground' || packet.evidence !== 'modeled-vehicle-sensors' || packet.reference !== reference || !Number.isSafeInteger(packet.sequence) || packet.sequence < 1 || !Number.isSafeInteger(packet.capturedAtMs) || !Number.isSafeInteger(packet.receivedAtMs) || packet.receivedAtMs < packet.capturedAtMs || packet.receivedAtMs > nowMs || packet.capturedAtMs < 0 || nowMs - packet.capturedAtMs > 140) return invalid('ground-sensor-stale-or-reference')
      const v = packet.values
      const counts = v.encoderCounts
      if (!Array.isArray(counts) || counts.length !== 2 || !counts.every(n => Number.isSafeInteger(n) && Math.abs(n) < 1e9) || v.calibration !== 'ground-4096-015-060-v1' || v.clockUncertaintyMs !== 1 || !['obstacleMm', 'personMm'].every(k => Number.isInteger(v[k]) && Number(v[k]) >= 0 && Number(v[k]) <= 20000) || !['onSurface', 'stopped', 'guardClosed', 'emergency', 'bumper'].every(k => typeof v[k] === 'boolean')) return invalid('ground-sensor-invalid')
      const nextSignature = JSON.stringify(packet)
      if (previous && (packet.sequence < previous.sequence || packet.capturedAtMs < previous.capturedAtMs || (packet.sequence === previous.sequence && nextSignature !== signature) || (packet.sequence > previous.sequence && packet.capturedAtMs <= previous.capturedAtMs))) return invalid('ground-sensor-replay')
      const yaw = a.eulerRad[2], speed = p.velocityMps[0]! * Math.cos(yaw) + p.velocityMps[1]! * Math.sin(yaw)
      if (Math.abs(speed) > 2) return invalid('ground-speed-envelope')
      if (!previous) position = [...p.positionM] as [number, number, number]
      else if (packet.sequence !== previous.sequence) {
        const dt = (packet.capturedAtMs - previous.capturedAtMs) / 1000
        const before = previous.values.encoderCounts as number[]
        const left = (counts[0]! - before[0]!) * 2 * Math.PI * groundModel.radiusM / groundModel.encoderCountsPerRev
        const right = (counts[1]! - before[1]!) * 2 * Math.PI * groundModel.radiusM / groundModel.encoderCountsPerRev
        if (dt <= 0 || dt > 0.14 || Math.abs(left) > 0.7 || Math.abs(right) > 0.7) return invalid('ground-encoder-jump')
        wheelSpeed = (left + right) / (2 * dt); wheelYawRate = (right - left) / (dt * groundModel.trackM)
        position = [position[0] + (left + right) / 2 * Math.cos(yaw), position[1] + (left + right) / 2 * Math.sin(yaw), 0]
        // GNSS bounds drift; encoder increments are not treated as slip-free truth.
        position = position.map((n, i) => 0.8 * n + 0.2 * p.positionM[i]!) as [number, number, number]
      }
      previous = structuredClone(packet); signature = nextSignature
      if (Math.abs(wheelSpeed - speed) > 0.55) slipSince ??= nowMs
      else slipSince = null
      const uncertainty = Math.sqrt(Math.max(...p.covarianceBlocks.slice(0, 2).map(c => c.positionM2))) * 3 + 0.03
      if (!Number.isFinite(uncertainty) || uncertainty > 1) return invalid('ground-localization-uncertainty')
      if (slipSince !== null && nowMs - slipSince >= 200) return invalid('ground-traction-loss')
      return { healthy: true, reason: 'ground-encoder-gnss-fused', positionM: [...position], speedMps: 0.8 * speed + 0.2 * wheelSpeed, wheelSpeedMps: wheelSpeed, yawRad: yaw, yawRateRadS: wheelYawRate, obstacleM: Number(v.obstacleMm) / 1000, personM: Number(v.personMm) / 1000, onSurface: v.onSurface as boolean, stopped: v.stopped as boolean, guardClosed: v.guardClosed as boolean, emergency: !!v.emergency || !!v.bumper, uncertaintyM: uncertainty }
    },
  }
}
/** Distance includes body radius, measurement+lease latency and bounded active braking. Neutral still coasts. */
export function groundStoppingEnvelope(speedMps: number, ageMs: number, uncertaintyM: number): number {
  if (![speedMps, ageMs, uncertaintyM].every(Number.isFinite) || Math.abs(speedMps) > 5 || ageMs < 0 || ageMs > 140 || uncertaintyM < 0 || uncertaintyM > 1) throw new RangeError('Invalid modeled ground stopping envelope')
  return groundModel.bodyRadiusM + Math.abs(speedMps) * (ageMs / 1000 + 0.1) + speedMps ** 2 / (2 * 0.5) + uncertaintyM + 0.15
}
