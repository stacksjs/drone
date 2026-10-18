import type { EstimatorSnapshot } from '../../estimation/estimator'
import type { Quaternion } from '../../estimation/frames'
import type { SensorVector } from '../../sensors/types'
import type { VehicleMeasurement, VehicleNavigation } from '../types'
import { normalizeQuaternion } from '../../estimation/frames'
import { vehicleReference } from '../measurements'
import { qualifySubseaMeasurement } from './sensors'

/** Hydrostatic depth relative to the declared water surface, never ellipsoid or chart datum. */
export function pressureDepthM(pressurePa: number, surfacePressurePa: number, waterDensityKgM3: number): number {
  if (![pressurePa, surfacePressurePa, waterDensityKgM3].every(Number.isFinite) || surfacePressurePa !== 101325 || waterDensityKgM3 !== 1025) throw new RangeError('Invalid subsea pressure calibration')
  const depth = (pressurePa - surfacePressurePa) / (waterDensityKgM3 * 9.80665)
  if (depth < -0.1 || depth > 10) throw new RangeError('Subsea pressure outside modeled depth range')
  return depth
}
function rotate(q: Quaternion, v: SensorVector): SensorVector {
  const [w, x, y, z] = q
  return [(1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2], 2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2], 2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2]]
}
/** Bottom-locked velocity integration from an explicit surface origin. Relative yaw is an assumption. */
export function createSubseaNavigation(): VehicleNavigation {
  let now = -Infinity, reference: string | null = null, fault = '', last: VehicleMeasurement | null = null, signature = ''
  let position: SensorVector = [0, 0, 0], velocity: SensorVector = [0, 0, 0], initializedAt = 0, distanceM = 0
  let pressureHealthy = false, pressure: { depth: number, at: number } | null = null
  const history: { at: number, q: Quaternion }[] = []
  function attitudeAt(at: number): Quaternion | null {
    const exact = history.find(row => Math.abs(row.at - at) < 0.001)
    if (exact) return exact.q
    const right = history.find(row => row.at > at), left = history.filter(row => row.at < at).at(-1)
    if (!left || !right || right.at - left.at > 25) return null
    const alpha = (at - left.at) / (right.at - left.at), sign = left.q.reduce((sum, n, i) => sum + n * right.q[i]!, 0) < 0 ? -1 : 1
    return normalizeQuaternion(left.q.map((n, i) => n * (1 - alpha) + sign * right.q[i]! * alpha) as Quaternion)
  }
  return {
    update(base, measurement, nowMs) {
      const out = structuredClone(base), started = last !== null
      const validTime = Number.isSafeInteger(nowMs) && nowMs >= 0 && base.nowMs === nowMs && nowMs >= now && (!started || nowMs - now <= 40)
      if (!validTime) fault ||= 'subsea-clock-discontinuity'
      now = nowMs
      const ref = vehicleReference(base), attitude = base.attitude
      const validAttitude = base.evidence === 'fixture' && typeof base.bootId === 'bigint' && base.bootId > 0n && base.health.tilt && attitude && attitude.capturedAtMs !== null && Number.isFinite(attitude.capturedAtMs) && attitude.capturedAtMs <= nowMs && nowMs - attitude.capturedAtMs <= 60 && attitude.quaternionWxyz.length === 4 && attitude.quaternionWxyz.every(Number.isFinite) && Math.abs(Math.hypot(...attitude.quaternionWxyz) - 1) < 1e-6
      if (started && (!validAttitude || ref !== reference)) fault ||= ref !== reference ? 'subsea-reference-changed' : 'subsea-imu-unhealthy'
      if (validAttitude && !fault) {
        const previous = history.at(-1)
        if (!previous || attitude.capturedAtMs! > previous.at) history.push({ at: attitude.capturedAtMs!, q: [...attitude.quaternionWxyz] })
        else if (attitude.capturedAtMs! < previous.at || attitude.quaternionWxyz.some((n, i) => Math.abs(n - previous.q[i]!) > 1e-9)) fault ||= 'subsea-attitude-replay'
        while (history.length > 140 || history.length > 1 && nowMs - history[0]!.at > 500) history.shift()
      }
      const checked = qualifySubseaMeasurement(measurement, nowMs, ref)
      pressureHealthy = checked !== null
      if (checked) pressure = { depth: pressureDepthM(Number(checked.values.pressurePa), Number(checked.values.surfacePressurePa), Number(checked.values.waterDensityKgM3)), at: checked.capturedAtMs }
      if (started && measurement !== null && !checked) fault ||= 'subsea-sensor-unqualified'
      if (started && last && nowMs - last.capturedAtMs + 1 > 120) fault ||= 'subsea-sensor-stale'
      if (checked && !fault && validAttitude) {
        const encoded = JSON.stringify(checked)
        if (last && (checked.sequence < last.sequence || checked.sequence === last.sequence && encoded !== signature || checked.sequence > last.sequence && checked.capturedAtMs <= last.capturedAtMs)) fault = 'subsea-sensor-replay'
        else if (!last || checked.sequence !== last.sequence) {
          const q = attitudeAt(checked.capturedAtMs)
          if (!q) { if (started) fault = 'subsea-capture-attitude-unavailable' }
          else if (!checked.values.dvlLocked) { if (started) fault = 'subsea-dvl-bottom-lock-lost' }
          else if (!started && (!checked.values.onSurface || !checked.values.stopped || Math.abs(pressureDepthM(Number(checked.values.pressurePa), Number(checked.values.surfacePressurePa), Number(checked.values.waterDensityKgM3))) > 0.05 || Math.hypot(...checked.values.dvlVelocityBodyMps as SensorVector) > 0.05)) { /* Explicit stationary water-surface alignment is required. */ }
          else {
            const nextVelocity = rotate(q, checked.values.dvlVelocityBodyMps as SensorVector)
            if (last) {
              const dt = (checked.capturedAtMs - last.capturedAtMs) / 1000
              if (dt > 0.06) fault = 'subsea-dvl-capture-gap'
              else {
                position = position.map((n, i) => n + (velocity[i]! + nextVelocity[i]!) * dt / 2) as SensorVector
                distanceM += Math.hypot(...nextVelocity) * dt
              }
            }
            else { initializedAt = checked.capturedAtMs; reference = ref }
            if (!fault) {
              position[2] = pressureDepthM(Number(checked.values.pressurePa), Number(checked.values.surfacePressurePa), Number(checked.values.waterDensityKgM3))
              velocity = nextVelocity; last = checked; signature = encoded
            }
          }
        }
      }
      const ageS = last ? Math.max(0, (nowMs - last.capturedAtMs) / 1000) : 0
      const elapsedS = last ? (nowMs - initializedAt) / 1000 : 0
      // Conservative modeled velocity bias (2mm/s), random velocity noise and heading drift allowance.
      const horizontalVariance = 0.0025 + (0.002 * elapsedS) ** 2 + distanceM * 0.0004 + elapsedS * 0.00001
      if (horizontalVariance > 1) fault ||= 'subsea-dead-reckoning-drift-limit'
      out.health.localPosition = !!last && !fault
      out.health.pressureHeight = pressureHealthy && !!last
      out.health.absoluteHeading = false
      out.health.navigation = false
      out.quality = [...base.quality.filter(q => !['gnss-unhealthy', 'gnss-stale', 'missing', 'no-inertial-position-fusion'].includes(q)), 'subsea-pressure-dvl-dead-reckoning', 'surface-origin-initial-alignment-assumed', 'capture-attitude-history', 'modeled-dvl-velocity-sigma-0.02mps', 'modeled-dvl-bias-0.002mps', ...(fault ? [fault] : last ? [] : ['subsea-navigation-aligning'])]
      out.localPosition = last ? { frame: 'LOCAL_NED', altitudeDatum: 'LOCAL_WATER_SURFACE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, positionM: position.map((n, i) => n + velocity[i]! * ageS), velocityMps: [...velocity], covarianceBlocks: [0, 1, 2].map(i => ({ positionM2: i < 2 ? horizontalVariance : 0.0001 + (ageS * 0.02) ** 2, positionVelocityM2S: 0, velocityM2S2: 0.0004 })), capturedAtMs: last.capturedAtMs, predictedToMs: nowMs } : null
      out.pressureHeight = last && pressure ? { frame: 'PRESSURE_RELATIVE_INITIAL', downM: pressure.depth, referencePa: 101325, capturedAtMs: pressure.at, varianceM2: 0.0001 } : null
      if (fault) out.events = [...base.events, { atMs: nowMs, reason: fault }].slice(-20)
      return out
    },
  }
}
