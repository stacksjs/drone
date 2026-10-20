import type { Quaternion } from '../estimation/frames'
import type { SensorVector } from '../sensors/types'
import type { CinemaEncoder, CinemaMotion, CinemaPlantRow } from './types'
import { multiplyQuaternion, normalizeQuaternion, quaternionEuler } from '../estimation/frames'

export const neutralOptical: Quaternion = [0.5, 0.5, 0.5, 0.5]
const travel = [20, 45, 45].map(n => n * Math.PI / 180)
const copy = (v: SensorVector): SensorVector => [...v]
const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n))
export function withinCinemaTravel(v: SensorVector): boolean {
  return v.every((n, i) => Number.isFinite(n) && Math.abs(n) <= travel[i]!)
}
function axisQuaternion(axis: number, angle: number): Quaternion { const q: Quaternion = [Math.cos(angle / 2), 0, 0, 0]; q[axis + 1] = Math.sin(angle / 2); return q }
export function cinemaJointQuaternion(joints: SensorVector): Quaternion { return normalizeQuaternion(multiplyQuaternion(multiplyQuaternion(axisQuaternion(2, joints[2]), axisQuaternion(1, joints[1])), axisQuaternion(0, joints[0]))) }
export function cinemaOffset(atMs: number): number {
  const smooth = (u: number) => 35 * u ** 4 - 84 * u ** 5 + 70 * u ** 6 - 20 * u ** 7
  const fraction = atMs <= 0 ? 0 : atMs <= 3000 ? smooth(atMs / 3000) : atMs < 6000 ? 1 - smooth((atMs - 3000) / 3000) : 0
  return 8 * Math.PI / 180 * fraction
}
export function cinemaGoal(position: SensorVector, body: Quaternion, target: SensorVector, offset: number): SensorVector | null {
  const d = target.map((n, i) => n - position[i]!) as SensorVector
  const distance = Math.hypot(...d), horizontal = Math.hypot(d[0], d[1])
  if (!d.every(Number.isFinite) || distance < 1 || distance > 10 || horizontal < 1 || Math.abs(Math.hypot(...body) - 1) > 1e-6) return null
  const look = multiplyQuaternion(multiplyQuaternion(axisQuaternion(2, Math.atan2(d[1], d[0])), axisQuaternion(1, -Math.atan2(d[2], horizontal))), neutralOptical)
  const desired = multiplyQuaternion(axisQuaternion(2, offset), look)
  const inverseBody: Quaternion = [body[0], -body[1], -body[2], -body[3]]
  const inverseNeutral: Quaternion = [0.5, -0.5, -0.5, -0.5]
  const relative = normalizeQuaternion(multiplyQuaternion(multiplyQuaternion(inverseBody, desired), inverseNeutral))
  const angles = quaternionEuler(relative)
  return angles.every(Number.isFinite) && Math.abs(Math.cos(angles[1])) > 1e-6 ? angles : null
}
function substep(old: CinemaPlantRow, requested: SensorVector, requestedAtMs: number): CinemaPlantRow {
  const applied = old.appliedTorqueNm.map((n, i) => n + clamp(requested[i]! - n, 0.02 * 0.004)) as SensorVector
  const acceleration = applied.map((n, i) => (n - 0.01 * old.velocityRadS[i]!) / 0.01) as SensorVector
  const velocity = old.velocityRadS.map((n, i) => n + 0.004 * acceleration[i]!) as SensorVector
  const position = old.positionRad.map((n, i) => n + 0.004 * velocity[i]!) as SensorVector
  if (!position.every(n => Number.isFinite(n) && Math.abs(n) <= 8)) throw new RangeError('cinema-unqualified-result')
  return { atMs: old.atMs + 4, requestedAtMs, requestedTorqueNm: copy(requested), appliedTorqueNm: applied, positionRad: position, velocityRadS: velocity, accelerationRadS2: acceleration }
}
/** Private owned relative-joint fixture. No physical output or injectable source. */
export function createCinemaGimbal() {
  const rows: CinemaPlantRow[] = [{ atMs: 0, requestedAtMs: 0, requestedTorqueNm: [0, 0, 0], appliedTorqueNm: [0, 0, 0], positionRad: [0, 0, 0], velocityRadS: [0, 0, 0], accelerationRadS2: [0, 0, 0] }]
  let requested: SensorVector = [0, 0, 0], requestedAtMs = 0, lastRender: number | null = null, previousEncoder: CinemaEncoder | null = null, retired = false
  return {
    rows,
    current() { return structuredClone(rows[rows.length - 1]!) },
    render(nowMs: number): CinemaEncoder {
      if (retired || !Number.isSafeInteger(nowMs) || nowMs > 45000 || (lastRender === null ? nowMs !== 600 : nowMs !== lastRender + 20)) throw new RangeError('cinema-unqualified-result')
      while (rows[rows.length - 1]!.atMs < nowMs) { if (rows.length >= 11251) throw new RangeError('cinema-unqualified-result'); rows.push(substep(rows[rows.length - 1]!, requested, requestedAtMs)) }
      lastRender = nowMs
      const captured = rows[(nowMs - 20) / 4]!
      const position = captured.positionRad.map(n => Math.round(n / 0.001) * 0.001) as SensorVector
      const packet: CinemaEncoder = { sequence: previousEncoder ? previousEncoder.sequence + 1 : 1, capturedAtMs: nowMs - 20, receivedAtMs: nowMs, positionRad: position, velocityRadS: previousEncoder ? position.map((n, i) => (n - previousEncoder!.positionRad[i]!) / 0.020) as SensorVector : null, limitSwitch: !withinCinemaTravel(captured.positionRad) }
      previousEncoder = structuredClone(packet)
      return packet
    },
    command(goal: SensorVector, measured: CinemaEncoder, nowMs: number) {
      if (retired || nowMs !== lastRender || !measured.velocityRadS) throw new RangeError('cinema-unqualified-result')
      requested = goal.map((n, i) => clamp(0.12 * (n - measured.positionRad[i]!) - 0.04 * measured.velocityRadS![i]!, 0.02)) as SensorVector
      requestedAtMs = nowMs
    },
    retire(nowMs: number): void {
      if (retired || nowMs !== lastRender) throw new RangeError('cinema-unqualified-result')
      retired = true; requested = [0, 0, 0]; requestedAtMs = nowMs
    },
    tail(): CinemaPlantRow[] {
      if (!retired) throw new RangeError('cinema-unqualified-result')
      const boundary = structuredClone(rows[rows.length - 1]!)
      const tail: CinemaPlantRow[] = [{ ...boundary, requestedAtMs, requestedTorqueNm: [0, 0, 0] }]
      for (let i = 0; i < 500; i++) tail.push(substep(tail[tail.length - 1]!, requested, requestedAtMs))
      return tail
    },
  }
}
export function evaluateCinemaMotion(rows: CinemaPlantRow[], tail: CinemaPlantRow[]): CinemaMotion {
  const all = [...rows, ...tail.slice(1)]
  let rate = 0, acceleration = 0, jerk = 0, torque = 0, slew = 0, mechanical = true
  for (let index = 0; index < all.length; index++) {
    const row = all[index]!
    rate = Math.max(rate, ...row.velocityRadS.map(Math.abs)); acceleration = Math.max(acceleration, ...row.accelerationRadS2.map(Math.abs)); torque = Math.max(torque, ...row.appliedTorqueNm.map(Math.abs))
    mechanical = mechanical && withinCinemaTravel(row.positionRad)
    if (index === 0) continue
    const previous = all[index - 1]!
    if (row.atMs !== previous.atMs + 4) throw new RangeError('cinema-unqualified-result')
    jerk = Math.max(jerk, ...row.accelerationRadS2.map((n, i) => Math.abs((n - previous.accelerationRadS2[i]!) / 0.004)))
    slew = Math.max(slew, ...row.appliedTorqueNm.map((n, i) => Math.abs((n - previous.appliedTorqueNm[i]!) / 0.004)))
  }
  return { rows: rows.length, tailRows: 501, maxRateRadS: rate, maxAccelerationRadS2: acceleration, maxJerkRadS3: jerk, maxAppliedTorqueNm: torque, maxTorqueSlewNmS: slew, withinDynamicBounds: rate <= 2 + 1e-9 && acceleration <= 4 + 1e-9 && jerk <= 6 + 1e-9 && torque <= 0.02 + 1e-9 && slew <= 0.02 + 1e-9, withinMechanicalBounds: mechanical }
}
