import type { VehicleMeasurement, VehiclePlantState, VehicleProfile } from '../types'
import { createAirController } from './controller'
import { airModel, createAirPlant } from './plant'
export const airScenarios = ['nominal', 'crosswind', 'airspeed-loss', 'position-loss', 'host-loss', 'rc-override', 'kill'] as const
export function createAirProfile(scenario = 'nominal'): VehicleProfile {
  if (!(airScenarios as readonly string[]).includes(scenario)) throw new RangeError('Unknown fixed-wing scenario')
  return {
    vehicle: 'fixed-wing', name: 'Owned aerodynamic trainer', evidence: 'modeled-vehicle-profile', physicalFlightEnabled: false,
    actuators: [
      { name: 'propeller-throttle', unit: 'normalized', min: 0, max: 1, neutral: 0 },
      { name: 'aileron', unit: 'radian', min: -0.4, max: 0.4, neutral: 0 },
      { name: 'elevator', unit: 'radian', min: -0.4, max: 0.4, neutral: 0 },
      { name: 'rudder', unit: 'radian', min: -0.4, max: 0.4, neutral: 0 },
      { name: 'wheel-brake', unit: 'normalized', min: 0, max: 1, neutral: 1 },
    ],
    authorityFence: { radiusM: 1000, minDownM: -80, maxDownM: 1 },
    mission: {
      version: 2, vehicle: 'fixed-wing', id: 'air-runway-survey', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE',
      origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 1000, minDownM: -80, maxDownM: 1 }, rallyM: [120, 0, -15],
      power: { availableWh: 20, maxW: 300, reservePercent: 30 }, start: 'start',
      tasks: [
        { id: 'start', kind: 'start', next: 'depart' },
        { id: 'depart', kind: 'takeoff', positionM: [120, 0, -15], acceptanceM: 15, maxArrivalSpeedMps: 20, settleMs: 0, timeoutMs: 25000, next: 'survey' },
        { id: 'survey', kind: 'waypoint', positionM: [350, 0, -20], acceptanceM: 20, maxArrivalSpeedMps: 20, settleMs: 0, timeoutMs: 30000, next: 'land' },
        { id: 'land', kind: 'land', positionM: [650, 0, 0], acceptanceM: 40, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 60000 },
      ],
    },
    scenarios: airScenarios, createPlant: createAirPlant, createController: createAirController,
    renderMeasurement(state: VehiclePlantState, atMs: number, reference: string): VehicleMeasurement {
      const quantize = (v: number, scale: number) => Math.round(v * scale) / scale
      const differentialPressurePa = quantize(0.5 * airModel.densityKgM3 * (state.details.airspeedMps as number) ** 2, 100)
      return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'fixed-wing', sequence: Math.floor(atMs / 20) + 1, reference, capturedAtMs: atMs, receivedAtMs: atMs + 60,
        values: { differentialPressurePa, airspeedMps: quantize(Math.sqrt(2 * differentialPressurePa / airModel.densityKgM3), 100), alphaRad: quantize(state.details.alphaRad as number, 10000), betaRad: quantize((state.details.betaRad as number) || 0, 10000), rateRadS: state.angularRateRadS.map(n => quantize(n, 10000)), onSurface: state.onSurface, stopped: Math.hypot(...state.velocityMps) <= 0.2 } }
    },
    faults(_scenario, atMs) {
      if (_scenario === 'crosswind') return { windMps: atMs > 1000 ? [0, 2, 0] : [0, 0, 0] }
      if (atMs < 12000) return {}
      if (_scenario === 'airspeed-loss') return { dropVehicleSensor: true }
      if (_scenario === 'position-loss') return { dropPosition: true }
      if (_scenario === 'host-loss') return { hostLost: true }
      if (_scenario === 'rc-override') return { rcOverride: true }
      if (_scenario === 'kill') return { kill: true }
      return {}
    },
  }
}
export { airAerodynamics, airModel, createAirPlant } from './plant'
export { createAirController } from './controller'
