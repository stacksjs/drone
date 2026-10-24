import type { VehicleActuator, VehicleControlOutput, VehicleKind } from '../vehicles/types'
import { vehicleKinds } from '../vehicles/types'
import type { AuthorityFrameMetadata } from './core'
import type { AuthorityCommand, AuthorityObservation } from './supervisor'
import { createAuthorityKernel } from './core'
import { createOutputWatchdogKernel } from './watchdog-core'
export interface VehicleActuatorFrame extends AuthorityFrameMetadata { vehicle: VehicleKind, actuators: number[] }
export const vehicleAuthorityPolicy = Object.freeze({ interlockAgeMs: 200 })
export function validateVehicleActuators(input: VehicleActuator[]): VehicleActuator[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16 || new Set(input.map(a => a?.name)).size !== input.length || input.some(a => !a || typeof a.name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(a.name) || !['normalized', 'newton', 'radian', 'metres-per-second'].includes(a.unit) || ![a.min, a.max, a.neutral].every(n => typeof n === 'number' && Number.isFinite(n)) || a.min < -100000 || a.max > 100000 || a.min >= a.max || a.neutral < a.min || a.neutral > a.max)) throw new TypeError('Invalid vehicle actuator declaration')
  return input.map(a => ({ ...a }))
}
export function validVehicleActuatorValues(input: unknown, declaration: VehicleActuator[]): input is number[] {
  return Array.isArray(input) && input.length === declaration.length && input.every((n, i) => typeof n === 'number' && Number.isFinite(n) && n >= declaration[i]!.min && n <= declaration[i]!.max)
}
function vehicleKind(kind: VehicleKind) { if (!vehicleKinds.includes(kind)) throw new TypeError('Unsupported simulated vehicle') }
/** Profile-specific actuator adapter over the same arming, lease and failover lifecycle as quad-X. */
export function createVehicleAuthoritySupervisor(options: { bootId: bigint, sessionId: bigint, vehicle: VehicleKind, actuators: VehicleActuator[], fence: { radiusM: number, minDownM: number, maxDownM: number } }) {
  vehicleKind(options.vehicle)
  const actuators = validateVehicleActuators(options.actuators), vehicle = options.vehicle
  const core = createAuthorityKernel<VehicleControlOutput, VehicleActuatorFrame>({
    bootId: options.bootId, sessionId: options.sessionId, fence: options.fence, interlockAgeMs: vehicleAuthorityPolicy.interlockAgeMs, altitudeDatum: vehicle === 'subsea' ? 'LOCAL_WATER_SURFACE' : 'WGS84_ELLIPSOID',
    validateOutput: (output, now) => !!output && output.kind === 'simulated-vehicle-control' && output.vehicle === vehicle && output.atMs === now && output.inhibited === false && output.physicalFlightEnabled === false && output.boardOutputsInhibited === true && validVehicleActuatorValues(output.actuators, actuators),
    createFrame: (output, metadata) => ({ ...metadata, vehicle, actuators: [...output.actuators] }),
  })
  const snapshot = () => ({ ...core.snapshot(), vehicle, physicalActuationEnabled: false as const })
  return { snapshot, update(o: AuthorityObservation, command?: AuthorityCommand) { core.update(o, command); return snapshot() }, gate: core.gate }
}
export function createVehicleOutputWatchdog(options: { bootId: bigint, sessionId: bigint, vehicle: VehicleKind, actuators: VehicleActuator[] }) {
  vehicleKind(options.vehicle)
  const declaration = validateVehicleActuators(options.actuators), vehicle = options.vehicle
  const core = createOutputWatchdogKernel<VehicleActuatorFrame>({ bootId: options.bootId, sessionId: options.sessionId, neutral: declaration.map(a => a.neutral), valid: frame => frame.vehicle === vehicle && validVehicleActuatorValues(frame.actuators, declaration), values: frame => frame.actuators })
  const snapshot = () => { const { values, ...state } = core.snapshot(); return { ...state, vehicle, actuators: values, physicalActuationEnabled: false as const } }
  return { snapshot, tick(nowMs: number) { core.tick(nowMs); return snapshot() }, accept: core.accept, revoke: core.revoke, trip: core.trip, reboot: core.reboot }
}
