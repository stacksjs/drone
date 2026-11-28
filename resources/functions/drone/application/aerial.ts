import type { AerialApplicationProbe, AerialApplicationRun, ApplicationFlightObservation, ApplicationPlant, RecordedApplicationRun } from './runtime-types'
import type { AerialApplicationPlan } from './types'
import type { VehicleControllerContext, VehiclePlant, VehiclePlantState } from '../vehicles/types'
import { multirotorModel } from '../controls/model'
import { vehicleReference } from '../vehicles/measurements'
import { applicationAerialSpeedMps } from './planner'

export function applicationFlightMotion(plan: AerialApplicationPlan) {
  const { routeM, implement } = plan.config
  const headingByTaskRad = new Map<string, number>()
  for (const [index, target] of routeM.entries()) {
    const previous = routeM[index - 1] ?? [0, 0]
    const north = target[0] - previous[0], east = target[1] - previous[1]
    if (north || east) headingByTaskRad.set(index === 0 ? 'approach' : `apply-${index}`, Math.atan2(east, north))
  }
  return { nominalMassKg: plan.load.takeoffMassKg, horizontalSpeedLimitMps: applicationAerialSpeedMps(implement), headingByTaskRad }
}

export function applicationAircraftSummary(run: RecordedApplicationRun) {
  if (!('aircraft' in run.plan) || run.vehicle.vehicle !== 'quadcopter') return null
  const { plan, probes } = run as AerialApplicationRun
  const final = probes.at(-1)
  if (!final) return null
  return {
    flightStatus: run.vehicle.status,
    flightReason: run.vehicle.mission.reason,
    landingVerified: run.vehicle.mission.reason === 'landed',
    takeoffMassKg: plan.load.takeoffMassKg,
    finalMassKg: final.flight.massKg,
    propulsionEnergyWh: final.flight.propulsionEnergyWh,
    pumpEnergyWh: final.flight.pumpEnergyWh,
    reserveMarginWh: final.flight.reserveMarginWh,
  }
}

/** The same current estimate and qualified rate used by the modeled flight controller. */
export function observeApplicationFlight(context: VehicleControllerContext): ApplicationFlightObservation {
  const { estimate, controlRate, measurement, nowMs } = context
  const p = estimate.localPosition, a = estimate.attitude
  const reference = vehicleReference(estimate)
  const horizontal = p ? .025 + 3 * Math.sqrt(Math.max(p.covarianceBlocks[0]!.positionM2, p.covarianceBlocks[1]!.positionM2)) : 1
  const vertical = p ? .025 + 3 * Math.sqrt(p.covarianceBlocks[2]!.positionM2) : 1
  const healthy = estimate.evidence === 'fixture' && estimate.nowMs === nowMs && estimate.health.localPosition && estimate.health.tilt
    && p?.frame === 'LOCAL_NED' && p.altitudeDatum === 'WGS84_ELLIPSOID' && p.capturedAtMs !== null && nowMs - p.capturedAtMs <= 200
    && p.predictedToMs === nowMs && a?.reference === 'GRAVITY_ALIGNED_RELATIVE_YAW' && a.capturedAtMs !== null && nowMs - a.capturedAtMs <= 60
    && controlRate?.evidence === 'modeled-qualified-imu' && controlRate.reference === reference && controlRate.capturedAtMs === a.capturedAtMs
    && measurement?.vehicle === 'quadcopter' && measurement.reference === reference && horizontal <= 1 && vertical <= 1
  const positionM: ApplicationFlightObservation['positionM'] = healthy && p ? [p.positionM[0]!, p.positionM[1]!, p.positionM[2]!] : [0, 0, 0]
  const velocityMps: ApplicationFlightObservation['velocityMps'] = healthy && p ? [p.velocityMps[0]!, p.velocityMps[1]!, p.velocityMps[2]!] : [0, 0, 0]
  return {
    healthy, reason: healthy ? 'application-qualified-flight-motion' : 'application-flight-navigation-unavailable',
    positionM, velocityMps, yawRad: a?.eulerRad[2] ?? 0, yawRateRadS: controlRate?.angularRateRadS[2] ?? 0,
    tiltRad: a ? Math.acos(Math.min(1, Math.max(-1, Math.cos(a.eulerRad[0]) * Math.cos(a.eulerRad[1])))) : 0,
    uncertaintyM: healthy ? horizontal : 1, verticalUncertaintyM: healthy ? vertical : 1,
    onSurface: measurement?.values.onSurface !== false, guardClosed: measurement?.values.guardClosed === true,
  }
}

/** A synthetic ideal source; rotor demand scales with achieved thrust to the 3/2 power. */
export function createApplicationFlightPower(plan: AerialApplicationPlan) {
  const { aircraft, load, powerBudget } = plan
  let propulsionEnergyWh = 0, pumpEnergyWh = 0, drawW = 0
  function remainingWh() { return aircraft.availableWh - (propulsionEnergyWh + pumpEnergyWh) }
  return {
    wrapPlant(plant: ApplicationPlant): VehiclePlant {
      return {
        snapshot: () => plant.snapshot(),
        step(channels, dt, environment) {
          const state = plant.step(remainingWh() > 0 ? channels : [0, 0, 0, 0, 0, 0, 0], dt, environment)
          let propulsionW = 0
          for (let i = 0; i < 4; i++) propulsionW += aircraft.propulsionMaxW / 4 * (Number(state.details[`motor${i}N`]) / multirotorModel.maxMotorThrustN) ** 1.5
          const pumpW = aircraft.pumpMaxW * Number(state.details.applicationEnergy)
          propulsionEnergyWh += propulsionW * dt / 3600
          pumpEnergyWh += pumpW * dt / 3600
          drawW = propulsionW + pumpW
          return state
        },
      }
    },
    measurement() {
      const terminalV = 16
      return {
        batteryCapacityWh: aircraft.availableWh,
        batteryEnergyUsedWh: Math.min(aircraft.availableWh, propulsionEnergyWh + pumpEnergyWh),
        batteryLoadPowerW: drawW, batterySourcePowerW: drawW, batteryCurrentA: drawW / terminalV, batteryTerminalV: terminalV,
        batteryCutoff: remainingWh() <= 0,
      }
    },
    probe(state: VehiclePlantState, remainingL: number): AerialApplicationProbe['flight'] {
      return {
        velocityMps: [...state.velocityMps],
        massKg: load.emptySystemMassKg + remainingL * plan.config.material.densityKgPerL!,
        propulsionEnergyWh,
        pumpEnergyWh,
        reserveMarginWh: remainingWh() - powerBudget.reserveWh,
      }
    },
  }
}
