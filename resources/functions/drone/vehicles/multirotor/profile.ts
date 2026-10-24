import type { SensorVector } from '../../sensors/types'
import type { VehicleMissionPlan, VehiclePlant, VehiclePlantState, VehicleProfile, VehicleSession } from '../types'
import { createRigidBody } from '../../controls/physics'
import { createSimulatedMultirotorController } from '../../controls/controller'
import { multirotorModel } from '../../controls/model'
import { vehicleReference } from '../measurements'

export const multirotorScenarios = ['nominal', 'imu-loss', 'position-loss', 'vehicle-sensor-loss', 'rc-override', 'kill', 'host-loss', 'link-loss'] as const
export type MultirotorScenario = typeof multirotorScenarios[number]

/** The original fictional quad-X body, now using the shared acknowledged mission contract. */
export function multirotorMission(): VehicleMissionPlan {
  const spatial = { acceptanceM: .2, maxArrivalSpeedMps: .18, settleMs: 200, timeoutMs: 20000 }
  return {
    version: 2, vehicle: 'quadcopter', id: 'quad-shared-mission', frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE',
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 }, fence: { radiusM: 12, minDownM: -5, maxDownM: 0 }, rallyM: [0, 0, -1],
    power: { availableWh: 40, maxW: 600, reservePercent: 30 }, start: 'start', tasks: [
      { id: 'start', kind: 'start', next: 'depart' },
      { id: 'depart', kind: 'takeoff', positionM: [0, 0, -1], ...spatial, next: 'visit' },
      { id: 'visit', kind: 'waypoint', positionM: [2, 1, -1], ...spatial, next: 'home' },
      { id: 'home', kind: 'return', ...spatial, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], ...spatial },
    ],
  }
}

/** Both bare and carried-load bodies use the same quad plant interface. */
export function createMultirotorPlant(body: ReturnType<typeof createRigidBody>): VehiclePlant {
  function snapshot(): VehiclePlantState {
    const state = body.snapshot()
    return { positionM: [...state.positionM], velocityMps: [...state.velocityMps], accelerationMps2: [...state.accelerationMps2], quaternionWxyz: [...state.quaternionWxyz], angularRateRadS: [...state.angularRateRadS], onSurface: state.groundContact || state.positionM[2] >= -.1 && state.velocityMps[2] >= 0, details: Object.fromEntries(state.motorsN.map((thrust, i) => ['motor' + i + 'N', thrust])) }
  }
  return { snapshot, step(actuators, dtS, environment) { body.step(actuators as [number, number, number, number], dtS, { windMps: environment.windMps }); return snapshot() } }
}

function createSession(): VehicleSession {
  let sequence = 0, plant: VehiclePlant | null = null
  return {
    createPlant: () => plant ??= createMultirotorPlant(createRigidBody({ positionM: [0, 0, -.1], groundDownM: -.1 })),
    createController() {
      const controller = createSimulatedMultirotorController({ headingAlignment: 'initial-simulation-north' })
      let fault: string | null = null
      return { step(context) {
        const rate = context.controlRate
        if (context.enabled && (!rate || rate.evidence !== 'modeled-qualified-imu' || rate.reference !== vehicleReference(context.estimate)
          || !Array.isArray(rate.angularRateRadS) || rate.angularRateRadS.length !== 3 || ![0, 1, 2].every(i => Object.hasOwn(rate.angularRateRadS, i) && Number.isFinite(rate.angularRateRadS[i])))) fault ??= 'quad-rate-unqualified'
        const output = controller.step({ kind: 'simulation', nowMs: context.nowMs, enabled: context.enabled && fault === null, estimate: context.estimate,
          angularRateRadS: rate?.angularRateRadS ?? [0, 0, 0], rateCapturedAtMs: rate?.capturedAtMs ?? -Infinity,
          target: { positionM: context.mission.targetM ?? [0, 0, 0], yawRad: 0, issuedAtMs: context.nowMs } })
        const measurement = context.measurement
        const contact = !output.inhibited && (context.mission.taskKind === 'land' || context.mission.payload?.operation === 'material-receive') && measurement?.vehicle === 'quadcopter' && measurement.evidence === 'modeled-vehicle-sensors'
          && measurement.reference === rate?.reference && measurement.capturedAtMs <= context.nowMs && context.nowMs - measurement.capturedAtMs <= 120 && measurement.receivedAtMs <= context.nowMs && measurement.values.onSurface === true
        return { kind: 'simulated-vehicle-control', vehicle: 'quadcopter', atMs: context.nowMs, actuators: contact ? [0, 0, 0, 0] : [...output.motorsN], inhibited: fault !== null || output.inhibited, reason: fault ?? (contact ? 'quad-qualified-contact' : output.reason), physicalFlightEnabled: false, boardOutputsInhibited: true }
      } }
    },
    renderMeasurement(state, atMs, reference) {
      return { version: 1, evidence: 'modeled-vehicle-sensors', vehicle: 'quadcopter', sequence: ++sequence, reference, capturedAtMs: atMs, receivedAtMs: atMs + 40,
        values: { onSurface: state.onSurface, stopped: [0, 1, 2, 3].every(i => Number(state.details['motor' + i + 'N']) < .01), calibration: 'fictional-quad-x-v1', clockUncertaintyMs: 1 } }
    },
  }
}

export function createMultirotorProfile(scenario: MultirotorScenario = 'nominal'): VehicleProfile {
  if (!multirotorScenarios.includes(scenario)) throw new RangeError('Unknown multirotor scenario')
  return { scenario, vehicle: 'quadcopter', name: 'Owned quad-X shared mission', scenarios: [...multirotorScenarios], evidence: 'modeled-vehicle-profile', physicalFlightEnabled: false,
    actuators: [0, 1, 2, 3].map(i => ({ name: 'motor-' + i, unit: 'newton', min: 0, max: multirotorModel.maxMotorThrustN, neutral: 0 })),
    mission: multirotorMission(), authorityFence: { radiusM: 12, minDownM: -5, maxDownM: 0 }, createSession,
    faults(selectedScenario, atMs) {
      if (selectedScenario !== scenario) throw new TypeError('Multirotor scenario changed after capture')
      const active = atMs >= 5000
      return { dropImu: active && scenario === 'imu-loss', dropPosition: active && scenario === 'position-loss', dropVehicleSensor: active && scenario === 'vehicle-sensor-loss', rcOverride: active && scenario === 'rc-override', kill: active && scenario === 'kill', hostLost: active && scenario === 'host-loss', linkLost: active && scenario === 'link-loss', windMps: [0, 0, 0] as SensorVector }
    },
  }
}
