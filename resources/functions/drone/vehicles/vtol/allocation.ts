import type { Motors, Wrench } from '../../controls/model'
import { validVector } from '../../controls/model'
import { vtolModel as model } from './plant'
import { numericPacket } from './packets'

/** Front-left, front-right, rear-right, rear-left; BODY_FRD moments. */
export function allocateVtolLift(wrench: Wrench) {
  if (!wrench || !Array.isArray(wrench.torqueNm)) throw new RangeError('Invalid VTOL lift wrench')
  const thrustN = wrench.thrustN, torqueNm = numericPacket(wrench.torqueNm, 3)
  if (!Number.isFinite(thrustN) || !validVector(torqueNm)) throw new RangeError('Invalid VTOL lift wrench')
  const t = Math.max(0, Math.min(model.maxRotorThrustN, thrustN / 4)), r = torqueNm[0] / (4 * model.rotorArmProjectionM), p = torqueNm[1] / (4 * model.rotorArmProjectionM), y = torqueNm[2] / (4 * model.reactionTorqueM)
  function addWithinBounds(base: number[], differential: number[]) {
    let scale = 1
    for (let i = 0; i < 4; i++) {
      const change = differential[i]!
      if (change > 0) scale = Math.min(scale, (model.maxRotorThrustN - base[i]!) / change)
      else if (change < 0) scale = Math.min(scale, -base[i]! / change)
    }
    return base.map((n, i) => Math.max(0, Math.min(model.maxRotorThrustN, n + scale * differential[i]!)))
  }
  // Preserve collective first, then the roll/pitch vector, then yaw. Report the achieved wrench for anti-windup.
  const rollPitch = addWithinBounds([t, t, t, t], [r + p, -r + p, -r - p, r - p])
  const rotorsN = addWithinBounds(rollPitch, [y, -y, y, -y]) as Motors
  const [a, b, c, d] = rotorsN
  const achieved: Wrench = { thrustN: a + b + c + d, torqueNm: [model.rotorArmProjectionM * (a - b - c + d), model.rotorArmProjectionM * (a + b - c - d), model.reactionTorqueM * (a - b + c - d)] }
  const limited = Math.abs(achieved.thrustN - thrustN) > 1e-9 || achieved.torqueNm.some((n, i) => Math.abs(n - torqueNm[i]!) > 1e-9)
  return { rotorsN, achieved, limited }
}
