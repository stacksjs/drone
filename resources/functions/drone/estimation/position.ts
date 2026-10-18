/** Three independent [position, velocity] constant-velocity Kalman blocks. Not an INS/EKF. */
export interface AxisState { p: number, v: number, pp: number, pv: number, vv: number }
export function predictAxis(s: AxisState, dt: number): AxisState {
  const q = 4 // Assumed unmodelled acceleration variance, (m/s²)².
  return { p: s.p + dt * s.v, v: s.v, pp: s.pp + 2 * dt * s.pv + dt * dt * s.vv + q * dt ** 4 / 4, pv: s.pv + dt * s.vv + q * dt ** 3 / 2, vv: s.vv + q * dt * dt }
}
export function correctAxis(s: AxisState, p: number, v: number, rp: number, rv: number): AxisState {
  const sp = s.pp + rp, kp = s.pp / sp, kv = s.pv / sp
  const pos = s.p + kp * (p - s.p), vel = s.v + kv * (p - s.p)
  const pp = s.pp * rp / sp, pv = s.pv * rp / sp, vv = Math.max(1e-12, s.vv - s.pv ** 2 / sp)
  const sv = vv + rv
  return { p: pos + pv / sv * (v - vel), v: vel + vv / sv * (v - vel), pp: Math.max(1e-12, pp - pv ** 2 / sv), pv: pv * rv / sv, vv: vv * rv / sv }
}
