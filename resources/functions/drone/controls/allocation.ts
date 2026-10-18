import type { Motors, Wrench } from './model'
import { multirotorModel as model, validVector } from './model'
/** Motors: front-right, rear-right, rear-left, front-left. Reaction-yaw signs +,-,+,-. */
export function quadXWrench(motors: Motors): Wrench {
  if (motors.length !== 4 || !motors.every(n => Number.isFinite(n) && n >= 0 && n <= model.maxMotorThrustN)) throw new RangeError('Invalid simulated motor thrust')
  const [a, b, c, d] = motors
  return { thrustN: a + b + c + d, torqueNm: [model.armProjectionM * (-a - b + c + d), model.armProjectionM * (a - b - c + d), model.reactionTorqueM * (a - b + c - d)] }
}
export function allocateQuadX(wrench: Wrench, previous: Motors, dtS: number, enabled = true) {
  if (!enabled) return { motorsN: [0, 0, 0, 0] as Motors, achieved: quadXWrench([0, 0, 0, 0]), limited: false }
  quadXWrench(previous)
  if (!Number.isFinite(wrench.thrustN) || !validVector(wrench.torqueNm) || !Number.isFinite(dtS) || dtS <= 0 || dtS > 0.1) throw new RangeError('Invalid allocation input or interval')
  const t = wrench.thrustN / 4, r = wrench.torqueNm[0] / (4 * model.armProjectionM), p = wrench.torqueNm[1] / (4 * model.armProjectionM), y = wrench.torqueNm[2] / (4 * model.reactionTorqueM)
  const raw = [t - r + p + y, t - r - p - y, t + r - p + y, t + r + p - y]
  const motorsN = raw.map((n, i) => Math.max(0, Math.min(model.maxMotorThrustN, Math.max(previous[i]! - model.motorSlewNPerS * dtS, Math.min(previous[i]! + model.motorSlewNPerS * dtS, n))))) as Motors
  return { motorsN, achieved: quadXWrench(motorsN), limited: motorsN.some((n, i) => Math.abs(n - raw[i]!) > 1e-9) }
}
