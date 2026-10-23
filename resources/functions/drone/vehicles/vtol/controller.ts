import type { VehicleController, VehicleControllerContext, VehicleControlOutput } from '../types'
import { createVehicleMeasurementQualifier, vehicleReference } from '../measurements'
import { createVtolHoverController } from './hover-controller'

/** Hover-only adapter on the shared mission/authority runtime. No wing transition policy. */
export function createVtolVehicleHoverController(): VehicleController {
  const hover = createVtolHoverController({ headingAlignment: 'initial-simulation-north' }), qualifier = createVehicleMeasurementQualifier('vtol')
  let fault = '', hasFlown = false
  function output(c: VehicleControllerContext, actuators: number[], reason: string, inhibited: boolean): VehicleControlOutput {
    return { kind: 'simulated-vehicle-control', vehicle: 'vtol', atMs: c.nowMs, actuators, reason, inhibited, physicalFlightEnabled: false, boardOutputsInhibited: true }
  }
  return {
    step(c) {
      if (!c.enabled || fault) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault || 'authority-disabled', true)
      let measurement
      try { measurement = qualifier.qualify(c.measurement, c.nowMs, vehicleReference(c.estimate)) }
      catch { fault = 'vtol-sensor-unqualified' }
      if (!measurement || c.mission.vehicle !== 'vtol' || !c.controlRate || c.controlRate.evidence !== 'modeled-qualified-imu' || c.controlRate.reference !== vehicleReference(c.estimate)) fault ||= 'vtol-control-observation-unqualified'
      if (fault) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true)
      if (measurement!.values.onSurface === false) hasFlown = true
      const landing = c.mission.state === 'running' && c.mission.taskKind === 'land'
      const target = c.mission.targetM ? [...c.mission.targetM] as [number, number, number] : null
      if (!target) { fault = 'vtol-mission-target-missing'; return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true) }
      // A declared 0.1 m plane intercept permits finite contact rather than asymptotic height holding.
      if (landing) target[2] += 0.1
      const result = hover.step({ kind: 'simulation', enabled: true, nowMs: c.nowMs, estimate: c.estimate, angularRateRadS: c.controlRate!.angularRateRadS, rateCapturedAtMs: c.controlRate!.capturedAtMs, target: { positionM: target, yawRad: 0, issuedAtMs: c.nowMs } })
      if (result.inhibited) fault = result.reason
      if (!result.inhibited && c.mission.state === 'paused' && measurement!.values.onSurface === true) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], 'ground-paused', false)
      if (!result.inhibited && landing && hasFlown && measurement!.values.onSurface === true) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], 'vertical-contact', false)
      return output(c, [...result.motorsN, 0, 0, 0, 0], result.reason, result.inhibited)
    },
  }
}
