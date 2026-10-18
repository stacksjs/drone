import type { VehicleController, VehicleControllerContext, VehicleControlOutput } from '../types'
import { qualifySurfaceMeasurement } from './sensors'
import { surfaceHull } from './plant'
const clamp = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n))
export function createSurfaceController(): VehicleController {
  let reference: string | null = null, sequence = 0, signature = '', capture = -Infinity, now = -Infinity, latched = ''
  function result(c: VehicleControllerContext, actuators: number[], reason: string, inhibited: boolean): VehicleControlOutput { return { kind: 'simulated-vehicle-control', vehicle: 'surface', atMs: c.nowMs, actuators: [...actuators], inhibited, reason, physicalFlightEnabled: false, boardOutputsInhibited: true } }
  return { step(c) {
    if (!Number.isFinite(c.nowMs) || c.nowMs < now || now !== -Infinity && c.nowMs - now > 60) latched ||= 'surface-control-clock-gap'
    now = c.nowMs
    if (!c.enabled) return result(c, [0, 0, 0], latched || 'surface-authority-inhibited', true)
    if (latched) return result(c, [0, 0, 0], latched, true)
    const e = c.estimate, p = e.localPosition, a = e.attitude
    if (!e.health.tilt || !e.health.localPosition || !p || !a || e.evidence !== 'fixture' || !c.mission.targetM) return result(c, [0, 0, 0], 'surface-estimate-or-target-unavailable', true)
    try {
      const estimateReference = `${e.bootId}:${Object.values(e.resets).join(',')}`
      const fresh = (at: number | null | undefined, max: number) => at !== null && at !== undefined && Number.isFinite(at) && at <= c.nowMs && c.nowMs - at <= max
      if (e.nowMs !== c.nowMs || !fresh(a.capturedAtMs, 60) || !fresh(p.capturedAtMs, 200) || !fresh(p.predictedToMs, 40) || p.positionM.length !== 3 || p.velocityMps.length !== 3 || [...p.positionM, ...p.velocityMps, ...a.eulerRad].some(v => !Number.isFinite(v))) throw new Error('surface-estimate-epoch')
      const m = qualifySurfaceMeasurement(c.measurement, c.nowMs, estimateReference), encoded = JSON.stringify(m)
      if (reference !== null && reference !== estimateReference) throw new Error('surface-estimate-reference-changed')
      if (reference !== null && (m.sequence < sequence || m.sequence === sequence && encoded !== signature || m.sequence > sequence && m.capturedAtMs <= capture)) throw new Error('surface-sensor-replay')
      reference = m.reference; sequence = m.sequence; signature = encoded; capture = m.capturedAtMs
      const speed = Math.hypot(p.velocityMps[0]!, p.velocityMps[1]!), sensedSpeed = Number(m.values.speedMps)
      const clearance = Number(m.values.closestRangeM) - surfaceHull.hullRadiusM - 3 * Number(m.values.rangeSigmaM)
      // Conservative stop envelope, modeled acceleration guarantee 0.5 m/s², receipt + command reaction.
      if (clearance <= Math.max(speed, sensedSpeed) ** 2 + Math.max(speed, sensedSpeed) * 0.24 + 0.3) throw new Error('surface-collision-envelope')
      if (!m.values.onSurface || Math.abs(p.positionM[2]!) > 0.3 || speed > 2 || Math.abs(p.positionM[0]!) > 50 || Math.abs(p.positionM[1]!) > 50) throw new Error('surface-operating-envelope')
      const dn = c.mission.targetM[0] - p.positionM[0]!, de = c.mission.targetM[1] - p.positionM[1]!, distance = Math.hypot(dn, de)
      const desiredSpeed = Math.min(0.7, distance * 0.8)
      const vn = distance > 1e-6 ? desiredSpeed * dn / distance : 0, ve = distance > 1e-6 ? desiredSpeed * de / distance : 0
      const fn = clamp(1.8 * (vn - p.velocityMps[0]!) + vn * 0.6, 1), fe = clamp(1.8 * (ve - p.velocityMps[1]!) + ve * 0.6, 1)
      const yaw = a.eulerRad[2], co = Math.cos(yaw), si = Math.sin(yaw), bearing = distance > 0.5 ? Math.atan2(de, dn) : yaw
      const error = Math.atan2(Math.sin(bearing - yaw), Math.cos(bearing - yaw))
      return result(c, [clamp(co * fn + si * fe, 1), clamp(-si * fn + co * fe, 1), clamp(error * 0.7 - Number(m.values.yawRateRadS) * 0.8, 0.6)], 'surface-station-keeping-track', false)
    }
    catch (error) { latched = error instanceof Error ? error.message : 'surface-sensor-fault'; return result(c, [0, 0, 0], latched, true) }
  } }
}
