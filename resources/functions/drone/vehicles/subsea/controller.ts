import type { SensorVector } from '../../sensors/types'
import type { VehicleController, VehicleControllerContext, VehicleControlOutput } from '../types'
import { rotateNedToBody } from '../../controls/physics'
import { allocateSubseaWrench } from './allocation'
import { subseaModel } from './plant'
import { qualifySubseaMeasurement } from './sensors'
import { pressureDepthM } from './navigation'

function vector(v: unknown): v is SensorVector { return Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) }
export function createSubseaController(): VehicleController {
  let reference: string | null = null, sequence = 0, signature = '', capture = -Infinity, now = -Infinity, latched = ''
  function result(c: VehicleControllerContext, actuators: number[], reason: string, inhibited: boolean): VehicleControlOutput { return { kind: 'simulated-vehicle-control', vehicle: 'subsea', atMs: c.nowMs, actuators: [...actuators], inhibited, reason, physicalFlightEnabled: false, boardOutputsInhibited: true } }
  return { step(c) {
    const neutral = Array(8).fill(0)
    if (!Number.isFinite(c.nowMs) || c.nowMs < now || now !== -Infinity && c.nowMs - now > 40) latched ||= 'subsea-control-clock-gap'
    now = c.nowMs
    const observation = qualifySubseaMeasurement(c.measurement, c.nowMs, `${c.estimate.bootId}:${Object.values(c.estimate.resets).join(',')}`)
    if (observation && (observation.values.leak || Number(observation.values.tetherTensionN) >= 40 || !observation.values.linkConnected || observation.values.emergency)) latched ||= 'subsea-leak-tether-or-emergency'
    if (!c.enabled) return result(c, neutral, latched || 'subsea-authority-inhibited', true)
    if (latched) return result(c, neutral, latched, true)
    if (!c.mission.targetM || !['running', 'paused'].includes(c.mission.state)) return result(c, neutral, 'subsea-no-active-target', true)
    try {
      const e = c.estimate, p = e.localPosition, a = e.attitude
      if (c.mission.version !== 2 || c.mission.vehicle !== 'subsea' || c.mission.evidence !== 'owned-vehicle-mission-simulation' || c.mission.physicalFlightEnabled !== false || e.physicalFlightEnabled !== false) throw new Error('subsea-context-incompatible')
      const fresh = (at: number | null | undefined, max: number) => at !== null && at !== undefined && Number.isFinite(at) && at <= c.nowMs && c.nowMs - at <= max
      if (!e.health.tilt || !e.health.localPosition || !p || !a || a.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || e.evidence !== 'fixture' || e.nowMs !== c.nowMs || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'LOCAL_WATER_SURFACE' || !fresh(a.capturedAtMs, 60) || !fresh(p.capturedAtMs, 120) || p.predictedToMs !== c.nowMs || !vector(p.positionM) || !vector(p.velocityMps) || !vector(a.eulerRad) || !Array.isArray(a.quaternionWxyz) || a.quaternionWxyz.length !== 4 || !a.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...a.quaternionWxyz) - 1) > 0.001) throw new Error('subsea-estimate-unavailable')
      const estimateReference = `${e.bootId}:${Object.values(e.resets).join(',')}`
      const m = observation
      if (!m) throw new Error('subsea-sensor-invalid')
      const encoded = JSON.stringify(m)
      if (reference !== null && reference !== estimateReference) throw new Error('subsea-reference-changed')
      if (reference !== null && (m.sequence < sequence || m.sequence === sequence && encoded !== signature || m.sequence > sequence && m.capturedAtMs <= capture)) throw new Error('subsea-sensor-replay')
      reference = m.reference; sequence = m.sequence; signature = encoded; capture = m.capturedAtMs
      const sensedDepth = pressureDepthM(Number(m.values.pressurePa), Number(m.values.surfacePressurePa), Number(m.values.waterDensityKgM3))
      if (m.values.leak || Number(m.values.tetherTensionN) >= 40 || !m.values.linkConnected || m.values.emergency) throw new Error('subsea-leak-tether-or-emergency')
      // The 0.1 m surface uncertainty band matches pressure qualification, not a deeper operating limit.
      if (p.positionM[2] < -0.1 || p.positionM[2] > 8 || sensedDepth < -0.1 || sensedDepth > 8 || Math.hypot(...p.velocityMps) > 1.2 || Math.hypot(p.positionM[0], p.positionM[1]) > 8 || !vector(c.mission.targetM) || c.mission.targetM[2] < 0 || c.mission.targetM[2] > 8) throw new Error('subsea-operating-envelope')
      const speed = Math.hypot(...p.velocityMps)
      const stoppingM = speed * speed + speed * 0.24 + 0.25
      if (Number(m.values.structureRangeM) <= stoppingM || Number(m.values.bottomRangeM) <= stoppingM) throw new Error('subsea-clearance-envelope')
      if (c.mission.state === 'paused' && m.values.onSurface && p.positionM[2] <= 0.02 && c.mission.targetM[2] <= 0.02) return result(c, neutral, 'subsea-surface-pause-neutral', false)
      const error = c.mission.targetM.map((n, i) => n - p.positionM[i]!) as SensorVector
      const distance = Math.hypot(...error), desiredSpeed = Math.min(0.6, distance * 0.9)
      const desiredVelocity = error.map(n => distance > 1e-9 ? n / distance * desiredSpeed : 0) as SensorVector
      const forceNed = desiredVelocity.map((n, i) => (subseaModel.massKg + subseaModel.addedMassKg) * 2.2 * (n - p.velocityMps[i]!) + (i === 2 ? subseaModel.excessBuoyancyN : 0)) as SensorVector
      const rates = m.values.angularRateBodyRadS
      if (!vector(rates)) throw new Error('subsea-body-rate-invalid')
      const sign = a.quaternionWxyz[0] < 0 ? -1 : 1
      const torqueNm = rates.map((n, i) => -12 * sign * a.quaternionWxyz[i + 1]! - 3 * n) as SensorVector
      const allocation = allocateSubseaWrench({ forceN: rotateNedToBody(a.quaternionWxyz, forceNed), torqueNm })
      return result(c, allocation.thrustersN, c.mission.state === 'paused' ? 'subsea-paused-depth-hold' : 'subsea-six-axis-track', false)
    }
    catch (error) { latched = error instanceof Error ? error.message : 'subsea-control-fault'; return result(c, neutral, latched, true) }
  } }
}
