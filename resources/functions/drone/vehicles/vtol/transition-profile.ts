import type { VehicleProfile } from '../types'
import { createVtolHoverProfile } from './index'
import { createVtolPlant } from './plant'
import { createVtolFlightController } from './flight-controller'

/** Declared fictional transition experiment, undergoing controller qualification. No physical IO. */
export function createVtolTransitionProfile(): VehicleProfile {
  const base = createVtolHoverProfile()
  return {
    ...base, scenario: 'nominal', scenarios: ['nominal'], name: 'Owned VTOL lift-and-cruise development',
    authorityFence: { radiusM: 400, minDownM: -40, maxDownM: 1 },
    mission: { ...base.mission, id: 'vtol-transition-development', fence: { radiusM: 400, minDownM: -40, maxDownM: 1 }, rallyM: [0, 0, -15],
      power: { availableWh: 100, maxW: 1200, reservePercent: 30 },
      tasks: [
        { id: 'start', kind: 'start', next: 'initial-hover' },
        { id: 'initial-hover', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 1500, next: 'depart' },
        { id: 'depart', kind: 'takeoff', positionM: [0, 0, -15], acceptanceM: 0.25, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 20000, next: 'front' },
        { id: 'front', kind: 'vtol-mode', mode: 'cruise', headingRad: 0, timeoutMs: 15000, next: 'cruise-leg' },
        { id: 'cruise-leg', kind: 'waypoint', positionM: [180, 0, -15], acceptanceM: 8, maxArrivalSpeedMps: 15, settleMs: 0, timeoutMs: 25000, next: 'back' },
        { id: 'back', kind: 'vtol-mode', mode: 'hover', headingRad: 0, timeoutMs: 45000, next: 'land' },
        { id: 'land', kind: 'land', positionM: [180, 0, 0], acceptanceM: 0.3, maxArrivalSpeedMps: 0.2, settleMs: 200, timeoutMs: 25000 },
      ],
    },
    createSession() {
      return { createPlant: createVtolPlant, createController: createVtolFlightController,
        renderMeasurement(state, atMs, reference) {
          const rounded = (n: number) => Math.round(n * 1000000) / 1000000
          return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'vtol', sequence: Math.floor(atMs / 20) + 1, reference, capturedAtMs: atMs, receivedAtMs: atMs + 60,
            values: { onSurface: state.onSurface, stopped: Math.hypot(...state.velocityMps) <= 0.2,
              airspeedMps: rounded(state.details.airspeedMps as number), differentialPressurePa: rounded(state.details.dynamicPressurePa as number),
              alphaRad: rounded(state.details.alphaRad as number), betaRad: rounded(state.details.betaRad as number),
              rotorThrustN: rounded(state.details.rotorThrustN as number), pusherThrustN: rounded(state.details.pusherThrustN as number) } }
        },
      }
    },
    faults() { return {} },
  }
}
