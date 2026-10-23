import type { VehicleController, VehicleControllerContext, VehicleControlOutput, VehicleVtolTransitionCommand, VehicleVtolTransitionObservation } from '../types'
import type { SensorVector } from '../../sensors/types'
import type { Quaternion } from '../../estimation/frames'
import { createVehicleMeasurementQualifier, vehicleReference } from '../measurements'
import { quaternionEuler, quaternionFromTilt, multiplyQuaternion, normalizeQuaternion } from '../../estimation/frames'
import { rotateBodyToNed, rotateNedToBody } from '../../controls/physics'
import { createBoundedPid } from '../../controls/pid'
import { airAerodynamics, airModel } from '../air/plant'
import { createVtolVehicleHoverController } from './controller'
import { numericPacket } from './packets'
import { allocateVtolLift } from './allocation'
import { vtolModel } from './plant'

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
const wrap = (n: number) => Math.atan2(Math.sin(n), Math.cos(n))

/** Original fictional pressure/force-aware lift-and-cruise control, undergoing owned-model qualification. */
export function createVtolFlightController(): VehicleController {
  const qualifier = createVehicleMeasurementQualifier('vtol'), hover = createVtolVehicleHoverController()
  const ratePid = [0, 1, 2].map(i => createBoundedPid({ kp: i === 2 ? 0.96 : 1.6, ki: i === 2 ? 0.48 : 0.8, kd: 0.02, integralLimit: 1, outputLimit: i === 2 ? 2 : 6, derivativeTauS: 0.03, trackingGain: 4 }))
  const velocityPid = [0, 1, 2].map(() => createBoundedPid({ kp: 1.6, ki: 0.25, kd: 0, integralLimit: 1.5, outputLimit: 3, derivativeTauS: 0.03, trackingGain: 1 }))
  let hasWingControl = false, backSlow = false
  let lastNow: number | null = null, identity: string | null = null, fault = ''
  let phase: VehicleVtolTransitionObservation['phase'] = 'hover', request: VehicleVtolTransitionCommand | null = null, signature = '', confirmedEvent = ''
  let stableSource: number | null = null, stableDecision: number | null = null
  function output(c: VehicleControllerContext, actuators: number[], reason: string, inhibited = false): VehicleControlOutput { return { kind: 'simulated-vehicle-control', vehicle: 'vtol', atMs: c.nowMs, actuators: [...actuators], reason, inhibited, physicalFlightEnabled: false, boardOutputsInhibited: true } }
  function neutral(c: VehicleControllerContext, reason: string) { fault ||= reason; return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true) }
  return {
    step(c) {
      if (!Number.isSafeInteger(c.nowMs) || c.nowMs < 0 || lastNow !== null && (c.nowMs <= lastNow || c.nowMs - lastNow > 40)) return neutral(c, 'vtol-flight-clock-gap')
      const dtS = lastNow === null ? 0.02 : (c.nowMs - lastNow) / 1000
      lastNow = c.nowMs
      if (!c.enabled || fault) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault || 'authority-disabled', true)
      let measurement, position: SensorVector, velocity: SensorVector, q: Quaternion, captureQ: Quaternion, rates: SensorVector, target: SensorVector
      try {
        measurement = qualifier.qualify(c.measurement, c.nowMs, vehicleReference(c.estimate))
        const e = c.estimate, p = e.localPosition, a = e.attitude, rate = c.controlRate
        if (!measurement || c.mission.vehicle !== 'vtol' || e.evidence !== 'fixture' || e.physicalFlightEnabled !== false || typeof e.bootId !== 'bigint' || e.bootId <= 0n || !Object.values(e.resets).every(n => Number.isSafeInteger(n) && n >= 0) || e.nowMs !== c.nowMs || !e.health.tilt || !e.health.localPosition || !p || !a || !rate || rate.evidence !== 'modeled-qualified-imu' || rate.reference !== measurement.reference || a.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || p.frame !== 'LOCAL_NED' || p.altitudeDatum !== 'WGS84_ELLIPSOID' || p.predictedToMs !== c.nowMs || p.capturedAtMs === null || a.capturedAtMs === null || !Number.isSafeInteger(p.capturedAtMs) || !Number.isSafeInteger(a.capturedAtMs) || p.capturedAtMs > c.nowMs || c.nowMs - p.capturedAtMs > 200 || a.capturedAtMs > c.nowMs || c.nowMs - a.capturedAtMs > 60 || rate.capturedAtMs !== a.capturedAtMs) throw new TypeError('Unqualified navigation')
        position = numericPacket(p.positionM, 3) as SensorVector; velocity = numericPacket(p.velocityMps, 3) as SensorVector
        q = numericPacket(a.quaternionWxyz, 4) as Quaternion; rates = numericPacket(rate.angularRateRadS, 3) as SensorVector
        target = numericPacket(c.mission.targetM, 3) as SensorVector
        const pose = c.measurementPose
        if (!pose || pose.reference !== measurement.reference || pose.capturedAtMs !== measurement.capturedAtMs || pose.attitudePrediction !== 'qualified-gyro-hold' || pose.attitudePredictedToMs !== pose.capturedAtMs || pose.positionPredictedToMs !== pose.capturedAtMs || ![pose.attitudeCapturedAtMs, pose.gyroCapturedAtMs, pose.positionCapturedAtMs].every(n => Number.isSafeInteger(n) && n >= 0) || pose.attitudeCapturedAtMs !== pose.gyroCapturedAtMs || pose.gyroCapturedAtMs > pose.capturedAtMs || pose.capturedAtMs - pose.gyroCapturedAtMs > 60 || pose.positionCapturedAtMs > pose.capturedAtMs || pose.capturedAtMs - pose.positionCapturedAtMs > 200) throw new TypeError('Unmatched air capture pose')
        captureQ = numericPacket(pose.quaternionWxyz, 4) as Quaternion
        if (Math.abs(Math.hypot(...captureQ) - 1) > 1e-6) throw new TypeError('Invalid air capture attitude')
        if (Math.abs(Math.hypot(...q) - 1) > 1e-6 || Math.hypot(...rates) > 35 || Math.hypot(...target) > 400 || Math.hypot(...position) > 500 || !p.origin || ![p.origin.latitudeDeg, p.origin.longitudeDeg, p.origin.ellipsoidHeightM].every(Number.isFinite)) throw new TypeError('Invalid navigation values')
        const nextIdentity = JSON.stringify([String(e.bootId), e.resets, p.origin])
        if (identity !== null && identity !== nextIdentity) throw new TypeError('Changed navigation reference')
        identity = nextIdentity
        const heldS = (c.nowMs - rate.capturedAtMs) / 1000, magnitude = Math.hypot(...rates), angle = magnitude * heldS
        const scale = magnitude < 1e-10 ? heldS / 2 : Math.sin(angle / 2) / magnitude
        q = normalizeQuaternion(multiplyQuaternion(q, [Math.cos(angle / 2), rates[0] * scale, rates[1] * scale, rates[2] * scale]))
        const v = measurement.values
        for (const key of ['airspeedMps', 'differentialPressurePa', 'alphaRad', 'betaRad', 'rotorThrustN', 'pusherThrustN']) if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) throw new TypeError('Missing VTOL air measurement')
        if ((v.airspeedMps as number) < 0 || (v.airspeedMps as number) > 60 || (v.differentialPressurePa as number) < 0 || Math.abs(Math.sqrt(2 * (v.differentialPressurePa as number) / airModel.densityKgM3) - (v.airspeedMps as number)) > 0.02 || Math.abs(v.alphaRad as number) > Math.PI || Math.abs(v.betaRad as number) > Math.PI || (v.rotorThrustN as number) < 0 || (v.rotorThrustN as number) > 48 || (v.pusherThrustN as number) < 0 || (v.pusherThrustN as number) > 14) throw new TypeError('Invalid VTOL air measurement')
      }
      catch { return neutral(c, 'vtol-flight-observation-unqualified') }
      const incoming = c.mission.transition
      if (incoming) {
        let anchor: number[]
        try { anchor = numericPacket(incoming.positionM, 3) }
        catch { return neutral(c, 'vtol-flight-request-unqualified') }
        if (c.mission.taskKind !== 'vtol-mode' || incoming.taskId !== c.mission.taskId || typeof incoming.eventId !== 'string' || !incoming.eventId || incoming.eventId.length > 256 || incoming.reference !== measurement!.reference || !['hover', 'cruise'].includes(incoming.mode) || !Number.isFinite(incoming.headingRad) || Math.abs(incoming.headingRad) > Math.PI || anchor.some((n, i) => n !== target[i]) || !Number.isSafeInteger(incoming.issuedAtMs) || incoming.issuedAtMs < 0 || !Number.isSafeInteger(incoming.expiresAtMs) || incoming.issuedAtMs > c.nowMs || incoming.expiresAtMs <= c.nowMs || incoming.expiresAtMs <= incoming.issuedAtMs || incoming.expiresAtMs - incoming.issuedAtMs > (incoming.mode === 'hover' ? 45000 : 15000)) return neutral(c, 'vtol-flight-request-unqualified')
        const encoded = JSON.stringify(incoming)
        if (request?.eventId === incoming.eventId && signature !== encoded) return neutral(c, 'vtol-flight-request-changed')
        if (request?.eventId !== incoming.eventId && incoming.mode === 'cruise') {
          if (phase !== 'hover' || measurement!.values.onSurface) return neutral(c, 'vtol-front-requires-airborne-hover')
          request = structuredClone(incoming); signature = encoded; phase = 'front-transition'; hasWingControl = true; stableSource = null; stableDecision = null
        }
        if (request?.eventId !== incoming.eventId && incoming.mode === 'hover' && hasWingControl) {
          if (phase !== 'cruise') return neutral(c, 'vtol-back-requires-observed-cruise')
          request = structuredClone(incoming); signature = encoded; phase = 'back-transition'; backSlow = false; stableSource = null; stableDecision = null
          for (const pid of velocityPid) pid.reset()
        }
      }
      if (phase === 'hover' && !hasWingControl) return hover.step(c)
      const [roll, pitch, yaw] = quaternionEuler(q!), values = measurement!.values
      const speed = values.airspeedMps as number, alpha = values.alphaRad as number, beta = values.betaRad as number
      const landing = phase === 'hover' && c.mission.state === 'running' && c.mission.taskKind === 'land'
      if (measurement!.values.onSurface && !landing || speed > 22 || Math.abs(roll) > 0.6 || Math.abs(pitch) > 0.5 || speed > 8 && (Math.abs(alpha) > 0.32 || Math.abs(beta) > 0.4) || phase !== 'hover' && Math.abs(position![2] - request!.positionM[2]) > 2) return neutral(c, 'vtol-transition-envelope')
      if (landing && measurement!.values.onSurface) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], 'vertical-contact')
      const rotary = phase === 'back-transition' || phase === 'hover'
      const heading = phase === 'front-transition' || rotary ? request!.headingRad : Math.atan2(target![1] - position![1], target![0] - position![0])
      const course = Math.hypot(velocity![0], velocity![1]) > 3 ? Math.atan2(velocity![1], velocity![0]) : yaw
      let bankTarget = clamp(wrap(heading - course) * 0.8, -0.3, 0.3)
      let downAcceleration = clamp((target![2] - position![2]) * 1.2 - velocity![2] * 1.5, -3, 3)
      const capturedRelative: SensorVector = [speed * Math.cos(alpha) * Math.cos(beta), speed * Math.sin(beta), speed * Math.sin(alpha) * Math.cos(beta)]
      // Delayed BODY_FRD airflow belongs to its qualified capture pose. Hold that measured NED
      // airflow vector to this decision, then express it in the current gyro-predicted attitude.
      const airNed = rotateBodyToNed(captureQ!, capturedRelative)
      const relative = rotateNedToBody(q!, airNed)
      const gamma = Math.atan2(-airNed[2], Math.hypot(airNed[0], airNed[1]))
      const pressureArea = (values.differentialPressurePa as number) * airModel.areaM2
      let requiredUpN = vtolModel.massKg * (vtolModel.gravityMps2 - downAcceleration)
      const alphaTarget = clamp((requiredUpN / Math.max(1, pressureArea * Math.cos(bankTarget)) - 0.25) / 4.8, -0.08, 0.18)
      let pitchTarget = clamp(gamma + alphaTarget, -0.2, 0.25) * clamp((speed - 10) / 2, 0, 1)
      const zero = airAerodynamics(relative, rates!, [0, 0, 0, 0, 0])
      if (rotary) {
        backSlow ||= speed < 3
        if (!backSlow && phase === 'back-transition') {
          // With the pusher off, high-speed braking is bounded by wing drag and the lift surplus.
          // The linear pre-stall lift slope gives the pitch that maximizes supported rotor braking.
          const optimalAlpha = Math.max(0, (requiredUpN / Math.max(1, pressureArea) - 0.25) / (2 * 4.8))
          pitchTarget = clamp(gamma + optimalAlpha, -0.08, 0.3)
          bankTarget = 0
        }
        else {
          const goal = [...target!] as SensorVector
          if (landing) goal[2] += 0.1
          const desiredVelocity = goal.map((n, i) => n - position![i]!) as SensorVector
          const horizontal = Math.hypot(desiredVelocity[0], desiredVelocity[1])
          if (horizontal > 3) { desiredVelocity[0] *= 3 / horizontal; desiredVelocity[1] *= 3 / horizontal }
          desiredVelocity[2] = clamp(desiredVelocity[2], -2, 2)
          const acceleration = desiredVelocity.map((n, i) => velocityPid[i]!.step(n - velocity![i]!, velocity![i]!, dtS)) as SensorVector
          const aHorizontal = Math.hypot(acceleration[0], acceleration[1])
          if (aHorizontal > 3) { acceleration[0] *= 3 / aHorizontal; acceleration[1] *= 3 / aHorizontal }
          downAcceleration = acceleration[2]; requiredUpN = vtolModel.massKg * (vtolModel.gravityMps2 - downAcceleration)
          const zeroNed = rotateBodyToNed(q!, zero.forceN)
          const fx = vtolModel.massKg * acceleration[0] - zeroNed[0], fy = vtolModel.massKg * acceleration[1] - zeroNed[1]
          const forward = Math.cos(heading) * fx + Math.sin(heading) * fy, right = -Math.sin(heading) * fx + Math.cos(heading) * fy
          const up = Math.max(1, requiredUpN + zeroNed[2])
          pitchTarget = clamp(Math.atan2(-forward, up), -0.4, 0.4)
          bankTarget = clamp(Math.atan2(right, Math.hypot(forward, up)), -0.4, 0.4)
        }
      }
      // Wing navigation banks toward the route while the nose follows the measured air course.
      // An instantaneous waypoint bearing is not a physically coordinated yaw command.
      const yawTarget = phase === 'cruise' ? Math.atan2(airNed[1], airNed[0]) : heading
      const desired = multiplyQuaternion([Math.cos(yawTarget / 2), 0, 0, Math.sin(yawTarget / 2)], quaternionFromTilt(bankTarget, pitchTarget))
      const error = multiplyQuaternion([q![0], -q![1], -q![2], -q![3]], desired)
      const turnRate = phase === 'cruise' ? vtolModel.gravityMps2 * Math.tan(bankTarget) / Math.max(8, speed) : 0
      const turnRates = rotateNedToBody(q!, [0, 0, turnRate])
      const desiredRates = error.slice(1).map((n, i) => clamp(8 * n * (error[0] < 0 ? -1 : 1) + turnRates[i]!, i === 2 ? -1.5 : -3, i === 2 ? 1.5 : 3))
      const torque = desiredRates.map((n, i) => ratePid[i]!.step(n - rates![i]!, rates![i]!, dtS)) as SensorVector
      const pusher = rotary ? 0 : clamp((-zero.forceN[0] + vtolModel.massKg * clamp((13 - speed) * 1.2, -2.5, 2.5)) / vtolModel.maxPusherThrustN, 0, 1)
      const coefficients = [pressureArea * airModel.spanM * 0.12, pressureArea * airModel.chordM * 0.8, pressureArea * airModel.spanM * 0.08]
      const surfaces = torque.map((n, i) => coefficients[i]! > 1e-6 ? clamp((n - zero.torqueNm[i]!) / coefficients[i]!, -0.4, 0.4) : 0)
      const aero = airAerodynamics(relative, rates!, [pusher, ...surfaces, 0])
      const aeroNed = rotateBodyToNed(q!, aero.forceN)
      const collective = clamp((requiredUpN + aeroNed[2]) / Math.max(0.7, Math.cos(roll) * Math.cos(pitch)), 0, 48)
      const allocation = allocateVtolLift({ thrustN: collective, torqueNm: torque.map((n, i) => n - aero.torqueNm[i]!) as SensorVector })
      for (let i = 0; i < 3; i++) ratePid[i]!.track(allocation.achieved.torqueNm[i]! + aero.torqueNm[i]! - torque[i]!, dtS)
      const response = output(c, [...allocation.rotorsN, pusher, ...surfaces], phase === 'front-transition' ? 'force-managed-front-transition' : phase === 'cruise' ? 'wing-borne-cruise' : phase === 'back-transition' ? 'force-managed-back-transition' : 'force-managed-hover')
      const source = Math.min(measurement!.capturedAtMs, c.measurementPose!.attitudeCapturedAtMs, c.measurementPose!.gyroCapturedAtMs, c.estimate.attitude!.capturedAtMs!, c.estimate.localPosition!.capturedAtMs!, c.controlRate!.capturedAtMs)
      if (incoming && incoming.eventId !== confirmedEvent && source >= incoming.issuedAtMs) {
        const stable = incoming.mode === 'cruise'
          ? speed >= 12 && speed <= 14 && Math.abs(alpha) < 0.15 && Math.abs(beta) < 0.15 && Math.abs(roll) < 0.25 && Math.abs(pitch) < 0.25 && Math.abs(velocity![2]) < 0.4 && Math.abs(position![2] - incoming.positionM[2]) < 1 && (values.rotorThrustN as number) < 1 && collective < 1
          : Math.hypot(...velocity!) <= 0.2 && Math.hypot(...rates!) < 0.1 && Math.abs(wrap(incoming.headingRad - yaw)) <= 0.1 && Math.abs(roll) < 0.1 && Math.abs(pitch) < 0.1 && Math.hypot(...position!.map((n, i) => n - incoming.positionM[i]!)) < 0.3 && (values.rotorThrustN as number) > 20 && (values.rotorThrustN as number) < 30
        if (!stable) { stableSource = null; stableDecision = null }
        else { stableSource ??= source; stableDecision ??= c.nowMs }
        const confirmed = stable && source - stableSource! >= 500 && c.nowMs - stableDecision! >= 500
        if (confirmed) { phase = incoming.mode; confirmedEvent = incoming.eventId }
        response.transition = { evidence: 'modeled-vtol-controller-observation', eventId: incoming.eventId, taskId: incoming.taskId, mode: incoming.mode, reference: incoming.reference, capturedAtMs: c.nowMs, measurementCapturedAtMs: source, phase, outcome: confirmed ? 'confirmed' : 'progress', reason: confirmed ? incoming.mode === 'cruise' ? 'wing-support-qualified' : 'hover-support-qualified' : incoming.mode === 'cruise' ? 'wing-support-observing' : 'hover-support-observing' }
      }
      return response
    },
  }
}
