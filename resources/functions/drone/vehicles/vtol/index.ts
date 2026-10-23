import type { VehicleProfile } from '../types'
import { createVtolPlant, vtolModel } from './plant'
import { createVtolVehicleHoverController } from './controller'
export const vtolHoverScenarios = Object.freeze(['hover', 'imu-loss', 'position-loss', 'vehicle-sensor-loss', 'host-loss', 'rc-override', 'kill'] as const)

/** Development hover mission only. Front/cruise/back transitions remain unimplemented. */
export function createVtolHoverProfile(scenario = 'hover'): VehicleProfile {
  if (!(vtolHoverScenarios as readonly string[]).includes(scenario)) throw new RangeError('Unknown VTOL hover scenario')
  return {
    scenario, vehicle: 'vtol', name: 'Owned VTOL hover development', evidence: 'modeled-vehicle-profile', physicalFlightEnabled: false,
    actuators: [
      ...['front-left', 'front-right', 'rear-right', 'rear-left'].map(name => ({ name: `lift-${name}`, unit: 'newton' as const, min: 0, max: vtolModel.maxRotorThrustN, neutral: 0 })),
      { name: 'pusher', unit: 'normalized', min: 0, max: 1, neutral: 0 },
      ...['aileron', 'elevator', 'rudder'].map(name => ({ name, unit: 'radian' as const, min: -0.4, max: 0.4, neutral: 0 })),
    ],
    authorityFence: { radiusM: 100, minDownM: -15, maxDownM: 1 },
    mission: {
      version: 2, vehicle: 'vtol', id: 'vtol-hover-development', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE',
      origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 100, minDownM: -15, maxDownM: 1 }, rallyM: [0, 0, -5],
      // Declared budget ceiling for this fictional hover case, not identified propulsion power.
      power: { availableWh: 50, maxW: 1200, reservePercent: 30 }, start: 'start',
      tasks: [
        { id: 'start', kind: 'start', next: 'depart' },
        { id: 'depart', kind: 'takeoff', positionM: [0, 0, -5], acceptanceM: 0.2, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 20000, next: 'hover-waypoint' },
        { id: 'hover-waypoint', kind: 'waypoint', positionM: [2, 1, -5], acceptanceM: 0.2, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 20000, next: 'land' },
        { id: 'land', kind: 'land', positionM: [2, 1, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 20000 },
      ],
    },
    scenarios: vtolHoverScenarios,
    createSession() {
      return { createPlant: createVtolPlant, createController: createVtolVehicleHoverController,
        renderMeasurement(state, atMs, reference) {
          return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'vtol', sequence: Math.floor(atMs / 20) + 1, reference, capturedAtMs: atMs, receivedAtMs: atMs + 60,
            values: { onSurface: state.onSurface, stopped: Math.hypot(...state.velocityMps) <= 0.2, airspeedMps: Math.round((state.details.airspeedMps as number) * 1000) / 1000 } }
        },
      }
    },
    faults(selected, atMs) {
      if (atMs < 3000) return {}
      if (selected === 'imu-loss') return { dropImu: true }
      if (selected === 'position-loss') return { dropPosition: true }
      if (selected === 'vehicle-sensor-loss') return { dropVehicleSensor: true }
      if (selected === 'host-loss') return { hostLost: true }
      if (selected === 'rc-override') return { rcOverride: true }
      if (selected === 'kill') return { kill: true }
      return {}
    },
  }
}
