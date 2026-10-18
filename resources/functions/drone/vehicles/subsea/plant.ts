import type { SensorVector } from '../../sensors/types'
import type { Quaternion } from '../../estimation/frames'
import type { VehicleEnvironment, VehiclePlant, VehiclePlantState } from '../types'
import { rotateBodyToNed, rotateNedToBody } from '../../controls/physics'
import { multiplyQuaternion, normalizeQuaternion } from '../../estimation/frames'
import { subseaWrenchFromThrusters } from './allocation'

/** Fictional positively buoyant hull, not measured BlueROV coefficients. Uniform-current fixture. */
export const subseaModel = Object.freeze({ massKg: 20, addedMassKg: 5, gravityMps2: 9.80665, excessBuoyancyN: 2, buoyancyOffsetM: 0.03, inertiaKgM2: Object.freeze([1.2, 1.5, 1.8] as const), linearDragNsM: Object.freeze([8, 10, 12] as const), quadraticDragNs2M2: Object.freeze([12, 15, 18] as const), angularDragNms: Object.freeze([3, 3, 2] as const), tetherSlackM: 8, tetherStiffnessNM: 30, tetherDampingNsM: 8, seabedDepthM: 10 })
function vector(v: unknown): v is SensorVector { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) }
function cross(a: SensorVector, b: SensorVector): SensorVector { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
export function createSubseaPlant(initial: { positionM?: SensorVector, velocityMps?: SensorVector, quaternionWxyz?: Quaternion, angularRateRadS?: SensorVector } = {}): VehiclePlant {
  if (initial.quaternionWxyz !== undefined && (!Array.isArray(initial.quaternionWxyz) || initial.quaternionWxyz.length !== 4 || !initial.quaternionWxyz.every(Number.isFinite))) throw new RangeError('Invalid initial subsea quaternion')
  let positionM = [...(initial.positionM ?? [0, 0, 0])] as SensorVector, velocityMps = [...(initial.velocityMps ?? [0, 0, 0])] as SensorVector
  let quaternionWxyz = normalizeQuaternion([...(initial.quaternionWxyz ?? [1, 0, 0, 0])]), angularRateRadS = [...(initial.angularRateRadS ?? [0, 0, 0])] as SensorVector, accelerationMps2: SensorVector = [0, 0, 0]
  if (![positionM, velocityMps, angularRateRadS].every(vector) || positionM[2] < 0 || positionM[2] > 10 || Math.hypot(...positionM) > 20 || Math.hypot(...velocityMps) > 5 || Math.hypot(...angularRateRadS) > 5) throw new RangeError('Invalid initial subsea state')
  let tensionN = 0, powerW = 8
  function snapshot(): VehiclePlantState {
    return structuredClone({ positionM, velocityMps, accelerationMps2, quaternionWxyz, angularRateRadS, onSurface: positionM[2] <= 0.02, details: { depthM: positionM[2], tetherLengthM: Math.hypot(...positionM), tetherTensionN: tensionN, bottomRangeM: Math.max(0, subseaModel.seabedDepthM - positionM[2]), structureRangeM: Math.max(0, 6 - positionM[0]), leak: false, linkConnected: true, dvlLocked: true, powerW } })
  }
  return { snapshot, step(actuators: number[], dtS: number, environment: VehicleEnvironment) {
    const wrench = subseaWrenchFromThrusters(actuators)
    if (!Number.isFinite(dtS) || dtS <= 0 || dtS > 0.02 || !environment || !vector(environment.currentMps) || !vector(environment.windMps) || [...environment.currentMps, ...environment.windMps].some(n => Math.abs(n) > 5)) throw new RangeError('Invalid subsea plant step')
    const relative = rotateNedToBody(quaternionWxyz, velocityMps.map((n, i) => n - environment.currentMps[i]!) as SensorVector)
    const drag = relative.map((n, i) => -subseaModel.linearDragNsM[i]! * n - subseaModel.quadraticDragNs2M2[i]! * n * Math.abs(n)) as SensorVector
    const forceNed = rotateBodyToNed(quaternionWxyz, wrench.forceN.map((n, i) => n + drag[i]!) as SensorVector)
    const lengthM = Math.hypot(...positionM), radialSpeed = lengthM > 1e-9 ? positionM.reduce((s, n, i) => s + n * velocityMps[i]!, 0) / lengthM : 0
    tensionN = lengthM > subseaModel.tetherSlackM ? Math.max(0, (lengthM - subseaModel.tetherSlackM) * subseaModel.tetherStiffnessNM + radialSpeed * subseaModel.tetherDampingNsM) : 0
    accelerationMps2 = forceNed.map((n, i) => (n - (i === 2 ? subseaModel.excessBuoyancyN : 0) - (lengthM > 1e-9 ? tensionN * positionM[i]! / lengthM : 0)) / (subseaModel.massKg + subseaModel.addedMassKg)) as SensorVector
    const buoyancyBody = rotateNedToBody(quaternionWxyz, [0, 0, -(subseaModel.massKg * subseaModel.gravityMps2 + subseaModel.excessBuoyancyN)])
    const restoring = cross([0, 0, -subseaModel.buoyancyOffsetM], buoyancyBody)
    const momentum = angularRateRadS.map((n, i) => n * subseaModel.inertiaKgM2[i]!) as SensorVector
    const gyroscopic = cross(angularRateRadS, momentum)
    angularRateRadS = angularRateRadS.map((n, i) => n + dtS * (wrench.torqueNm[i]! + restoring[i]! - subseaModel.angularDragNms[i]! * n - 0.5 * n * Math.abs(n) - gyroscopic[i]!) / subseaModel.inertiaKgM2[i]!) as SensorVector
    const angle = Math.hypot(...angularRateRadS) * dtS, scale = angle < 1e-10 ? dtS / 2 : Math.sin(angle / 2) * dtS / angle
    quaternionWxyz = normalizeQuaternion(multiplyQuaternion(quaternionWxyz, [Math.cos(angle / 2), angularRateRadS[0] * scale, angularRateRadS[1] * scale, angularRateRadS[2] * scale]))
    velocityMps = velocityMps.map((n, i) => n + dtS * accelerationMps2[i]!) as SensorVector
    positionM = positionM.map((n, i) => n + dtS * velocityMps[i]!) as SensorVector
    if (positionM[2] < 0) { positionM[2] = 0; velocityMps[2] = Math.max(0, velocityMps[2]); accelerationMps2[2] = Math.max(0, accelerationMps2[2]) }
    if (positionM[2] > subseaModel.seabedDepthM) { positionM[2] = subseaModel.seabedDepthM; velocityMps[2] = Math.min(0, velocityMps[2]); accelerationMps2[2] = Math.min(0, accelerationMps2[2]) }
    powerW = 8 + actuators.reduce((s, n) => s + Math.abs(n) ** 1.5 * 0.8, 0)
    if (![...positionM, ...velocityMps, ...angularRateRadS].every(Number.isFinite) || Math.hypot(...velocityMps) > 10 || Math.hypot(...angularRateRadS) > 20) throw new RangeError('Subsea physics diverged')
    return snapshot()
  } }
}
