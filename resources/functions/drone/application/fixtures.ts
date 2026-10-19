import type { ApplicationConfig, ApplicationImplement } from './types'

/** Declared inert-material model only. Neither preset qualifies a physical implement or field dose. */
export function exampleApplicationConfig(type: ApplicationImplement = 'sprayer'): ApplicationConfig {
  if (type !== 'sprayer' && type !== 'spreader') throw new RangeError('Unknown modeled application implement')
  const liquid = type === 'sprayer'
  return {
    version: 1, id: `inert-${type}`, frame: 'LOCAL_NED', origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 100 },
    boundary: [[1, -1], [6, -1], [6, 1], [1, 1]], exclusions: [],
    prescription: [{ id: 'field-rate', polygon: [[1, -1], [6, -1], [6, 1], [1, 1]], ratePerHa: liquid ? 200 : 100 }],
    routeM: [[2, 0], [5, 0]], gridResolutionM: .5,
    material: { id: liquid ? 'inert-water' : 'inert-granules', batch: 'synthetic-batch', kind: liquid ? 'water' : 'inert-granules', unit: liquid ? 'L' : 'kg', densityKgPerL: liquid ? 1 : null, initialAmount: 1 },
    implement: { type, swathM: .8, footprintLengthM: .4, fallTimeS: .1, minSpeedMps: .15, maxSpeedMps: .8 },
    calibration: {
      id: `synthetic-${type}-meter`, evidence: 'synthetic', pulse: liquid ? { pulses: 4000, litres: 2, durationMs: 120000 } : null,
      scale: { tareRaw: 1000, loadedRaw: 11000, knownMassKg: 1 }, minRatePerSecond: liquid ? .001 : .0005, maxRatePerSecond: liquid ? .03 : .015,
      primaryCloseMs: 150, masterCloseMs: 100, energyTauMs: 80, noFlowTimeoutMs: 1000, closingAllowanceMs: 1000, encoderCounts: 1000,
    },
    weather: { windMps: [0, 0], temperatureC: 20, humidityPercent: 60, inversion: false },
    weatherLimits: { maxWindMps: 2, minTemperatureC: 5, maxTemperatureC: 35, minHumidityPercent: 30, maxAgeMs: 500 },
    localRequirements: { status: 'unqualified', jurisdiction: null, operatorId: 'declared-operator', evidenceLinks: [] },
  }
}
