import type { SensorVector } from '../../sensors/types'
import type { VehicleActuator } from '../types'

export interface SubseaWrench { forceN: SensorVector, torqueNm: SensorVector }
/** Fictional symmetric BODY_FRD layout. Four vectored horizontals and four verticals. */
export const subseaThrusters: VehicleActuator[] = [...Array(8).keys()].map(i => ({ name: `thruster-${i + 1}`, unit: 'newton', min: -15, max: 15, neutral: 0 }))
const h = Math.SQRT1_2
// Rows are Fx,Fy,Fz,Mx,My,Mz. Moment is lever arm cross thrust direction.
const matrix = [
  [h, h, h, h, 0, 0, 0, 0],
  [-h, h, h, -h, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 1, 1, 1],
  [0, 0, 0, 0, 0.2, -0.2, 0.2, -0.2],
  [0, 0, 0, 0, -0.3, -0.3, 0.3, 0.3],
  [-0.5 * h, 0.5 * h, -0.5 * h, 0.5 * h, 0, 0, 0, 0],
]
function vector(v: unknown): v is SensorVector { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) }
function fromSix(v: number[]): SubseaWrench { return { forceN: v.slice(0, 3) as SensorVector, torqueNm: v.slice(3) as SensorVector } }
export function subseaWrenchFromThrusters(thrustersN: number[]): SubseaWrench {
  if (!Array.isArray(thrustersN) || thrustersN.length !== 8 || thrustersN.some(n => !Number.isFinite(n) || Math.abs(n) > 15 + 1e-10)) throw new RangeError('Invalid subsea thruster force')
  return fromSix(matrix.map(row => row.reduce((sum, n, i) => sum + n * thrustersN[i]!, 0)))
}
/** Full-rank minimum-norm allocation. Common scaling retains all six wrench ratios. */
export function allocateSubseaWrench(wrench: SubseaWrench) {
  if (!wrench || !vector(wrench.forceN) || !vector(wrench.torqueNm) || [...wrench.forceN, ...wrench.torqueNm].some(n => Math.abs(n) > 10000)) throw new RangeError('Invalid requested subsea wrench')
  const desired = [...wrench.forceN, ...wrench.torqueNm]
  // This layout's six rows are mutually orthogonal: A+ = A^T (A A^T)^-1.
  const unconstrained = [...Array(8).keys()].map(i => matrix.reduce((sum, row, j) => sum + row[i]! * desired[j]! / row.reduce((s, n) => s + n * n, 0), 0))
  const scale = Math.min(1, 15 / Math.max(...unconstrained.map(Math.abs), 1e-12))
  const thrustersN = unconstrained.map(n => n * scale), achievedWrench = subseaWrenchFromThrusters(thrustersN)
  return { thrustersN, requestedWrench: structuredClone(wrench), achievedWrench, residualWrench: fromSix(desired.map((n, i) => n - [...achievedWrench.forceN, ...achievedWrench.torqueNm][i]!)), scale }
}
