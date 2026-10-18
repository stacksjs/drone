import type { VehicleController, VehicleControllerContext, VehicleControlOutput, VehicleMeasurement } from '../types'
import { airModel } from './plant'
import { vehicleReference } from '../measurements'
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
export function createAirController(): VehicleController {
  let lastNow = -Infinity, lastSequence = -1, lastCaptured = -Infinity, signature = '', reference: string | null = null, fault = ''
  let hasFlown = false, lastTask = '', landingContact = false
  let loiterCenter: number[] | null = null, landingHeading: number | null = null
  function output(c: VehicleControllerContext, a: number[], reason: string, inhibited = false): VehicleControlOutput { return { kind: 'simulated-vehicle-control', vehicle: 'fixed-wing', atMs: c.nowMs, actuators: [...a], inhibited, reason, physicalFlightEnabled: false, boardOutputsInhibited: true } }
  function qualify(c: VehicleControllerContext, m: VehicleMeasurement | null) {
    if (!m || m.version !== 1 || m.evidence !== 'modeled-vehicle-sensors' || m.vehicle !== 'fixed-wing' || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Number.isFinite(m.capturedAtMs) || !Number.isFinite(m.receivedAtMs) || m.capturedAtMs > m.receivedAtMs || m.receivedAtMs > c.nowMs || c.nowMs - m.capturedAtMs > 160 || m.receivedAtMs - m.capturedAtMs !== 60) return false
    const expectedReference = vehicleReference(c.estimate)
    if (m.reference !== expectedReference || (reference !== null && m.reference !== reference)) return false
    const v = m.values
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    if (typeof v.differentialPressurePa !== 'number' || !Number.isFinite(v.differentialPressurePa) || v.differentialPressurePa < 0 || Math.abs(Math.sqrt(2 * v.differentialPressurePa / airModel.densityKgM3) - (v.airspeedMps as number)) > 0.02 || typeof v.airspeedMps !== 'number' || !Number.isFinite(v.airspeedMps) || v.airspeedMps < 0 || v.airspeedMps > 60 || typeof v.alphaRad !== 'number' || !Number.isFinite(v.alphaRad) || Math.abs(v.alphaRad) > Math.PI || typeof v.betaRad !== 'number' || !Number.isFinite(v.betaRad) || Math.abs(v.betaRad) > Math.PI || typeof v.onSurface !== 'boolean' || typeof v.stopped !== 'boolean' || !Array.isArray(v.rateRadS) || v.rateRadS.length !== 3 || !v.rateRadS.every(n => Number.isFinite(n) && Math.abs(n) < 40)) return false
    const nextSignature = JSON.stringify(m)
    if (m.sequence < lastSequence || m.capturedAtMs < lastCaptured || (m.sequence === lastSequence && nextSignature !== signature) || (m.sequence > lastSequence && m.capturedAtMs <= lastCaptured)) return false
    lastSequence = m.sequence; lastCaptured = m.capturedAtMs; signature = nextSignature; reference = m.reference
    return true
  }
  return {
    step(c) {
      if (!Number.isFinite(c.nowMs) || c.nowMs < lastNow || (lastNow !== -Infinity && c.nowMs - lastNow > 60 && c.enabled)) fault ||= 'air-control-clock-gap'
      lastNow = c.nowMs
      if (!c.enabled) return output(c, [0, 0, 0, 0, 1], fault || 'authority-disabled', true)
      if (fault) return output(c, [0, 0, 0, 0, 1], fault, true)
      if (!qualify(c, c.measurement)) fault = 'air-sensor-unqualified'
      if (!c.estimate.health.tilt || !c.estimate.health.localPosition || !c.estimate.attitude || !c.estimate.localPosition || c.nowMs !== c.estimate.nowMs || c.estimate.localPosition.predictedToMs !== c.nowMs || !vector(c.estimate.attitude.eulerRad) || !vector(c.estimate.localPosition.positionM) || !vector(c.estimate.localPosition.velocityMps)) fault ||= 'air-estimator-unhealthy'
      if (fault) return output(c, [0, 0, 0, 0, 1], fault, true)
      const values = c.measurement!.values, speed = values.airspeedMps as number, alpha = values.alphaRad as number, contact = values.onSurface as boolean, rates = values.rateRadS as number[]
      const position = c.estimate.localPosition!.positionM, velocity = c.estimate.localPosition!.velocityMps, [roll, pitch, yaw] = c.estimate.attitude!.eulerRad
      if (!contact) hasFlown = true
      if (speed > airModel.maximumMps || (!contact && hasFlown && (speed < airModel.minimumMps || Math.abs(alpha) > airModel.stallAlphaRad + 0.03)) || Math.abs(roll!) > 0.9 || Math.abs(pitch!) > 0.65) fault = 'air-flight-envelope'
      if (fault) return output(c, [0, 0, 0, 0, 1], fault, true)
      const paused = c.mission.state === 'paused'
      const landing = !paused && (c.mission.taskKind === 'land' || c.mission.taskKind === 'stop')
      if (c.mission.taskId !== lastTask) { landingContact = false; landingHeading = null; lastTask = c.mission.taskId }
      if (paused && contact) return output(c, [0, 0, 0, 0, 1], 'runway-paused')
      if (landing && contact && hasFlown) landingContact = true
      if (landing && landingContact) return output(c, [0, clamp(-roll! * 1.4 - rates[0]! * 0.25, -0.4, 0.4), clamp(-pitch! * 1.4 - rates[1]! * 0.25, -0.4, 0.4), 0, 1], 'landing-rollout')
      if (paused && !loiterCenter) loiterCenter = [position[0]! - 45 * Math.sin(yaw!), position[1]! + 45 * Math.cos(yaw!), position[2]!]
      if (!paused) loiterCenter = null
      const goal = paused ? loiterCenter : c.mission.targetM
      if (!goal || !vector(goal)) return output(c, [0, 0, 0, 0, 1], 'air-mission-target-missing', true)
      const dx = goal[0]! - position[0]!, dy = goal[1]! - position[1]!, distance = Math.hypot(dx, dy)
      let desiredHeading = Math.atan2(dy, dx), approachRemaining = distance
      if (landing) {
        landingHeading ??= desiredHeading
        approachRemaining = Math.max(0, dx * Math.cos(landingHeading) + dy * Math.sin(landingHeading))
        const crossTrack = -dx * Math.sin(landingHeading) + dy * Math.cos(landingHeading)
        desiredHeading = landingHeading + clamp(Math.atan2(crossTrack, Math.max(30, approachRemaining)), -0.3, 0.3)
      }
      if (paused || c.mission.taskKind === 'loiter') {
        const radial = Math.atan2(position[1]! - goal[1]!, position[0]! - goal[0]!)
        desiredHeading = radial + Math.PI / 2 + Math.atan2(distance - 45, 30)
      }
      const groundCourse = Math.hypot(velocity[0]!, velocity[1]!) > 3 ? Math.atan2(velocity[1]!, velocity[0]!) : yaw!
      const bankTarget = contact ? 0 : clamp(wrap(desiredHeading - groundCourse) * 1.2, -0.5, 0.5)
      const targetSpeed = landing ? 10.5 : airModel.cruiseMps
      let desiredDown = goal[2]!
      if (landing) desiredDown = 0.25 - Math.min(20, approachRemaining * 0.055)
      const climbTarget = clamp((position[2]! - desiredDown) * (landing ? 0.35 : 0.12) - (landing ? targetSpeed * 0.055 : 0), -1.5, 1.8)
      const targetLiftCoefficient = airModel.massKg * airModel.gravityMps2 / Math.max(10, 0.5 * airModel.densityKgM3 * speed ** 2 * airModel.areaM2 * Math.cos(bankTarget))
      const trimAlpha = clamp((targetLiftCoefficient - 0.25) / 4.8, -0.04, 0.12)
      let pitchTarget = clamp(climbTarget / Math.max(8, speed) + trimAlpha, -0.14, 0.22)
      if (contact) pitchTarget = speed >= airModel.rotationMps ? 0.13 : 0
      // Energy allocation: throttle supplies total specific-energy deficit; pitch allocates potential energy while protecting airspeed.
      const energyError = airModel.gravityMps2 * (position[2]! - desiredDown) + (targetSpeed ** 2 - speed ** 2) / 2
      const throttle = contact ? 1 : clamp(0.25 + energyError * 0.012, 0, 1)
      if (!contact) pitchTarget -= clamp((targetSpeed - speed) * 0.025, 0, 0.08)
      const pressureArea = Math.max(1, 0.5 * airModel.densityKgM3 * speed ** 2 * airModel.areaM2)
      const rollRateTarget = clamp((bankTarget - roll!) * 2, -0.5, 0.5), pitchRateTarget = clamp((pitchTarget - pitch!) * 2, -0.35, 0.35)
      const aileron = clamp(airModel.inertiaKgM2[0] * (rollRateTarget - rates[0]!) * 4 / (pressureArea * airModel.spanM * 0.12), -0.4, 0.4)
      const elevator = clamp(airModel.inertiaKgM2[1] * (pitchRateTarget - rates[1]!) * 4 / (pressureArea * airModel.chordM * 0.8) + 0.1875 * alpha, -0.4, 0.4)
      const rudder = clamp(-(values.betaRad as number) * 0.6 - rates[2]! * 0.08, -0.4, 0.4)
      return output(c, [throttle, aileron, elevator, rudder, 0], paused ? 'bounded-air-loiter' : landing ? 'energy-managed-approach' : contact ? 'runway-takeoff' : 'energy-managed-flight')
    },
  }
}
