import type { ApplicationPulseCalibration, ApplicationScaleCalibration } from './types'

function number(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RangeError('Invalid application calibration quantity or range')
}
function fields(value: unknown, names: string[]) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new TypeError('Invalid application calibration record')
  let count = 0
  for (const name of Object.getOwnPropertyNames(value)) {
    if (!names.includes(name) || ++count > names.length || !('value' in Object.getOwnPropertyDescriptor(value, name)!)) throw new TypeError('Invalid application calibration fields or accessor')
  }
  if (count !== names.length) throw new TypeError('Invalid application calibration fields')
}
/** Independently caught water volume and cumulative meter counts, pulses per litre. */
export function applicationPulseFactor(pulse: ApplicationPulseCalibration): number {
  fields(pulse, ['pulses', 'litres', 'durationMs'])
  number(pulse.pulses, 1, 1e9); number(pulse.litres, .0001, 10000); number(pulse.durationMs, 100, 3600000)
  if (!Number.isSafeInteger(pulse.pulses) || !Number.isSafeInteger(pulse.durationMs)) throw new RangeError('Application pulse count and duration must be integers')
  const factor = pulse.pulses / pulse.litres
  number(factor, 1, 1e8)
  return factor
}
/** Independent tare and known inert load, raw scale counts per kilogram. */
export function applicationScaleFactor(scale: ApplicationScaleCalibration): number {
  fields(scale, ['tareRaw', 'loadedRaw', 'knownMassKg'])
  number(scale.tareRaw, -1e9, 1e9); number(scale.loadedRaw, -1e9, 1e9); number(scale.knownMassKg, .0001, 10000)
  if (!Number.isSafeInteger(scale.tareRaw) || !Number.isSafeInteger(scale.loadedRaw) || scale.loadedRaw <= scale.tareRaw) throw new RangeError('Application scale load must exceed integer tare')
  const factor = (scale.loadedRaw - scale.tareRaw) / scale.knownMassKg
  number(factor, 1, 1e8)
  return factor
}
export function applicationScaleMass(scale: ApplicationScaleCalibration, raw: number): number {
  const factor = applicationScaleFactor(scale)
  number(raw, scale.tareRaw, 1e9)
  if (!Number.isSafeInteger(raw)) throw new RangeError('Application raw scale count must be an integer')
  return (raw - scale.tareRaw) / factor
}
/** L/ha or kg/ha times ground-speed magnitude and effective swath, divided by 10,000 m2/ha. No positive flow floor. */
export function applicationRatePerSecond(ratePerHa: number, speedMps: number, swathM: number): number {
  number(ratePerHa, 0, 1e6); number(speedMps, -10, 10); number(swathM, .01, 20)
  return ratePerHa * Math.abs(speedMps) * swathM / 10000
}
