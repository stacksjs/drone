import type { SensorVector } from '../../sensors/types'
import type { Quaternion } from '../../estimation/frames'
import type { VehiclePlant, VehiclePlantState } from '../types'
import { validVector } from '../../controls/model'
import { multiplyQuaternion, normalizeQuaternion } from '../../estimation/frames'
import { rotateBodyToNed, rotateNedToBody } from '../../controls/physics'
import { airAerodynamics, airModel } from '../air/plant'
import { numericPacket } from './packets'
import { vtolElectricalLoad, vtolElectricalMaximumW, vtolElectricalModel, vtolElectricalSupply } from './power'

/** Fictional lift-and-cruise model. No measured hardware coefficients or flight qualification. */
export const vtolModel = Object.freeze({ aerodynamicsModel: 'projected-incidence-v3' as const, massKg: 2.5, surfaceFrictionCoefficient: 0.5, gravityMps2: 9.80665, maxRotorThrustN: 12, rotorTimeConstantS: 0.06, rotorSlewNPerS: 120, rotorArmProjectionM: 0.4, reactionTorqueM: 0.02, inertiaKgM2: Object.freeze([0.3, 0.4, 0.6] as const), maxPusherThrustN: airModel.maxThrustN, pusherTimeConstantS: 0.08, pusherSlewNPerS: 60, wing: airModel })

/** Fictional projected-flow extension, not measured post-stall, spanwise or reverse-flight data. */
export function vtolAerodynamics(relativeBodyMps: SensorVector, rateRadS: SensorVector, actuators: number[]) {
  return airAerodynamics(relativeBodyMps, rateRadS, actuators, true)
}

/** Independent lift rotors and the owned trainer wing/pusher share one rigid body. */
export function createVtolPlant(initial: { positionM?: SensorVector, velocityMps?: SensorVector, quaternionWxyz?: Quaternion, rotorsN?: [number, number, number, number], pusherThrustN?: number, electricalCapacityWh?: number, energyUsedWh?: number } = {}): VehiclePlant {
  const capacityWh = initial.electricalCapacityWh
  let energyUsedWh = initial.energyUsedWh === undefined ? 0 : initial.energyUsedWh
  if (capacityWh === undefined && initial.energyUsedWh !== undefined || capacityWh !== undefined && (!Number.isFinite(capacityWh) || capacityWh <= 0 || capacityWh > 10000 || !Number.isFinite(energyUsedWh) || energyUsedWh < 0 || energyUsedWh > capacityWh)) throw new RangeError('Invalid initial VTOL electrical state')
  const maximumSourceW = capacityWh === undefined ? 0 : vtolElectricalMaximumW(vtolModel.maxRotorThrustN, vtolModel.maxPusherThrustN)
  let batteryCutoff = capacityWh !== undefined && energyUsedWh === capacityWh, surfacesRad = [0, 0, 0]
  let positionM = numericPacket(initial.positionM === undefined ? [0, 0, 0] : initial.positionM, 3) as SensorVector
  let rotorsN = numericPacket(initial.rotorsN === undefined ? [0, 0, 0, 0] : initial.rotorsN, 4)
  let pusherThrustN = initial.pusherThrustN === undefined ? 0 : initial.pusherThrustN
  let velocityMps = numericPacket(initial.velocityMps === undefined ? [0, 0, 0] : initial.velocityMps, 3) as SensorVector, accelerationMps2: SensorVector = [0, 0, 0]
  let windMps: SensorVector = [0, 0, 0]
  let quaternionWxyz = normalizeQuaternion(numericPacket(initial.quaternionWxyz === undefined ? [1, 0, 0, 0] : initial.quaternionWxyz, 4) as Quaternion), angularRateRadS: SensorVector = [0, 0, 0]
  if (!validVector(positionM) || !validVector(velocityMps) || positionM[2] > 0 || rotorsN.length !== 4 || rotorsN.some(n => !Number.isFinite(n) || n < 0 || n > vtolModel.maxRotorThrustN) || !Number.isFinite(pusherThrustN) || pusherThrustN < 0 || pusherThrustN > vtolModel.maxPusherThrustN) throw new RangeError('Invalid initial VTOL model')
  let onSurface = positionM[2] === 0
  function electricalDetails(): VehiclePlantState['details'] {
    if (capacityWh === undefined) return {}
    const remainingWh = capacityWh - energyUsedWh
    const loadW = remainingWh === 0 ? 0 : batteryCutoff ? vtolElectricalModel.auxiliaryW : vtolElectricalLoad(rotorsN, pusherThrustN, surfacesRad)
    const supply = vtolElectricalSupply(loadW, remainingWh / capacityWh)
    return { batteryCapacityWh: capacityWh, batteryEnergyUsedWh: energyUsedWh, batteryRemainingWh: remainingWh, batteryLoadPowerW: loadW, batterySourcePowerW: supply.sourceW, batteryCurrentA: supply.currentA, batteryTerminalV: supply.terminalV, batteryCutoff }
  }
  function snapshot(): VehiclePlantState {
    const relative = rotateNedToBody(quaternionWxyz, velocityMps.map((n, i) => n - windMps[i]!) as SensorVector)
    const airspeedMps = Math.hypot(...relative)
    return { positionM: [...positionM], velocityMps: [...velocityMps], accelerationMps2: [...accelerationMps2], quaternionWxyz: [...quaternionWxyz], angularRateRadS: [...angularRateRadS], onSurface, details: { airspeedMps, alphaRad: Math.atan2(relative[2], relative[0]), betaRad: Math.atan2(relative[1], Math.hypot(relative[0], relative[2])), dynamicPressurePa: 0.5 * airModel.densityKgM3 * airspeedMps ** 2, rotorThrustN: rotorsN.reduce((a, b) => a + b, 0), pusherThrustN, ...electricalDetails() } }
  }
  return {
    snapshot,
    step(inputActuators, dtS, environment) {
      let actuators = numericPacket(inputActuators, 8)
      const nextWindMps = numericPacket(environment.windMps, 3) as SensorVector, currentMps = numericPacket(environment.currentMps, 3) as SensorVector
      if (actuators.slice(0, 4).some(n => n < 0 || n > vtolModel.maxRotorThrustN) || actuators[4]! < 0 || actuators[4]! > 1 || actuators.slice(5).some(n => Math.abs(n) > 0.4)) throw new RangeError('Invalid VTOL actuator channels')
      if (!Number.isFinite(dtS) || dtS <= 0 || dtS > 0.01 || !validVector(nextWindMps) || !validVector(currentMps) || currentMps.some(n => n !== 0)) throw new RangeError('Invalid VTOL environment')
      // Fund a whole worst-case step before allowing propulsion. A latched cutoff cannot rebound/rearm.
      const nextBatteryCutoff = batteryCutoff || capacityWh !== undefined && capacityWh - energyUsedWh < maximumSourceW * dtS / 3600
      if (nextBatteryCutoff) actuators = [0, 0, 0, 0, 0, 0, 0, 0]
      const relative = rotateNedToBody(quaternionWxyz, velocityMps.map((n, i) => n - nextWindMps[i]!) as SensorVector)
      const response = 1 - Math.exp(-dtS / vtolModel.rotorTimeConstantS), maximumChangeN = vtolModel.rotorSlewNPerS * dtS
      const nextRotorsN = rotorsN.map((n, i) => n + Math.max(-maximumChangeN, Math.min(maximumChangeN, (actuators[i]! - n) * response)))
      const pusherChangeN = (actuators[4]! * vtolModel.maxPusherThrustN - pusherThrustN) * (1 - Math.exp(-dtS / vtolModel.pusherTimeConstantS))
      const pusherMaximumChangeN = vtolModel.pusherSlewNPerS * dtS
      const nextPusherThrustN = pusherThrustN + Math.max(-pusherMaximumChangeN, Math.min(pusherMaximumChangeN, pusherChangeN))
      const aero = vtolAerodynamics(relative, angularRateRadS, [nextPusherThrustN / vtolModel.maxPusherThrustN, actuators[5]!, actuators[6]!, actuators[7]!, 0])
      // Front-left, front-right, rear-right, rear-left. Rotor reaction signs are +, -, +, - about BODY_FRD z.
      const torqueNm: SensorVector = [
        aero.torqueNm[0] + vtolModel.rotorArmProjectionM * (nextRotorsN[0]! - nextRotorsN[1]! - nextRotorsN[2]! + nextRotorsN[3]!),
        aero.torqueNm[1] + vtolModel.rotorArmProjectionM * (nextRotorsN[0]! + nextRotorsN[1]! - nextRotorsN[2]! - nextRotorsN[3]!),
        aero.torqueNm[2] + vtolModel.reactionTorqueM * (nextRotorsN[0]! - nextRotorsN[1]! + nextRotorsN[2]! - nextRotorsN[3]!),
      ]
      const momentum = angularRateRadS.map((n, i) => n * vtolModel.inertiaKgM2[i]!)
      const cross: SensorVector = [angularRateRadS[1] * momentum[2]! - angularRateRadS[2] * momentum[1]!, angularRateRadS[2] * momentum[0]! - angularRateRadS[0] * momentum[2]!, angularRateRadS[0] * momentum[1]! - angularRateRadS[1] * momentum[0]!]
      const nextAngularRateRadS = angularRateRadS.map((n, i) => n + dtS * (torqueNm[i]! - cross[i]!) / vtolModel.inertiaKgM2[i]!) as SensorVector
      if (!nextAngularRateRadS.every(Number.isFinite) || Math.hypot(...nextAngularRateRadS) > 40) throw new RangeError('VTOL rotor model diverged')
      const angle = Math.hypot(...nextAngularRateRadS) * dtS, scale = angle < 1e-10 ? dtS / 2 : Math.sin(angle / 2) * dtS / angle
      const nextQuaternionWxyz = normalizeQuaternion(multiplyQuaternion(quaternionWxyz, [Math.cos(angle / 2), nextAngularRateRadS[0] * scale, nextAngularRateRadS[1] * scale, nextAngularRateRadS[2] * scale]))
      const forceN = rotateBodyToNed(nextQuaternionWxyz, [aero.forceN[0], aero.forceN[1], aero.forceN[2] - nextRotorsN.reduce((a, b) => a + b, 0)])
      const nextAccelerationMps2 = forceN.map((n, i) => n / vtolModel.massKg + (i === 2 ? vtolModel.gravityMps2 : 0)) as SensorVector
      const nextVelocityMps = velocityMps.map((n, i) => n + nextAccelerationMps2[i]! * dtS) as SensorVector
      const nextOnSurface = positionM[2] + nextVelocityMps[2] * dtS >= 0
      if (nextOnSurface) {
        // Fictional flat skids: bounded Coulomb friction from the modeled normal support.
        // No impact impulse, terrain, gear deformation, tipping or damage model is implied.
        const speedMps = Math.hypot(nextVelocityMps[0], nextVelocityMps[1])
        const brakingMps = Math.min(speedMps, vtolModel.surfaceFrictionCoefficient * Math.max(0, nextAccelerationMps2[2]) * dtS)
        if (speedMps > 0) for (const i of [0, 1]) {
          nextVelocityMps[i] = nextVelocityMps[i]! * (1 - brakingMps / speedMps)
          nextAccelerationMps2[i] = (nextVelocityMps[i]! - velocityMps[i]!) / dtS
        }
        nextVelocityMps[2] = Math.min(0, nextVelocityMps[2]); nextAccelerationMps2[2] = 0
      }
      const nextPositionM = positionM.map((n, i) => n + nextVelocityMps[i]! * dtS) as SensorVector
      if (nextOnSurface) nextPositionM[2] = 0
      if (![...nextAccelerationMps2, ...nextVelocityMps, ...nextPositionM].every(Number.isFinite)) throw new RangeError('VTOL rotor model diverged')
      let nextEnergyUsedWh = energyUsedWh
      if (capacityWh !== undefined) {
        const remainingWh = capacityWh - energyUsedWh
        const loadW = remainingWh === 0 ? 0 : nextBatteryCutoff ? vtolElectricalModel.auxiliaryW : vtolElectricalLoad(nextRotorsN, nextPusherThrustN, actuators.slice(5))
        const sourceW = vtolElectricalSupply(loadW, remainingWh / capacityWh).sourceW
        nextEnergyUsedWh += Math.min(remainingWh, sourceW * dtS / 3600)
      }
      // Reject the entire integration before committing any retained state.
      energyUsedWh = nextEnergyUsedWh; batteryCutoff = nextBatteryCutoff; surfacesRad = actuators.slice(5)
      windMps = nextWindMps
      rotorsN = nextRotorsN
      pusherThrustN = nextPusherThrustN
      angularRateRadS = nextAngularRateRadS
      quaternionWxyz = nextQuaternionWxyz
      accelerationMps2 = nextAccelerationMps2
      velocityMps = nextVelocityMps
      positionM = nextPositionM
      onSurface = nextOnSurface
      return snapshot()
    },
  }
}
