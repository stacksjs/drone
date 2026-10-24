import type { VehicleController, VehicleControllerContext, VehicleControlOutput, VehicleVtolTransitionCommand, VehicleVtolTransitionObservation, VehicleVtolBackCaptureForecast } from '../types'
import type { SensorVector } from '../../sensors/types'
import type { Quaternion } from '../../estimation/frames'
import { createVehicleMeasurementQualifier, vehicleReference } from '../measurements'
import { quaternionEuler, quaternionFromTilt, multiplyQuaternion, normalizeQuaternion } from '../../estimation/frames'
import { rotateBodyToNed, rotateNedToBody } from '../../controls/physics'
import { createBoundedPid } from '../../controls/pid'
import type { BoundedPid } from '../../controls/pid'
import { airModel } from '../air/plant'
import { createVtolVehicleHoverController } from './controller'
import { numericPacket } from './packets'
import { createVtolBackCaptureResourceObserver, forecastVtolBackCapture, observeVtolBackCaptureMotion, validVtolBackCapturePolicy, vtolBackCaptureModel } from './back-capture'
import { allocateVtolLift } from './allocation'
import { vtolAerodynamics, vtolModel } from './plant'

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n))
const wrap = (n: number) => Math.atan2(Math.sin(n), Math.cos(n))
const pauseLoiterRadiusM = 60
const velocityProportionalGain = 1.6

interface FlightSeed {
  ratePid: BoundedPid[], velocityPid: BoundedPid[], hasWingControl: boolean, backSlow: boolean,
  loiterCenter: SensorVector | null, landingTask: string, approachDownM: number | null,
  lastNow: number | null, identity: string | null, fault: string,
  phase: VehicleVtolTransitionObservation['phase'], request: VehicleVtolTransitionCommand | null,
  signature: string, confirmedEvent: string, stableSource: number | null, stableDecision: number | null,
  lastMissionTask: string | null, recoveryBinding: { eventId: string, signature: string } | null,
  approachUntilMs: number | null, criticalLanding: boolean,
}
interface ForecastControl extends VehicleController { scheduleBrake(atMs: number): void, rotaryCaptured(): boolean }
interface FlightControl extends ForecastControl { forkForForecast(atMs: number): ForecastControl }
/** Original fictional pressure/force-aware lift-and-cruise control, undergoing owned-model qualification. */
export function createVtolFlightController(): VehicleController {
  const controller = createFlightController()
  return { step: controller.step }
}
function createFlightController(seed?: FlightSeed, forecasting = false): FlightControl {
  const qualifier = createVehicleMeasurementQualifier('vtol'), hover = createVtolVehicleHoverController()
  const ratePid = seed?.ratePid ?? [0, 1, 2].map(i => createBoundedPid({ kp: i === 2 ? 0.96 : 1.6, ki: i === 2 ? 0.48 : 0.8, kd: 0.02, integralLimit: 1, outputLimit: i === 2 ? 2 : 6, derivativeTauS: 0.03, trackingGain: 4 }))
  const velocityPid = seed?.velocityPid ?? [0, 1, 2].map(() => createBoundedPid({ kp: velocityProportionalGain, ki: 0.25, kd: 0, integralLimit: 1.5, outputLimit: 3, derivativeTauS: 0.03, trackingGain: 1 }))
  let hasWingControl = seed?.hasWingControl ?? false, backSlow = seed?.backSlow ?? false
  let loiterCenter: SensorVector | null = seed?.loiterCenter ?? null
  let landingTask = seed?.landingTask ?? '', approachDownM: number | null = seed?.approachDownM ?? null
  let lastNow: number | null = seed?.lastNow ?? null, identity: string | null = seed?.identity ?? null, fault = seed?.fault ?? ''
  let phase: VehicleVtolTransitionObservation['phase'] = seed?.phase ?? 'hover', request: VehicleVtolTransitionCommand | null = seed?.request ?? null, signature = seed?.signature ?? '', confirmedEvent = seed?.confirmedEvent ?? ''
  let stableSource: number | null = seed?.stableSource ?? null, stableDecision: number | null = seed?.stableDecision ?? null
  let lastMissionTask: string | null = seed?.lastMissionTask ?? null, recoveryBinding: { eventId: string, signature: string } | null = seed?.recoveryBinding ?? null
  let approachUntilMs = seed?.approachUntilMs ?? null
  let criticalLanding = seed?.criticalLanding ?? false
  let backForecast: VehicleVtolBackCaptureForecast | null = null
  let observeBackResources: ReturnType<typeof createVtolBackCaptureResourceObserver> | null = null
  let lastPlanningSource: number | null = null, lastPlanningFreshAt: number | null = null
  function output(c: VehicleControllerContext, actuators: number[], reason: string, inhibited = false): VehicleControlOutput { return { kind: 'simulated-vehicle-control', vehicle: 'vtol', atMs: c.nowMs, actuators: [...actuators], reason, inhibited, physicalFlightEnabled: false, boardOutputsInhibited: true } }
  function neutral(c: VehicleControllerContext, reason: string) { fault ||= reason; return output(c, [0, 0, 0, 0, 0, 0, 0, 0], fault, true) }
  const control: FlightControl = {
    scheduleBrake(atMs) { approachUntilMs = atMs },
    rotaryCaptured() { return backSlow },
    forkForForecast(atMs) {
      return createFlightController({ ratePid: ratePid.map(pid => pid.fork()), velocityPid: velocityPid.map(pid => pid.fork()), hasWingControl, backSlow,
        loiterCenter: loiterCenter ? [...loiterCenter] : null, landingTask, approachDownM, lastNow: atMs - 20, identity, fault, phase,
        request: request ? structuredClone(request) : null, signature, confirmedEvent, stableSource, stableDecision, lastMissionTask,
        recoveryBinding: recoveryBinding ? { ...recoveryBinding } : null, approachUntilMs, criticalLanding }, true)
    },
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
      const priorTask = lastMissionTask
      lastMissionTask = c.mission.taskId
      const incoming = c.mission.transition
      if (incoming) {
        let anchor: number[]
        try { anchor = numericPacket(incoming.positionM, 3) }
        catch { return neutral(c, 'vtol-flight-request-unqualified') }
        if (c.mission.taskKind !== 'vtol-mode' || incoming.taskId !== c.mission.taskId || typeof incoming.eventId !== 'string' || !incoming.eventId || incoming.eventId.length > 256 || incoming.reference !== measurement!.reference || !['hover', 'cruise'].includes(incoming.mode) || !Number.isFinite(incoming.headingRad) || Math.abs(incoming.headingRad) > Math.PI || anchor.some((n, i) => n !== target[i]) || !Number.isSafeInteger(incoming.issuedAtMs) || incoming.issuedAtMs < 0 || !Number.isSafeInteger(incoming.expiresAtMs) || incoming.issuedAtMs > c.nowMs || incoming.expiresAtMs <= c.nowMs || incoming.expiresAtMs <= incoming.issuedAtMs || incoming.expiresAtMs - incoming.issuedAtMs > (incoming.mode === 'hover' ? 45000 : 15000)) return neutral(c, 'vtol-flight-request-unqualified')
        if (incoming.planning !== undefined && (!validVtolBackCapturePolicy(incoming.planning) || incoming.mode !== 'hover' || !hasWingControl || incoming.supersedesEventId !== undefined)) return neutral(c, 'vtol-flight-request-unqualified')
        const encoded = JSON.stringify(incoming)
        if (request?.eventId === incoming.eventId && signature !== encoded) return neutral(c, 'vtol-flight-request-changed')
        const superseding = incoming.supersedesEventId !== undefined, replacing = request?.eventId !== incoming.eventId
        const recovery = c.mission.recovery
        const recoverySignature = recovery ? JSON.stringify([recovery.failedEventId, recovery.failedTaskId, recovery.hoverTaskId, recovery.triggeredAtMs, recovery.cause]) : ''
        if (recoveryBinding?.eventId === incoming.eventId && recoveryBinding.signature !== recoverySignature) return neutral(c, 'vtol-recovery-request-changed')
        if (replacing && (recovery || superseding)) {
          if (!recovery || incoming.mode !== 'hover' || recovery.hoverTaskId !== incoming.taskId || recovery.triggeredAtMs !== incoming.issuedAtMs || !['timeout', 'controller-aborted', 'operator-abort', 'operator-pause', 'operator-recover'].includes(recovery.cause)) return neutral(c, 'vtol-recovery-request-unqualified')
          if (recovery.failedEventId === null) {
            if (superseding || recovery.failedTaskId !== priorTask || request && confirmedEvent !== request.eventId || !['operator-abort', 'operator-pause', 'operator-recover'].includes(recovery.cause)) return neutral(c, 'vtol-recovery-request-unqualified')
          }
          else if (!superseding || !request || incoming.supersedesEventId !== request.eventId || recovery.failedEventId !== request.eventId || recovery.failedTaskId !== request.taskId || incoming.reference !== request.reference || incoming.issuedAtMs <= request.issuedAtMs) return neutral(c, 'vtol-recovery-request-unqualified')
          recoveryBinding = { eventId: incoming.eventId, signature: recoverySignature }
        }
        if (replacing && request && confirmedEvent !== request.eventId && !superseding) return neutral(c, 'vtol-pending-request-not-cancelled')
        if (request?.eventId !== incoming.eventId && incoming.mode === 'hover' && !hasWingControl) { request = structuredClone(incoming); signature = encoded }
        if (request?.eventId !== incoming.eventId && incoming.mode === 'cruise') {
          if (phase !== 'hover' || measurement!.values.onSurface) return neutral(c, 'vtol-front-requires-airborne-hover')
          request = structuredClone(incoming); signature = encoded; phase = 'front-transition'; hasWingControl = true; stableSource = null; stableDecision = null
        }
        if (request?.eventId !== incoming.eventId && incoming.mode === 'hover' && hasWingControl) {
          if (phase !== 'cruise' && !superseding) return neutral(c, 'vtol-back-requires-observed-cruise')
          // A correlated replacement keeps rotary capture once reached. Restarting
          // wing braking here would assume forward flow during a position return.
          backSlow = (phase === 'back-transition' || phase === 'hover') && backSlow
          request = structuredClone(incoming); signature = encoded; phase = 'back-transition'; stableSource = null; stableDecision = null
          for (const pid of velocityPid) pid.reset()
          criticalLanding ||= incoming.planning !== undefined
          approachUntilMs = incoming.planning ? incoming.expiresAtMs : null
          backForecast = null; observeBackResources = null; lastPlanningSource = null; lastPlanningFreshAt = null
        }
      }
      if (phase === 'hover' && !hasWingControl) {
        const response = hover.step(c)
        if (response.transition?.outcome === 'confirmed') confirmedEvent = response.transition.eventId
        return response
      }
      const [roll, pitch, yaw] = quaternionEuler(q!), values = measurement!.values
      const speed = values.airspeedMps as number, alpha = values.alphaRad as number, beta = values.betaRad as number
      const landing = phase === 'hover' && c.mission.state === 'running' && c.mission.taskKind === 'land'
      if (landing && landingTask !== c.mission.taskId) { landingTask = c.mission.taskId; approachDownM = position![2] }
      const pausedContact = phase === 'hover' && c.mission.state === 'paused' && values.onSurface === true && values.stopped === true
      if (measurement!.values.onSurface && !landing && !pausedContact || speed > 22 || Math.abs(roll) > 0.6 || Math.abs(pitch) > 0.5 || speed > 8 && (Math.abs(alpha) > 0.32 || Math.abs(beta) > 0.4) || phase !== 'hover' && Math.abs(position![2] - request!.positionM[2]) > 2) return neutral(c, 'vtol-transition-envelope')
      if (landing && measurement!.values.onSurface || pausedContact) return output(c, [0, 0, 0, 0, 0, 0, 0, 0], pausedContact ? 'ground-paused' : 'vertical-contact')
      const capturedRelative: SensorVector = [speed * Math.cos(alpha) * Math.cos(beta), speed * Math.sin(beta), speed * Math.sin(alpha) * Math.cos(beta)]
      const airNed = rotateBodyToNed(captureQ!, capturedRelative)
      const relative = rotateNedToBody(q!, airNed)
      const gamma = Math.atan2(-airNed[2], Math.hypot(airNed[0], airNed[1]))
      let forecastUpdated = false
      if (!forecasting && phase === 'back-transition' && request!.planning && !backForecast) {
        const source = Math.min(measurement!.capturedAtMs, c.measurementPose!.positionCapturedAtMs, c.measurementPose!.attitudeCapturedAtMs, c.measurementPose!.gyroCapturedAtMs)
        if (source >= request!.issuedAtMs && c.nowMs - source <= 120 || c.nowMs - request!.issuedAtMs > 220) {
          backForecast = forecastVtolBackCapture(c, request!, { positionM: position!, velocityMps: velocity!, quaternionWxyz: q!, angularRateRadS: rates! }, airNed, () => control.forkForForecast(c.nowMs))
          approachUntilMs = backForecast.brakeAtMs ?? request!.expiresAtMs
          forecastUpdated = true
        }
      }
      if (!forecasting && phase === 'back-transition' && request!.planning && backForecast?.status === 'predicted') {
        const motion = observeVtolBackCaptureMotion(c, request!, airNed)
        observeBackResources ??= createVtolBackCaptureResourceObserver(request!)
        const resources = observeBackResources(c)
        let invalid = motion.status === 'unqualified' ? 'capture-motion-unqualified' : lastPlanningSource !== null && motion.sourceCapturedAtMs !== null && motion.sourceCapturedAtMs < lastPlanningSource ? 'capture-motion-epoch-regressed' : ''
        if (motion.status === 'fresh') {
          if (motion.sampleRadiusMps! > backForecast.windSampleRadiusMps!) invalid ||= 'forecast-uncertainty-expanded'
          if (Math.hypot(...motion.windMps!) + motion.sampleRadiusMps! > vtolBackCaptureModel.maximumWindMps || Math.hypot(...motion.windMps!.map((n, i) => n - backForecast!.windMps![i]!)) + motion.sampleRadiusMps! > backForecast.windSampleRadiusMps!) invalid ||= 'forecast-wind-changed'
          lastPlanningSource = motion.sourceCapturedAtMs; lastPlanningFreshAt = c.nowMs
        }
        else if (lastPlanningFreshAt !== null && c.nowMs - lastPlanningFreshAt > 120) invalid ||= 'capture-motion-stale'
        invalid ||= resources.reason
        if (invalid) {
          backForecast = { ...backForecast, status: 'uncertain', reason: invalid, monitor: { observedAtMs: c.nowMs, sourceCapturedAtMs: motion.sourceCapturedAtMs, windMps: motion.windMps, windSampleRadiusMps: motion.sampleRadiusMps, battery: resources.battery, requiredWh: resources.requiredWh } }
          forecastUpdated = true
          // Lost source continuity cannot produce a fresh correlated abort acknowledgement.
          // Revoke modeled output now instead of waiting for the unchanged request deadline.
          if (invalid === 'capture-motion-epoch-regressed' || invalid === 'capture-motion-stale') return { ...neutral(c, invalid), backCapture: structuredClone(backForecast) }
        }
      }
      const approaching = phase === 'back-transition' && approachUntilMs !== null && c.nowMs < approachUntilMs
      const rotary = (phase === 'back-transition' || phase === 'hover') && !approaching
      let heading = phase === 'front-transition' || rotary ? request!.headingRad : Math.atan2(target![1] - position![1], target![0] - position![0])
      const groundSpeed = Math.hypot(velocity![0], velocity![1])
      const course = groundSpeed > 3 ? Math.atan2(velocity![1], velocity![0]) : yaw
      const pausedCruise = phase === 'cruise' && c.mission.state === 'paused'
      if (!pausedCruise) loiterCenter = null
      else {
        loiterCenter ??= [position![0] - pauseLoiterRadiusM * Math.sin(course), position![1] + pauseLoiterRadiusM * Math.cos(course), target![2]]
        if (Math.hypot(loiterCenter[0], loiterCenter[1]) + pauseLoiterRadiusM > 400) return neutral(c, 'vtol-pause-loiter-outside-envelope')
        const radial = Math.atan2(position![1] - loiterCenter[1], position![0] - loiterCenter[0])
        const distance = Math.hypot(position![0] - loiterCenter[0], position![1] - loiterCenter[1])
        heading = radial + Math.PI / 2 + Math.atan2(distance - pauseLoiterRadiusM, 40)
      }
      const loiterBank = pausedCruise ? Math.atan2(groundSpeed ** 2, vtolModel.gravityMps2 * pauseLoiterRadiusM) : 0
      let bankTarget = clamp(loiterBank + wrap(heading - course) * 0.8, -0.3, 0.3)
      let downAcceleration = clamp((target![2] - position![2]) * 1.2 - velocity![2] * 1.5, -3, 3)
      const pressureArea = (values.differentialPressurePa as number) * airModel.areaM2
      let requiredUpN = vtolModel.massKg * (vtolModel.gravityMps2 - downAcceleration)
      const alphaTarget = clamp((requiredUpN / Math.max(1, pressureArea * Math.cos(bankTarget)) - 0.25) / 4.8, -0.08, 0.18)
      let pitchTarget = clamp(gamma + alphaTarget, -0.2, 0.25) * clamp((speed - 10) / 2, 0, 1)
      const zero = vtolAerodynamics(relative, rates!, [0, 0, 0, 0, 0])
      if (rotary) {
        backSlow ||= speed < 3
        if (!backSlow && phase === 'back-transition') {
          // A requested hover heading is the final capture condition. While
          // wing braking, keep the nose and force search in measured airflow.
          heading = Math.atan2(airNed[1], airNed[0])
          // The linear pre-stall estimate seeds a bounded search of the actual fictional
          // wing/rotor force balance, including stalled drag. Keep the original source and attitude guards.
          const optimalAlpha = Math.max(0, (requiredUpN / Math.max(1, pressureArea) - 0.25) / (2 * 4.8))
          pitchTarget = clamp(gamma + optimalAlpha, -0.08, 0.3)
          bankTarget = 0
          let bestBraking = -Infinity
          const direction = groundSpeed > 0.2 ? [velocity![0] / groundSpeed, velocity![1] / groundSpeed] : [Math.cos(heading), Math.sin(heading)]
          // Planned captures can use the existing rotor-position tilt range below
          // the low-speed air envelope. The original alpha and attitude guards stay
          // active. A 0.3 rad ceiling can strand an updraft in a high-lift glide.
          const maximumBrakingPitch = request!.planning ? vtolBackCaptureModel.maximumBrakingPitchRad : 0.3
          for (const candidate of [pitchTarget, ...Array.from({ length: 41 }, (_, i) => -0.08 + (maximumBrakingPitch + 0.08) * i / 40)]) {
            const pose = multiplyQuaternion([Math.cos(heading / 2), 0, 0, Math.sin(heading / 2)], quaternionFromTilt(0, candidate))
            const body = rotateNedToBody(pose, airNed)
            const wing = vtolAerodynamics(body, [0, 0, 0], [0, 0, 0, 0, 0])
            if (speed > 8 && Math.abs(wing.alphaRad) > 0.3) continue
            const force = rotateBodyToNed(pose, wing.forceN)
            const thrust = (requiredUpN + force[2]) / Math.cos(candidate)
            if (thrust < 0 || thrust > 48) continue
            const rotor = rotateBodyToNed(pose, [0, 0, -thrust])
            const braking = -(direction[0]! * (force[0] + rotor[0]) + direction[1]! * (force[1] + rotor[1]))
            if (braking > bestBraking) { bestBraking = braking; pitchTarget = candidate }
          }
          if (bestBraking === -Infinity) return neutral(c, 'vtol-braking-no-feasible-pitch')
        }
        else {
          const goal = [...target!] as SensorVector
          if (landing) {
            const aligned = Math.hypot(target![0] - position![0], target![1] - position![1]) <= 0.5 && groundSpeed <= 0.2
            if (approachDownM !== null && !aligned) goal[2] = approachDownM
            else { approachDownM = null; goal[2] += 0.1 }
          }
          const desiredVelocity = goal.map((n, i) => n - position![i]!) as SensorVector
          const horizontal = Math.hypot(desiredVelocity[0], desiredVelocity[1])
          if (horizontal > 3) { desiredVelocity[0] *= 3 / horizontal; desiredVelocity[1] *= 3 / horizontal }
          // With acceleration = K_v (K_p * heightError - verticalVelocity),
          // K_p = K_v / 4 gives critical damping instead of a ground-clamped overshoot.
          // This planned-capture flare keeps the original descent cap and task deadline.
          if (landing && criticalLanding) desiredVelocity[2] *= velocityProportionalGain / 4
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
      const yawTarget = phase === 'cruise' || approaching ? Math.atan2(airNed[1], airNed[0]) : heading
      const desired = multiplyQuaternion([Math.cos(yawTarget / 2), 0, 0, Math.sin(yawTarget / 2)], quaternionFromTilt(bankTarget, pitchTarget))
      const error = multiplyQuaternion([q![0], -q![1], -q![2], -q![3]], desired)
      const turnRate = phase === 'cruise' || approaching ? vtolModel.gravityMps2 * Math.tan(bankTarget) / Math.max(8, speed) : 0
      const turnRates = rotateNedToBody(q!, [0, 0, turnRate])
      const desiredRates = error.slice(1).map((n, i) => clamp(8 * n * (error[0] < 0 ? -1 : 1) + turnRates[i]!, i === 2 ? -1.5 : -3, i === 2 ? 1.5 : 3))
      const torque = desiredRates.map((n, i) => ratePid[i]!.step(n - rates![i]!, rates![i]!, dtS)) as SensorVector
      const pusher = rotary ? 0 : clamp((-zero.forceN[0] + vtolModel.massKg * clamp((13 - speed) * 1.2, -2.5, 2.5)) / vtolModel.maxPusherThrustN, 0, 1)
      const coefficients = [pressureArea * airModel.spanM * 0.12, pressureArea * airModel.chordM * 0.8, pressureArea * airModel.spanM * 0.08]
      const surfaces = torque.map((n, i) => coefficients[i]! > 1e-6 ? clamp((n - zero.torqueNm[i]!) / coefficients[i]!, -0.4, 0.4) : 0)
      const aero = vtolAerodynamics(relative, rates!, [pusher, ...surfaces, 0])
      const aeroNed = rotateBodyToNed(q!, aero.forceN)
      const collective = clamp((requiredUpN + aeroNed[2]) / Math.max(0.7, Math.cos(roll) * Math.cos(pitch)), 0, 48)
      const allocation = allocateVtolLift({ thrustN: collective, torqueNm: torque.map((n, i) => n - aero.torqueNm[i]!) as SensorVector })
      for (let i = 0; i < 3; i++) ratePid[i]!.track(allocation.achieved.torqueNm[i]! + aero.torqueNm[i]! - torque[i]!, dtS)
      const response = output(c, [...allocation.rotorsN, pusher, ...surfaces], phase === 'front-transition' ? 'force-managed-front-transition' : phase === 'cruise' ? 'wing-borne-cruise' : approaching ? 'planned-wing-approach' : phase === 'back-transition' ? 'force-managed-back-transition' : 'force-managed-hover')
      const source = Math.min(measurement!.capturedAtMs, c.measurementPose!.attitudeCapturedAtMs, c.measurementPose!.gyroCapturedAtMs, c.estimate.attitude!.capturedAtMs!, c.estimate.localPosition!.capturedAtMs!, c.controlRate!.capturedAtMs, ...(request!.planning ? [c.measurementPose!.positionCapturedAtMs] : []))
      if (incoming && incoming.eventId !== confirmedEvent && source >= incoming.issuedAtMs) {
        const stable = incoming.mode === 'cruise'
          ? speed >= 12 && speed <= 14 && Math.abs(alpha) < 0.15 && Math.abs(beta) < 0.15 && Math.abs(roll) < 0.25 && Math.abs(pitch) < 0.25 && Math.abs(velocity![2]) < 0.4 && Math.abs(position![2] - incoming.positionM[2]) < 1 && (values.rotorThrustN as number) < 1 && collective < 1
          : Math.hypot(...velocity!) <= 0.2 && Math.hypot(...rates!) < 0.1 && Math.abs(wrap(incoming.headingRad - yaw)) <= 0.1 && Math.abs(roll) < 0.1 && Math.abs(pitch) < 0.1 && Math.hypot(...position!.map((n, i) => n - incoming.positionM[i]!)) < 0.3 && (values.rotorThrustN as number) > 20 && (values.rotorThrustN as number) < 30
        if (!stable) { stableSource = null; stableDecision = null }
        else { stableSource ??= source; stableDecision ??= c.nowMs }
        const confirmed = (!backForecast || backForecast.status === 'predicted') && stable && source - stableSource! >= 500 && c.nowMs - stableDecision! >= 500 && (!request!.planning || c.nowMs + 40 - source <= 120)
        if (confirmed) { phase = incoming.mode; confirmedEvent = incoming.eventId }
        response.transition = { evidence: 'modeled-vtol-controller-observation', eventId: incoming.eventId, taskId: incoming.taskId, mode: incoming.mode, reference: incoming.reference, capturedAtMs: c.nowMs, measurementCapturedAtMs: source, phase, outcome: confirmed ? 'confirmed' : 'progress', reason: confirmed ? incoming.mode === 'cruise' ? 'wing-support-qualified' : 'hover-support-qualified' : incoming.mode === 'cruise' ? 'wing-support-observing' : 'hover-support-observing' }
      }
      // A response is consumed on a later mission tick. Reserve the existing maximum 40 ms gap.
      if (request!.planning && c.nowMs + 40 - source > 120) delete response.transition
      if (backForecast && backForecast.status !== 'predicted' && response.transition) response.transition = { ...response.transition, outcome: 'aborted', reason: backForecast.reason }
      if (forecastUpdated && backForecast) response.backCapture = structuredClone(backForecast)
      return response
    },
  }
  return control
}
