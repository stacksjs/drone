import type { VehiclePlant, VehiclePlantState } from '../types'
export const surfaceHull = { massKg: 30, yawInertiaKgM2: 8, linearDragNsM: 30, yawDragNms: 8, maxForceN: 50, maxYawMomentNm: 12, hullRadiusM: 0.45 } as const
export function createSurfacePlant(): VehiclePlant {
  let n = 0, e = 0, vn = 0, ve = 0, yaw = 0, rate = 0, an = 0, ae = 0
  function snapshot(): VehiclePlantState { return { positionM: [n, e, 0], velocityMps: [vn, ve, 0], accelerationMps2: [an, ae, 0], quaternionWxyz: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], angularRateRadS: [0, 0, rate], onSurface: true, details: { surgeMps: vn * Math.cos(yaw) + ve * Math.sin(yaw), swayMps: -vn * Math.sin(yaw) + ve * Math.cos(yaw) } } }
  return { snapshot, step(output, dt, env) {
    if (output.length !== 3 || output.some(v => !Number.isFinite(v) || Math.abs(v) > 1) || !Number.isFinite(dt) || dt <= 0 || dt > 0.02 || [env.currentMps, env.windMps].some(v => v.length !== 3 || v.some(x => !Number.isFinite(x) || Math.abs(x) > 30))) throw new RangeError('Invalid surface actuator, environment or plant timestep')
    const c = Math.cos(yaw), s = Math.sin(yaw), fx = output[0]! * surfaceHull.maxForceN, fy = output[1]! * surfaceHull.maxForceN
    // Linear current-relative hydrodynamic drag and weak wind-relative drag, planar calm water.
    an = (fx * c - fy * s - surfaceHull.linearDragNsM * (vn - env.currentMps[0]) + 0.2 * (env.windMps[0] - vn)) / surfaceHull.massKg
    ae = (fx * s + fy * c - surfaceHull.linearDragNsM * (ve - env.currentMps[1]) + 0.2 * (env.windMps[1] - ve)) / surfaceHull.massKg
    rate += (output[2]! * surfaceHull.maxYawMomentNm - surfaceHull.yawDragNms * rate) / surfaceHull.yawInertiaKgM2 * dt
    vn += an * dt; ve += ae * dt; n += vn * dt; e += ve * dt; yaw += rate * dt
    return snapshot()
  } }
}
