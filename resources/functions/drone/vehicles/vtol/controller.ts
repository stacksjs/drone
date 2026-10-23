import type { VehicleController, VehicleControllerContext, VehicleControlOutput } from '../types'
import { createVehicleMeasurementQualifier, vehicleReference } from '../measurements'
import { numericPacket } from './packets'
import { createVtolHoverController } from './hover-controller'

/** Hover-only adapter on the shared mission/authority runtime. No wing transition policy. */
export function createVtolVehicleHoverController(): VehicleController {
  const hover = createVtolHoverController({ headingAlignment: 'initial-simulation-north' }), qualifier = createVehicleMeasurementQualifier('vtol')
  let fault = '', hasFlown = false
  let modeEvent = '', modeSignature = '', hoverStableSince: number | null = null, observedStableSince: number | null = null, confirmedEvent = '', headingRad = 0
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
      let target: [number, number, number] | null = null
      try { target = c.mission.targetM ? numericPacket(c.mission.targetM, 3) as [number, number, number] : null }
      catch { fault = 'vtol-mission-target-unqualified' }
      if (!target) { fault ||= 'vtol-mission-target-missing'; return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true) }
      if (fault) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true)
      const request = c.mission.transition
      if (request) {
        let position: number[] = []
        try { position = numericPacket(request.positionM, 3) }
        catch { fault = 'vtol-mode-request-unqualified' }
        if (c.mission.taskKind !== 'vtol-mode' || request.taskId !== c.mission.taskId || typeof request.eventId !== 'string' || !request.eventId || request.eventId.length > 256 || request.reference !== vehicleReference(c.estimate) || !['hover', 'cruise'].includes(request.mode) || !Number.isFinite(request.headingRad) || Math.abs(request.headingRad) > Math.PI || position.length !== 3 || position.some((n, i) => n !== target![i]) || !Number.isSafeInteger(request.issuedAtMs) || !Number.isSafeInteger(request.expiresAtMs) || request.issuedAtMs > c.nowMs || request.expiresAtMs <= c.nowMs || request.expiresAtMs <= request.issuedAtMs) fault = 'vtol-mode-request-unqualified'
        const signature = JSON.stringify(request)
        if (modeEvent === request.eventId && modeSignature !== signature) fault = 'vtol-mode-request-changed'
        if (modeEvent !== request.eventId) { modeEvent = request.eventId; modeSignature = signature; hoverStableSince = null; observedStableSince = null; headingRad = request.headingRad }
      }
      if (fault) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true)
      const landing = c.mission.state === 'running' && c.mission.taskKind === 'land'
      // A declared 0.1 m plane intercept permits finite contact rather than asymptotic height holding.
      if (landing) target[2] += 0.1
      const result = hover.step({ kind: 'simulation', enabled: true, nowMs: c.nowMs, estimate: c.estimate, angularRateRadS: c.controlRate!.angularRateRadS, rateCapturedAtMs: c.controlRate!.capturedAtMs, target: { positionM: target, yawRad: headingRad, issuedAtMs: c.nowMs } })
      if (result.inhibited) fault ||= result.reason
      if (fault) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true)
      if (c.mission.taskKind === 'vtol-mode') {
        // The hover development adapter never certifies wing-borne flight or a back transition.
        const response = output(c, measurement!.values.onSurface === true ? [0, 0, 0, 0, 0, 0, 0, 0] : [...result.motorsN, 0, 0, 0, 0], 'hover-mode-observing', false)
        const sourceCapturedAtMs = Math.min(measurement!.capturedAtMs, c.controlRate!.capturedAtMs, c.estimate.attitude!.capturedAtMs!, c.estimate.localPosition!.capturedAtMs!)
        if (!request || sourceCapturedAtMs < request.issuedAtMs || confirmedEvent === request.eventId) return response
        const stable = Math.hypot(...c.estimate.localPosition!.velocityMps) <= 0.2 && Math.hypot(...c.controlRate!.angularRateRadS) <= 0.1 && Math.abs(c.estimate.attitude!.eulerRad[0]) <= 0.1 && Math.abs(c.estimate.attitude!.eulerRad[1]) <= 0.1 && Math.abs(Math.atan2(Math.sin(c.estimate.attitude!.eulerRad[2] - headingRad), Math.cos(c.estimate.attitude!.eulerRad[2] - headingRad))) <= 0.1 && Math.hypot(...target.map((n, i) => n - c.estimate.localPosition!.positionM[i]!)) <= 0.3 && (measurement!.values.onSurface === false || measurement!.values.stopped === true)
        if (!stable) { hoverStableSince = null; observedStableSince = null }
        else { hoverStableSince ??= sourceCapturedAtMs; observedStableSince ??= c.nowMs }
        const confirmed = request.mode === 'hover' && stable && sourceCapturedAtMs - hoverStableSince! >= 200 && c.nowMs - observedStableSince! >= 200
        response.transition = { evidence: 'modeled-vtol-controller-observation', eventId: request.eventId, taskId: request.taskId, mode: request.mode, reference: request.reference, capturedAtMs: c.nowMs, measurementCapturedAtMs: sourceCapturedAtMs, phase: 'hover', outcome: request.mode === 'cruise' ? 'aborted' : confirmed ? 'confirmed' : 'progress', reason: request.mode === 'cruise' ? 'hover-only-controller' : confirmed ? 'hover-qualified' : 'hover-qualifying' }
        if (confirmed || request.mode === 'cruise') confirmedEvent = request.eventId
        return response
      }
      if (!result.inhibited && c.mission.state === 'paused' && measurement!.values.onSurface === true) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], 'ground-paused', false)
      if (!result.inhibited && landing && hasFlown && measurement!.values.onSurface === true) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], 'vertical-contact', false)
      return output(c, [...result.motorsN, 0, 0, 0, 0], result.reason, result.inhibited)
    },
  }
}
