import type { VehicleMissionPlan, VehicleProfile } from '../types'
import { createSurfacePlant } from './plant'
import { createSurfaceController } from './controller'
import { renderSurfaceMeasurement } from './sensors'
import { createSurfaceSampler } from './payload'
export const surfaceScenarios = ['nominal', 'harbour-return', 'current', 'collision', 'sensor-loss', 'position-loss', 'sample-uncertain', 'sample-loss', 'host-loss', 'rc-override', 'kill'] as const
export type SurfaceScenario = typeof surfaceScenarios[number]
export function createSurfaceProfile(scenario: SurfaceScenario = 'nominal'): VehicleProfile {
  if (!surfaceScenarios.includes(scenario)) throw new RangeError('Unknown surface scenario')
  const move = { acceptanceM: 0.35, maxArrivalSpeedMps: 0.25, settleMs: 400, timeoutMs: 25000 }
  const mission: VehicleMissionPlan = { version: 2, vehicle: 'surface', id: 'harbour-survey-sample-return', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 15, minDownM: -0.5, maxDownM: 0.5 }, rallyM: [0, 0, 0], power: { availableWh: 60, maxW: 120, reservePercent: 30 }, start: 'start', tasks: [
    { id: 'start', kind: 'start', next: 'survey-a' },
    { id: 'survey-a', kind: 'waypoint', positionM: [5, 0, 0], ...move, next: scenario === 'harbour-return' ? 'energy-check' : 'survey-b' },
    { id: 'survey-b', kind: 'waypoint', positionM: [5, 2, 0], ...move, next: 'sample' },
    { id: 'sample', kind: 'payload', operation: 'water-sample', containerId: 'harbour-bottle-001', timeoutMs: 1000, next: 'return' },
    { id: 'return', kind: 'return', ...move, timeoutMs: 30000, next: 'stop' },
    { id: 'stop', kind: 'stop', positionM: [0, 0, 0], ...move, timeoutMs: 10000 },
  ] }
  if (scenario === 'harbour-return') mission.tasks.push({ id: 'energy-check', kind: 'branch', batteryAtLeast: 100, then: 'survey-b', otherwise: 'return' })
  return { scenario, vehicle: 'surface', name: 'Owned planar vector-thrust harbour vessel', evidence: 'modeled-vehicle-profile', physicalFlightEnabled: false,
    actuators: [{ name: 'body-surge', unit: 'normalized', min: -1, max: 1, neutral: 0 }, { name: 'body-sway', unit: 'normalized', min: -1, max: 1, neutral: 0 }, { name: 'body-yaw', unit: 'normalized', min: -1, max: 1, neutral: 0 }], authorityFence: { ...mission.fence }, mission,
    scenarios: surfaceScenarios,
    createSession() {
      let sequence = 0
      return {
        createPlant: createSurfacePlant, createController: createSurfaceController,
        createPayload: () => createSurfaceSampler(scenario === 'sample-uncertain' ? 'uncertain' : scenario === 'sample-loss' ? 'loss' : 'confirmed'),
        renderMeasurement: (state, atMs, reference) => renderSurfaceMeasurement(state, atMs, reference, ++sequence, scenario === 'collision'),
      }
    },
    faults(name, atMs) {
      if (!surfaceScenarios.includes(name as SurfaceScenario)) throw new RangeError('Unknown surface fault fixture')
      if (atMs < 600) return {}
      return { currentMps: name === 'current' ? [0.05, 0.12, 0] : [0, 0.03, 0], windMps: [0.5, -0.5, 0], ...(atMs < 5000 ? {} : { dropVehicleSensor: name === 'sensor-loss', dropPosition: name === 'position-loss', hostLost: name === 'host-loss', rcOverride: name === 'rc-override', kill: name === 'kill' }) }
    },
  }
}
export * from './survey'
export * from './sensors'
