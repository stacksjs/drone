import type { SensorVector } from '../sensors/types'
import type { Quaternion } from '../estimation/frames'
import type { Motors } from './model'
import { multiplyQuaternion, normalizeQuaternion } from '../estimation/frames'
import { multirotorModel as model, validVector } from './model'
import { quadXWrench } from './allocation'
export function rotateBodyToNed(q: Quaternion, v: SensorVector): SensorVector {
  const [w, x, y, z] = q
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])]
  return [v[0] + w * t[0]! + y * t[2]! - z * t[1]!, v[1] + w * t[1]! + z * t[0]! - x * t[2]!, v[2] + w * t[2]! + x * t[1]! - y * t[0]!]
}
export const rotateNedToBody = (q: Quaternion, v: SensorVector) => rotateBodyToNed([q[0], -q[1], -q[2], -q[3]], v)
export function createRigidBody(input: { positionM?: SensorVector, motorsN?: Motors, groundDownM?: number, groundGradient?: [number, number] } = {}) {
  const groundDownM = input.groundDownM ?? 0
  const groundGradient = input.groundGradient ?? [0, 0]
  if (!Array.isArray(groundGradient) || groundGradient.length !== 2 || !groundGradient.every(Number.isFinite) || Math.hypot(...groundGradient) > 0.1) throw new RangeError('Invalid modeled ground gradient')
  if (!Number.isFinite(groundDownM) || groundDownM < -1 || groundDownM > 0) throw new RangeError('Invalid modeled ground contact plane')
  let positionM = [...(input.positionM ?? [0, 0, -1])] as SensorVector
  let motorsN = [...(input.motorsN ?? [0, 0, 0, 0])] as Motors
  if (!validVector(positionM)) throw new RangeError('Invalid physics initial position')
  quadXWrench(motorsN)
  let velocityMps: SensorVector = [0, 0, 0], angularRateRadS: SensorVector = [0, 0, 0], accelerationMps2: SensorVector = [0, 0, 0]
  let quaternionWxyz: Quaternion = [1, 0, 0, 0], groundContact = false
  function snapshot() { return structuredClone({ positionM, velocityMps, angularRateRadS, accelerationMps2, quaternionWxyz, motorsN, groundContact }) }
  return {
    snapshot,
    step(command: Motors, dtS: number, disturbance: { windMps?: SensorVector, forceN?: SensorVector, torqueNm?: SensorVector } = {}) {
      quadXWrench(command)
      const wind = disturbance.windMps ?? [0, 0, 0], force = disturbance.forceN ?? [0, 0, 0], torque = disturbance.torqueNm ?? [0, 0, 0]
      if (!Number.isFinite(dtS) || dtS <= 0 || dtS > 0.01 || ![wind, force, torque].every(validVector)) throw new RangeError('Invalid physics step or disturbance')
      motorsN = motorsN.map((n, i) => n + (command[i]! - n) * (1 - Math.exp(-dtS / model.motorTimeConstantS))) as Motors
      const wrench = quadXWrench(motorsN)
      const momentum = angularRateRadS.map((n, i) => n * model.inertiaKgM2[i]!)
      const cross = [angularRateRadS[1] * momentum[2]! - angularRateRadS[2] * momentum[1]!, angularRateRadS[2] * momentum[0]! - angularRateRadS[0] * momentum[2]!, angularRateRadS[0] * momentum[1]! - angularRateRadS[1] * momentum[0]!]
      angularRateRadS = angularRateRadS.map((n, i) => n + dtS * (wrench.torqueNm[i]! + torque[i]! - cross[i]! - model.angularDragNms * n) / model.inertiaKgM2[i]!) as SensorVector
      const angle = Math.hypot(...angularRateRadS) * dtS, scale = angle < 1e-10 ? dtS / 2 : Math.sin(angle / 2) * dtS / angle
      quaternionWxyz = normalizeQuaternion(multiplyQuaternion(quaternionWxyz, [Math.cos(angle / 2), angularRateRadS[0] * scale, angularRateRadS[1] * scale, angularRateRadS[2] * scale]))
      const thrust = rotateBodyToNed(quaternionWxyz, [0, 0, -wrench.thrustN])
      accelerationMps2 = thrust.map((n, i) => (n + force[i]! - model.linearDragKgPerS * (velocityMps[i]! - wind[i]!)) / model.massKg + (i === 2 ? model.gravityMps2 : 0)) as SensorVector
      velocityMps = velocityMps.map((n, i) => n + accelerationMps2[i]! * dtS) as SensorVector
      positionM = positionM.map((n, i) => n + velocityMps[i]! * dtS) as SensorVector
      const contactDownM = groundDownM + groundGradient[0]! * positionM[0] + groundGradient[1]! * positionM[1]
      groundContact = positionM[2] >= contactDownM
      if (groundContact) { positionM[2] = contactDownM; if (velocityMps[2] > 0) velocityMps[2] = 0; accelerationMps2[2] = 0 }
      if (![...positionM, ...velocityMps, ...angularRateRadS].every(Number.isFinite)) throw new RangeError('Physics model diverged')
      return snapshot()
    },
  }
}
export type RigidBodyState = ReturnType<ReturnType<typeof createRigidBody>['snapshot']>
