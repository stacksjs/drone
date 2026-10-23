import { numericPacket } from './packets'
import type { VehiclePlantState } from '../types'

/** Fictional electrical law, not identified motor, propeller, cell or thermal behavior. */
export const vtolElectricalModel = Object.freeze({ auxiliaryW: 12, liftWPerN32: 4, pusherWPerN32: 5, surfaceWAtFullDeflection: 3, fullOpenCircuitV: 24, emptyOpenCircuitV: 20, resistanceOhm: 0.04 })

export function vtolElectricalLoad(rotorInput: readonly number[], pusherN: number, surfaceInput: readonly number[]) {
  const rotors = numericPacket(rotorInput, 4), surfaces = numericPacket(surfaceInput, 3)
  if (rotors.some(n => n < 0 || n > 100) || !Number.isFinite(pusherN) || pusherN < 0 || pusherN > 100 || surfaces.some(n => Math.abs(n) > 0.4)) throw new RangeError('Invalid fictional VTOL electrical load')
  return vtolElectricalModel.auxiliaryW + rotors.reduce((sum, n) => sum + vtolElectricalModel.liftWPerN32 * n ** 1.5, 0) + vtolElectricalModel.pusherWPerN32 * pusherN ** 1.5 + surfaces.reduce((sum, n) => sum + vtolElectricalModel.surfaceWAtFullDeflection * Math.abs(n) / 0.4, 0)
}

/** Stable low-current solution of P=VI with a declared series resistance. No regeneration. */
export function vtolElectricalSupply(loadW: number, remainingFraction: number) {
  if (!Number.isFinite(loadW) || loadW < 0 || !Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) throw new RangeError('Invalid fictional VTOL electrical supply')
  const openCircuitV = vtolElectricalModel.emptyOpenCircuitV + (vtolElectricalModel.fullOpenCircuitV - vtolElectricalModel.emptyOpenCircuitV) * remainingFraction
  const discriminant = openCircuitV ** 2 - 4 * vtolElectricalModel.resistanceOhm * loadW
  if (discriminant < 0) throw new RangeError('Fictional VTOL electrical demand exceeds supply')
  const currentA = 2 * loadW / (openCircuitV + Math.sqrt(discriminant))
  return { currentA, terminalV: openCircuitV - currentA * vtolElectricalModel.resistanceOhm, sourceW: openCircuitV * currentA }
}

/** All lift rotors, pusher and surfaces together, at the lowest declared source voltage. */
export function vtolElectricalMaximumW(maxRotorN: number, maxPusherN: number) {
  if (!Number.isFinite(maxRotorN) || maxRotorN <= 0 || !Number.isFinite(maxPusherN) || maxPusherN <= 0) throw new RangeError('Invalid VTOL electrical envelope')
  const loadW = vtolElectricalLoad([maxRotorN, maxRotorN, maxRotorN, maxRotorN], maxPusherN, [0.4, 0.4, 0.4])
  return Math.ceil(vtolElectricalSupply(loadW, 0).sourceW)
}

/** Sensor synthesis only: energy rounds upward, so quantization cannot invent capacity. */
export function renderVtolElectricalMeasurement(state: VehiclePlantState): Record<string, number | boolean> {
  if (!Object.hasOwn(state.details, 'batteryCapacityWh')) return {}
  const value = state.details
  const round = (name: string) => Math.round((value[name] as number) * 1000) / 1000
  return { batteryCapacityWh: value.batteryCapacityWh!, batteryEnergyUsedWh: Math.min(value.batteryCapacityWh as number, Math.ceil((value.batteryEnergyUsedWh as number) * 1000000) / 1000000), batterySourcePowerW: Math.ceil((value.batterySourcePowerW as number) * 1000) / 1000,
    batteryLoadPowerW: round('batteryLoadPowerW'), batteryCurrentA: round('batteryCurrentA'), batteryTerminalV: round('batteryTerminalV'), batteryCutoff: value.batteryCutoff! }
}
