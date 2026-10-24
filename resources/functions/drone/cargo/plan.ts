import type { SensorVector } from '../sensors/types'
import type { VehicleMissionPlan } from '../vehicles/types'
import type { CargoDeliveryDeclaration } from './coordinator'
import { captureCargoDeliveryDeclaration } from './coordinator'
import { validateVehicleMission } from '../missions/vehicle'

export interface CargoDeliveryConfiguration {
  version: 1
  id: string
  delivery: CargoDeliveryDeclaration
  load: { massKg: number, forwardM: number }
  alternateM: SensorVector
  power: VehicleMissionPlan['power']
}
function record(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== fields.length) throw new TypeError('cargo-delivery-configuration')
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('cargo-delivery-configuration')
    result[field] = descriptor.value
  }
  return result
}

/** Explicit modeled route admission, before allocating a plant or transport. */
export function planCargoDelivery(input: unknown) {
  const top = record(input, ['version', 'id', 'delivery', 'load', 'alternateM', 'power'])
  const delivery = captureCargoDeliveryDeclaration(top.delivery), load = record(top.load, ['massKg', 'forwardM']), power = record(top.power, ['availableWh', 'maxW', 'reservePercent'])
  if (top.version !== 1 || typeof top.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(top.id)
    || delivery.origin.latitudeDeg !== 0 || delivery.origin.longitudeDeg !== 0 || delivery.origin.ellipsoidHeightM !== 100 || delivery.site.positionM[2] !== 0 || delivery.site.containerId.length > 40
    || typeof load.massKg !== 'number' || !Number.isFinite(load.massKg) || load.massKg <= 0 || load.massKg > .25
    || typeof load.forwardM !== 'number' || !Number.isFinite(load.forwardM) || load.forwardM < -.1 || load.forwardM > .1
    || !Object.values(power).every(n => typeof n === 'number' && Number.isFinite(n)) || (power.maxW as number) < 600
    || !Array.isArray(top.alternateM) || top.alternateM.length !== 3 || Reflect.ownKeys(top.alternateM).length !== 4) throw new TypeError('cargo-delivery-configuration')
  const alternateM = [0, 1, 2].map(i => {
    const descriptor = Object.getOwnPropertyDescriptor(top.alternateM, String(i))
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value)) throw new TypeError('cargo-delivery-configuration')
    return descriptor.value
  }) as SensorVector
  if (alternateM[2] !== 0) throw new TypeError('cargo-delivery-configuration')
  const configuration: CargoDeliveryConfiguration = { version: 1, id: top.id, delivery, load: { massKg: load.massKg, forwardM: load.forwardM }, alternateM, power: power as unknown as VehicleMissionPlan['power'] }
  const height = delivery.releaseHeightM, site = delivery.site.positionM
  const spatial = { acceptanceM: .18, maxArrivalSpeedMps: .15, settleMs: 300, timeoutMs: 20000 }
  const proposed: VehicleMissionPlan = { version: 2, vehicle: 'quadcopter', id: configuration.id, frame: 'LOCAL_NED', altitude: 'ORIGIN_RELATIVE_DOWN', terrain: 'DECLARED_MODEL_SURFACE',
    origin: delivery.origin, fence: { radiusM: 12, minDownM: -5, maxDownM: 0 }, rallyM: [0, 0, -height], power: configuration.power, start: 'start', tasks: [
      { id: 'start', kind: 'start', next: 'depart' },
      { id: 'depart', kind: 'takeoff', positionM: [0, 0, -height], ...spatial, next: 'site' },
      { id: 'site', kind: 'waypoint', positionM: [site[0], site[1], -height], ...spatial, settleMs: 800, next: 'release' },
      { id: 'release', kind: 'payload', operation: 'material-drop', containerId: delivery.site.containerId, timeoutMs: 1500, next: 'home', onFailure: 'alternate-approach' },
      { id: 'home', kind: 'return', ...spatial, next: 'land' },
      { id: 'land', kind: 'land', positionM: [0, 0, 0], ...spatial },
      { id: 'alternate-approach', kind: 'waypoint', positionM: [alternateM[0], alternateM[1], -height], ...spatial, next: 'alternate-land' },
      { id: 'alternate-land', kind: 'land', positionM: [...alternateM], ...spatial },
    ] }
  const { plan, worstCaseMs, requiredWh } = validateVehicleMission(proposed)
  return structuredClone({ evidence: 'modeled-cargo-delivery-plan' as const, physicalFlightEnabled: false as const, identityAuthenticated: false as const, configuration, mission: plan, budget: { worstCaseMs, requiredWh } })
}
