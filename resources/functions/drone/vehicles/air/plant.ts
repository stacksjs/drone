import type { SensorVector } from '../../sensors/types'
import type { Quaternion } from '../../estimation/frames'
import type { VehicleEnvironment, VehiclePlant, VehiclePlantState } from '../types'
import { multiplyQuaternion, normalizeQuaternion } from '../../estimation/frames'
import { rotateBodyToNed, rotateNedToBody } from '../../controls/physics'

/** Fictional 2 kg trainer, experimentally unqualified. BODY_FRD forces and moments. */
export const airModel = Object.freeze({ massKg: 2, gravityMps2: 9.80665, densityKgM3: 1.225, areaM2: 0.8, spanM: 2.4, chordM: 0.333, inertiaKgM2: [0.18, 0.25, 0.35] as const, maxThrustN: 14, stallAlphaRad: 0.28, cruiseMps: 13, rotationMps: 10, minimumMps: 8, maximumMps: 25 })
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const validVector = (v: unknown): v is SensorVector => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
export function validateAirActuators(a: number[]) {
  if (!Array.isArray(a) || a.length !== 5 || !a.every(Number.isFinite) || a[0]! < 0 || a[0]! > 1 || a.slice(1, 4).some(n => Math.abs(n) > 0.4) || a[4]! < 0 || a[4]! > 1) throw new RangeError('Invalid fixed-wing throttle, aileron, elevator, rudder or wheel brake')
}
/** Quasi-steady lift/drag and rate-damped surface moments. Not firmware coefficients. */
export function airAerodynamics(relativeBodyMps: SensorVector, rateRadS: SensorVector, actuators: number[]) {
  if (!validVector(relativeBodyMps) || !validVector(rateRadS)) throw new RangeError('Invalid aerodynamic vector')
  validateAirActuators(actuators)
  const [u, v, w] = relativeBodyMps
  const speedMps = Math.hypot(u, v, w), alphaRad = Math.atan2(w, Math.max(0.1, u)), betaRad = Math.atan2(v, Math.hypot(u, w))
  const dynamicPressurePa = 0.5 * airModel.densityKgM3 * speedMps ** 2
  const linearLift = 0.25 + 4.8 * alphaRad
  // Bounded post-stall loss, retaining drag. No claim of dynamic stall or spin modeling.
  const liftCoefficient = clamp(linearLift, -1.1, 1.4) * Math.max(0.15, 1 - Math.max(0, Math.abs(alphaRad) - airModel.stallAlphaRad) * 2.5)
  const dragCoefficient = 0.04 + 0.06 * liftCoefficient ** 2 + 0.8 * Math.sin(alphaRad) ** 2 + 0.2 * Math.sin(betaRad) ** 2
  const lift = dynamicPressurePa * airModel.areaM2 * liftCoefficient, drag = dynamicPressurePa * airModel.areaM2 * dragCoefficient
  const ca = Math.cos(alphaRad), sa = Math.sin(alphaRad)
  const forceN: SensorVector = [actuators[0]! * airModel.maxThrustN - drag * ca + lift * sa, -dynamicPressurePa * airModel.areaM2 * 0.6 * betaRad, -drag * sa - lift * ca]
  const rateScale = Math.max(1, speedMps)
  const torqueNm: SensorVector = [
    dynamicPressurePa * airModel.areaM2 * airModel.spanM * (0.12 * actuators[1]! - 0.3 * rateRadS[0] * airModel.spanM / (2 * rateScale)),
    dynamicPressurePa * airModel.areaM2 * airModel.chordM * (0.8 * actuators[2]! - 0.15 * alphaRad - 2 * rateRadS[1] * airModel.chordM / (2 * rateScale)),
    dynamicPressurePa * airModel.areaM2 * airModel.spanM * (0.08 * actuators[3]! + 0.12 * betaRad - 0.25 * rateRadS[2] * airModel.spanM / (2 * rateScale)),
  ]
  return { forceN, torqueNm, speedMps, alphaRad, betaRad, liftCoefficient, dragCoefficient, dynamicPressurePa, stalled: Math.abs(alphaRad) > airModel.stallAlphaRad }
}
export function createAirPlant(initial: { positionM?: SensorVector, velocityMps?: SensorVector, quaternionWxyz?: Quaternion } = {}): VehiclePlant {
  let positionM = [...(initial.positionM ?? [0, 0, 0])] as SensorVector, velocityMps = [...(initial.velocityMps ?? [0, 0, 0])] as SensorVector
  let quaternionWxyz = normalizeQuaternion([...(initial.quaternionWxyz ?? [1, 0, 0, 0])]), angularRateRadS: SensorVector = [0, 0, 0], accelerationMps2: SensorVector = [0, 0, 0]
  if (!validVector(positionM) || !validVector(velocityMps) || positionM[2] > 0) throw new RangeError('Invalid initial fixed-wing state')
  let onSurface = positionM[2] === 0, details: VehiclePlantState['details'] = { airspeedMps: Math.hypot(...velocityMps), alphaRad: 0, stalled: false, powerW: 0 }
  function snapshot(): VehiclePlantState { return structuredClone({ positionM, velocityMps, accelerationMps2, quaternionWxyz, angularRateRadS, onSurface, details }) }
  return {
    snapshot,
    step(actuators: number[], dtS: number, environment: VehicleEnvironment) {
      validateAirActuators(actuators)
      if (!Number.isFinite(dtS) || dtS <= 0 || dtS > 0.01 || !validVector(environment.windMps) || !validVector(environment.currentMps)) throw new RangeError('Invalid air plant step')
      const relative = rotateNedToBody(quaternionWxyz, velocityMps.map((n, i) => n - environment.windMps[i]!) as SensorVector)
      const aero = airAerodynamics(relative, angularRateRadS, actuators)
      const momentum = angularRateRadS.map((n, i) => n * airModel.inertiaKgM2[i]!)
      const cross = [angularRateRadS[1] * momentum[2]! - angularRateRadS[2] * momentum[1]!, angularRateRadS[2] * momentum[0]! - angularRateRadS[0] * momentum[2]!, angularRateRadS[0] * momentum[1]! - angularRateRadS[1] * momentum[0]!]
      angularRateRadS = angularRateRadS.map((n, i) => n + dtS * (aero.torqueNm[i]! - cross[i]!) / airModel.inertiaKgM2[i]!) as SensorVector
      if (onSurface) { angularRateRadS[0] *= Math.exp(-dtS * 12); angularRateRadS[2] *= Math.exp(-dtS * 4) }
      const angle = Math.hypot(...angularRateRadS) * dtS, scale = angle < 1e-10 ? dtS / 2 : Math.sin(angle / 2) * dtS / angle
      quaternionWxyz = normalizeQuaternion(multiplyQuaternion(quaternionWxyz, [Math.cos(angle / 2), angularRateRadS[0] * scale, angularRateRadS[1] * scale, angularRateRadS[2] * scale]))
      const force = rotateBodyToNed(quaternionWxyz, aero.forceN)
      accelerationMps2 = force.map((n, i) => n / airModel.massKg + (i === 2 ? airModel.gravityMps2 : 0)) as SensorVector
      if (onSurface) {
        const rollingDeceleration = 0.5 + actuators[4]! * 7
        for (const i of [0, 1]) accelerationMps2[i] = accelerationMps2[i]! - Math.sign(velocityMps[i]!) * Math.min(Math.abs(velocityMps[i]!) / dtS, rollingDeceleration)
      }
      velocityMps = velocityMps.map((n, i) => n + accelerationMps2[i]! * dtS) as SensorVector
      positionM = positionM.map((n, i) => n + velocityMps[i]! * dtS) as SensorVector
      onSurface = positionM[2] >= 0
      if (onSurface) { positionM[2] = 0; velocityMps[2] = Math.min(0, velocityMps[2]); accelerationMps2[2] = 0 }
      details = { airspeedMps: aero.speedMps, alphaRad: aero.alphaRad, betaRad: aero.betaRad, stalled: aero.stalled, dynamicPressurePa: aero.dynamicPressurePa, powerW: actuators[0]! * 250 + 8 }
      if (![...positionM, ...velocityMps, ...angularRateRadS].every(Number.isFinite) || Math.hypot(...angularRateRadS) > 40) throw new RangeError('Fixed-wing model diverged')
      return snapshot()
    },
  }
}
