import type { SensorVector } from '../sensors/types'
export type Motors = [number, number, number, number]
export interface Wrench { thrustN: number, torqueNm: SensorVector }
/** Invented, fixed simulation vehicle. No hardware calibration or airframe profile is claimed. */
export const multirotorModel = Object.freeze({ massKg: 1.5, gravityMps2: 9.80665, inertiaKgM2: Object.freeze([0.03, 0.03, 0.05]), armProjectionM: 0.16, reactionTorqueM: 0.02, maxMotorThrustN: 10, motorSlewNPerS: 40, motorTimeConstantS: 0.04, linearDragKgPerS: 0.4, angularDragNms: 0.01 })
export const validVector = (v: unknown): v is SensorVector => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6)
export const clampControl = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n))
