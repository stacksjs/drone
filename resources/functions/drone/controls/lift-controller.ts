import type { EstimatorSnapshot } from '../estimation/estimator'
import type { SensorVector } from '../sensors/types'
import type { Motors, Wrench } from './model'
import { multiplyQuaternion, normalizeQuaternion, quaternionFromTilt } from '../estimation/frames'
import { rotateBodyToNed } from './physics'
import { createBoundedPid } from './pid'
import { clampControl, validVector } from './model'
export interface SimulatedControlInput {
  kind: 'simulation'
  enabled: boolean
  nowMs: number
  estimate: EstimatorSnapshot
  angularRateRadS: SensorVector
  rateCapturedAtMs: number
  target: { positionM: SensorVector, yawRad: number, issuedAtMs: number }
}
interface LiftProfile { massKg: number, gravityMps2: number, rateScale: SensorVector, allocate(wrench: Wrench, previous: Motors, dtS: number): { motorsN: Motors, achieved: Wrench, limited: boolean } }
/** Shared simulated lift cascade. Vehicle wrappers own mass, tuning and allocation; no vehicle IO. */
export function createSimulatedLiftController(options: { headingAlignment: 'initial-simulation-north' }, profile: LiftProfile) {
  if (options.headingAlignment !== 'initial-simulation-north') throw new TypeError('An explicit simulation heading alignment is required')
  const model = { massKg: profile.massKg, gravityMps2: profile.gravityMps2 }, allocate = profile.allocate
  const rateScale = Array.isArray(profile.rateScale) ? [...profile.rateScale] : []
  if (!Number.isFinite(model.massKg) || model.massKg <= 0 || !Number.isFinite(model.gravityMps2) || model.gravityMps2 <= 0 || !validVector(rateScale) || rateScale.some(n => n <= 0) || typeof allocate !== 'function') throw new RangeError('Invalid simulated lift profile')
  const velocityPid = [0, 1, 2].map(() => createBoundedPid({ kp: 1.6, ki: 0.25, kd: 0, integralLimit: 1.5, outputLimit: 3, derivativeTauS: 0.03, trackingGain: 1 }))
  const ratePid = [0, 1, 2].map(i => createBoundedPid({ kp: (i === 2 ? 0.08 : 0.12) * rateScale[i]!, ki: (i === 2 ? 0.04 : 0.08) * rateScale[i]!, kd: (i === 2 ? 0.001 : 0.002) * rateScale[i]!, integralLimit: 0.12 * rateScale[i]!, outputLimit: (i === 2 ? 0.25 : 0.6) * rateScale[i]!, derivativeTauS: 0.03, trackingGain: 4 }))
  let previous: Motors = [0, 0, 0, 0], lastNow: number | null = null, reference: string | null = null, fault: string | null = null
  function clear() { for (const pid of [...velocityPid, ...ratePid]) pid.reset(); previous = [0, 0, 0, 0] }
  function inhibit(reason: string, latch = reference !== null) {
    if (latch) fault = reason
    clear()
    return { kind: 'simulated-control' as const, atMs: lastNow, inhibited: true, reason, physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, motorsN: [...previous] as Motors, limited: false, desiredVelocityMps: null, desiredAccelerationMps2: null, desiredRatesRadS: null, desiredWrench: null, achievedWrench: null, integrals: { velocity: velocityPid.map(p => p.state().integral), rate: ratePid.map(p => p.state().integral) } }
  }
  return {
    reset() { clear(); lastNow = null; reference = null; fault = null },
    step(input: SimulatedControlInput) {
      if (input.kind !== 'simulation') return inhibit('simulation-only', true)
      const now = input.nowMs
      if (!Number.isFinite(now) || (lastNow !== null && now <= lastNow)) return inhibit('control-clock-discontinuity', true)
      const dt = lastNow === null ? 0.02 : (now - lastNow) / 1000
      lastNow = now
      if (!input.enabled) { reference = null; fault = null; return inhibit('disabled', false) }
      if (fault) return inhibit(fault, true)
      if (dt < 0.005 || dt > 0.04) return inhibit('control-schedule-gap', true)
      const e = input.estimate, attitude = e?.attitude, position = e?.localPosition, target = input.target
      if (!e || typeof e.bootId !== 'bigint' || e.bootId <= 0n || !Object.values(e.resets).every(n => Number.isInteger(n) && n >= 0) || e.evidence !== 'fixture' || e.physicalFlightEnabled !== false || !e.health.tilt || !e.health.localPosition || !attitude || !position) return inhibit('estimator-unhealthy')
      if (!Number.isFinite(e.nowMs) || Math.abs(e.nowMs - now) > 1e-6 || attitude.capturedAtMs === null || !Number.isFinite(attitude.capturedAtMs) || attitude.capturedAtMs > now || now - attitude.capturedAtMs > 60
        || position.capturedAtMs === null || !Number.isFinite(position.capturedAtMs) || !Number.isFinite(position.predictedToMs) || position.predictedToMs > now || now - position.predictedToMs > 40 || position.capturedAtMs > now || now - position.capturedAtMs > 200 || !Number.isFinite(input.rateCapturedAtMs) || input.rateCapturedAtMs > now || now - input.rateCapturedAtMs > 60) return inhibit('stale-control-observation')
      if (attitude.reference !== 'GRAVITY_ALIGNED_RELATIVE_YAW' || position.frame !== 'LOCAL_NED' || position.altitudeDatum !== 'WGS84_ELLIPSOID' || !validVector(position.positionM) || !validVector(position.velocityMps) || !validVector(input.angularRateRadS)
        || !position.origin || ![position.origin.latitudeDeg, position.origin.longitudeDeg, position.origin.ellipsoidHeightM].every(Number.isFinite) || Math.hypot(...input.angularRateRadS) > 35 || attitude.quaternionWxyz.length !== 4 || !attitude.quaternionWxyz.every(Number.isFinite) || Math.abs(Math.hypot(...attitude.quaternionWxyz) - 1) > 1e-6) return inhibit('invalid-control-frame-or-values')
      if (Math.abs(input.rateCapturedAtMs - attitude.capturedAtMs) > 1e-6) return inhibit('unmatched-rate-epoch')
      if (!target || !validVector(target.positionM) || Math.hypot(...target.positionM) > 100 || !Number.isFinite(target.yawRad) || Math.abs(target.yawRad) > Math.PI || !Number.isFinite(target.issuedAtMs) || target.issuedAtMs > now || now - target.issuedAtMs > 200) return inhibit('invalid-or-stale-target')
      const identity = JSON.stringify([String(e.bootId), e.resets, position.origin])
      if (reference !== null && identity !== reference) return inhibit('estimator-reference-reset', true)
      reference = identity
      const velocity = target.positionM.map((n, i) => n - position.positionM[i]!) as SensorVector
      const horizontal = Math.hypot(velocity[0], velocity[1])
      if (horizontal > 3) { velocity[0] *= 3 / horizontal; velocity[1] *= 3 / horizontal }
      velocity[2] = clampControl(velocity[2], 2)
      const acceleration = velocity.map((n, i) => velocityPid[i]!.step(n - position.velocityMps[i]!, position.velocityMps[i]!, dt)) as SensorVector
      const beforeLimit = [...acceleration]
      const horizontalAcceleration = Math.hypot(acceleration[0], acceleration[1]), tiltBound = Math.tan(25 * Math.PI / 180) * (model.gravityMps2 - acceleration[2])
      if (horizontalAcceleration > Math.min(3, tiltBound)) {
        const scale = Math.min(3, tiltBound) / horizontalAcceleration
        acceleration[0] *= scale; acceleration[1] *= scale
      }
      for (let i = 0; i < 3; i++) velocityPid[i]!.track(acceleration[i]! - beforeLimit[i]!, dt)
      const yaw = target.yawRad, ax = Math.cos(yaw) * acceleration[0] + Math.sin(yaw) * acceleration[1], ay = -Math.sin(yaw) * acceleration[0] + Math.cos(yaw) * acceleration[1]
      const vertical = model.gravityMps2 - acceleration[2]
      const desired = multiplyQuaternion([Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], quaternionFromTilt(Math.atan2(ay, Math.hypot(ax, vertical)), Math.atan2(-ax, vertical)))
      const q = normalizeQuaternion(attitude.quaternionWxyz)
      // First align the thrust direction without twisting about it. An
      // unattainable yaw goal must not rotate the position correction.
      const from = rotateBodyToNed(q, [0, 0, 1]), to = rotateBodyToNed(desired, [0, 0, 1])
      const dot = Math.max(-1, Math.min(1, from.reduce((sum, n, i) => sum + n * to[i]!, 0)))
      if (1 + dot <= 1e-8) return inhibit('antipodal-thrust-direction')
      const alignment = normalizeQuaternion([1 + dot, from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0]])
      const reduced = normalizeQuaternion(multiplyQuaternion(alignment, q))
      const tiltError = multiplyQuaternion([q[0], -q[1], -q[2], -q[3]], reduced)
      const yawError = multiplyQuaternion([reduced[0], -reduced[1], -reduced[2], -reduced[3]], desired)
      const correction = [tiltError[1] * (tiltError[0] < 0 ? -1 : 1), tiltError[2] * (tiltError[0] < 0 ? -1 : 1), yawError[3] * (yawError[0] < 0 ? -1 : 1)]
      const rates = correction.map((n, i) => clampControl(8 * n, i === 2 ? 1.5 : 3)) as SensorVector
      const torque = rates.map((n, i) => ratePid[i]!.step(n - input.angularRateRadS[i]!, input.angularRateRadS[i]!, dt)) as SensorVector
      const desiredWrench = { thrustN: model.massKg * Math.hypot(...[acceleration[0], acceleration[1], vertical]), torqueNm: torque }
      const allocation = allocate(desiredWrench, previous, dt)
      for (let i = 0; i < 3; i++) ratePid[i]!.track(allocation.achieved.torqueNm[i]! - torque[i]!, dt)
      previous = allocation.motorsN
      return { kind: 'simulated-control' as const, atMs: lastNow, inhibited: false, reason: 'simulation-feedback', physicalFlightEnabled: false as const, boardOutputsInhibited: true as const, motorsN: [...previous] as Motors, limited: allocation.limited, desiredVelocityMps: velocity, desiredAccelerationMps2: acceleration, desiredRatesRadS: rates, desiredWrench, achievedWrench: allocation.achieved, integrals: { velocity: velocityPid.map(p => p.state().integral), rate: ratePid.map(p => p.state().integral) } }
    },
  }
}
export type SimulatedControlOutput = ReturnType<ReturnType<typeof createSimulatedLiftController>['step']>
