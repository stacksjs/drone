import type { VehicleMissionPlan, VehicleProfile } from '../types'
import { createSubseaPlant } from './plant'
import { createSubseaController } from './controller'
import { subseaThrusters } from './allocation'
import { createSubseaNavigation } from './navigation'
import { renderSubseaMeasurement } from './sensors'
import { createSubseaCapture } from './payload'

export const subseaScenarios = ['nominal', 'current', 'leak', 'tether-overload', 'tether-loss', 'dvl-loss', 'pressure-loss', 'depth-limit', 'emergency', 'host-loss', 'rc-override', 'kill', 'imu-loss', 'sensor-loss'] as const
export type SubseaScenario = typeof subseaScenarios[number]
export function createSubseaProfile(scenario: SubseaScenario = 'nominal'): VehicleProfile {
  if (!subseaScenarios.includes(scenario)) throw new RangeError('Unknown subsea scenario')
  const movement = { acceptanceM: 0.2, maxArrivalSpeedMps: 0.12, settleMs: 200, timeoutMs: 40000 }
  const mission: VehicleMissionPlan = { version: 2, vehicle: 'subsea', id: 'subsea-local-inspection-return', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 8, minDownM: -0.1, maxDownM: 8 }, rallyM: [0, 0, 0], power: { availableWh: 100, maxW: 400, reservePercent: 30 }, start: 'start', tasks: [
    { id: 'start', kind: 'start', next: 'dive' },
    { id: 'dive', kind: 'waypoint', positionM: [0, 0, 2], ...movement, next: 'inspect' },
    { id: 'inspect', kind: 'waypoint', positionM: [2, 0, 2], ...movement, next: 'capture' },
    { id: 'capture', kind: 'payload', operation: 'inspection-capture', containerId: null, timeoutMs: 2000, next: 'return' },
    { id: 'return', kind: 'return', ...movement, next: 'stop' },
    { id: 'stop', kind: 'stop', positionM: [0, 0, 0], ...movement, timeoutMs: 10000 },
  ] }
  return { scenario, vehicle: 'subsea', name: 'Owned six degree of freedom tethered inspection ROV', evidence: 'modeled-vehicle-profile', physicalFlightEnabled: false, actuators: subseaThrusters.map(t => ({ ...t })), authorityFence: { ...mission.fence }, mission, scenarios: subseaScenarios,
    createSession() {
      let sequence = 0
      return { createPlant: createSubseaPlant, createController: createSubseaController, createNavigation: createSubseaNavigation, createPayload: createSubseaCapture,
        renderMeasurement: (state, atMs, reference) => renderSubseaMeasurement(state, atMs, reference, ++sequence, scenario),
      }
    },
    faults(name, atMs) {
      if (!subseaScenarios.includes(name as SubseaScenario)) throw new RangeError('Unknown subsea fault fixture')
      if (atMs < 600) return {}
      return { currentMps: name === 'current' ? [0.08, 0.1, 0] : [0.02, 0.02, 0], ...(atMs < 5000 ? {} : { dropImu: name === 'imu-loss', dropVehicleSensor: name === 'sensor-loss', hostLost: name === 'host-loss', rcOverride: name === 'rc-override', kill: name === 'kill', linkLost: name === 'tether-loss' }) }
    },
  }
}
export * from './inspection'
export * from './payload'
