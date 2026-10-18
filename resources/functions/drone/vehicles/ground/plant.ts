import type { VehiclePlant, VehiclePlantState } from '../types'

export const groundModel = Object.freeze({ massKg: 25, yawInertiaKgM2: 3, wheelInertiaKgM2: 0.08, radiusM: 0.15, trackM: 0.6, motorTorqueNm: 3, brakeTorqueNm: 4, grip: 0.65, contactStiffnessNsM: 160, lateralStiffnessNsM: 320, rollingDragNsM: 4, yawDragNms: 1.5, wheelDragNms: 0.05, encoderCountsPerRev: 4096, bodyRadiusM: 0.5 })
const clip = (n: number, max: number) => Math.max(-max, Math.min(max, n))
/** Dynamic differential drive: wheel angular inertia, slip forces and planar rigid body. Wheel torque neutral is unpowered; the separate spring-brake neutral engages. */
export function createGroundPlant(options: { friction?: number } = {}): VehiclePlant {
  const mu = options.friction ?? groundModel.grip
  if (!Number.isFinite(mu) || mu < 0.01 || mu > 1) throw new RangeError('Invalid modeled wheel friction')
  let n = 0, e = 0, yaw = 0, speed = 0, lateral = 0, rate = 0, left = 0, right = 0, leftAngle = 0, rightAngle = 0, mower = 0
  let state: VehiclePlantState
  function update(an = 0, ae = 0) {
    state = { positionM: [n, e, 0], velocityMps: [speed * Math.cos(yaw) - lateral * Math.sin(yaw), speed * Math.sin(yaw) + lateral * Math.cos(yaw), 0], accelerationMps2: [an, ae, 0], angularRateRadS: [0, 0, rate], quaternionWxyz: [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)], onSurface: true, details: { leftWheelRadS: left, rightWheelRadS: right, leftAngleRad: leftAngle, rightAngleRad: rightAngle, speedMps: speed, lateralMps: lateral, yawRad: yaw, mowerEnabled: mower > 0, friction: mu } }
  }
  update()
  return {
    snapshot: () => structuredClone(state),
    step(command, dt, environment) {
      if (!Array.isArray(command) || command.length !== 4 || !command.every(Number.isFinite) || Math.abs(command[0]!) > 1 || Math.abs(command[1]!) > 1 || command[2]! < 0 || command[2]! > 1 || command[3]! < 0 || command[3]! > 1 || !Number.isFinite(dt) || dt <= 0 || dt > 0.01 || !environment.windMps.every(Number.isFinite) || !environment.currentMps.every(Number.isFinite)) throw new RangeError('Invalid modeled ground step')
      const m = groundModel
      const lateralForce = clip(-m.lateralStiffnessNsM * lateral, mu * m.massKg * 9.80665)
      const longitudinalLimit = Math.sqrt(Math.max(0, (mu * m.massKg * 9.80665 / 2) ** 2 - (lateralForce / 2) ** 2))
      const fl = clip(m.contactStiffnessNsM * (left * m.radiusM - (speed - rate * m.trackM / 2)), longitudinalLimit)
      const fr = clip(m.contactStiffnessNsM * (right * m.radiusM - (speed + rate * m.trackM / 2)), longitudinalLimit)
      const acceleration = (fl + fr - m.rollingDragNsM * speed) / m.massKg
      const angularAcceleration = ((fr - fl) * m.trackM / 2 - m.yawDragNms * rate) / m.yawInertiaKgM2
      left += (command[0]! * m.motorTorqueNm - fl * m.radiusM - m.wheelDragNms * left) / m.wheelInertiaKgM2 * dt
      right += (command[1]! * m.motorTorqueNm - fr * m.radiusM - m.wheelDragNms * right) / m.wheelInertiaKgM2 * dt
      // Normally engaged mechanical brake removes wheel momentum, never drives reverse.
      const brakeDelta = command[3]! * m.brakeTorqueNm / m.wheelInertiaKgM2 * dt
      left = Math.sign(left) * Math.max(0, Math.abs(left) - brakeDelta)
      right = Math.sign(right) * Math.max(0, Math.abs(right) - brakeDelta)
      leftAngle += left * dt; rightAngle += right * dt
      const an = acceleration * Math.cos(yaw) - lateralForce / m.massKg * Math.sin(yaw)
      const ae = acceleration * Math.sin(yaw) + lateralForce / m.massKg * Math.cos(yaw)
      const vn = speed * Math.cos(yaw) - lateral * Math.sin(yaw) + an * dt
      const ve = speed * Math.sin(yaw) + lateral * Math.cos(yaw) + ae * dt
      rate += angularAcceleration * dt; yaw += rate * dt
      speed = vn * Math.cos(yaw) + ve * Math.sin(yaw)
      lateral = -vn * Math.sin(yaw) + ve * Math.cos(yaw)
      n += vn * dt; e += ve * dt; mower = command[2]!
      update(an, ae)
      if (![n, e, yaw, speed, lateral, rate, left, right].every(Number.isFinite)) throw new RangeError('Ground model diverged')
      return structuredClone(state)
    },
  }
}
