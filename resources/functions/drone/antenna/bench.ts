import type { GeodeticOrigin } from '../estimation/frames'
import { createAntennaTracker } from './tracker'
import type { AntennaAngles, AntennaConfig, AntennaSnapshot, AntennaTelemetry } from './types'

export const antennaBenchScenarios = ['nominal', 'target-loss', 'replay', 'wrong-session', 'clock-reset', 'cable-limit', 'manual', 'emergency', 'poor-link', 'stale-fix'] as const
export type AntennaBenchScenario = typeof antennaBenchScenarios[number]
const radians = Math.PI / 180

/** Synthetic surveyed mount only, never a transferable hardware configuration. */
export function antennaBenchConfig(): AntennaConfig {
  return {
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 0 },
    calibration: { id: 'synthetic-level-equator', panZeroTrueNorthDeg: 10, tiltZeroElevationDeg: 2, surveyAccuracyM: 0.1 },
    clockDomainId: 'antenna-bench-local',
    panMinDeg: -270, panMaxDeg: 270, tiltMinDeg: -10, tiltMaxDeg: 85,
    cableNeutralPanDeg: 0, maxCableTwistDeg: 240, initialPanDeg: 0, initialTiltDeg: 10,
    maxRateDegPerSecond: 60, maxAccelerationDegPerSecond2: 120,
    maxFixAgeMs: 500, maxClockUncertaintyMs: 5, maxTickGapMs: 100,
    maxPositionAccuracyM: 5, maxPointingUncertaintyDeg: 3, maxRangeM: 20000,
    minSnrDb: 0, maxPacketLossFraction: 0.3,
  }
}

/** Bench sensor synthesis: inverse ECEF at an equatorial surveyed origin.
 * The scoring oracle retains the original local vector and never calls antennaPointing.
 * Fixed-point latitude inversion is independent of the production forward WGS84 transform.
 */
function geodeticMeasurement([north, east, up]: [number, number, number]): GeodeticOrigin {
  const a = 6378137, eccentricity2 = 0.0066943799901413165
  const x = a + up, y = east, z = north, radius = Math.hypot(x, y)
  let latitude = Math.atan2(z, radius)
  for (let i = 0; i < 12; i++) {
    const n = a / Math.sqrt(1 - eccentricity2 * Math.sin(latitude) ** 2)
    latitude = Math.atan2(z + eccentricity2 * n * Math.sin(latitude), radius)
  }
  const n = a / Math.sqrt(1 - eccentricity2 * Math.sin(latitude) ** 2)
  return { latitudeDeg: latitude / radians, longitudeDeg: Math.atan2(y, x) / radians, ellipsoidHeightM: radius / Math.cos(latitude) - n }
}
function truthAt(seconds: number, cable = false): [number, number, number] {
  const azimuth = (cable ? 240 + 3 * seconds : 10 + 35 * Math.sin(0.4 * seconds)) * radians
  const elevation = (12 + 3 * Math.sin(0.3 * seconds)) * radians, distance = 600
  return [distance * Math.cos(elevation) * Math.cos(azimuth), distance * Math.cos(elevation) * Math.sin(azimuth), distance * Math.sin(elevation)]
}
function errorDeg(actual: AntennaAngles, truth: [number, number, number], config: AntennaConfig): number {
  const azimuth = (actual.panDeg + config.calibration.panZeroTrueNorthDeg) * radians
  const elevation = (actual.tiltDeg + config.calibration.tiltZeroElevationDeg) * radians
  const pointing = [Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation)]
  return Math.acos(Math.max(-1, Math.min(1, pointing.reduce((sum, n, i) => sum + n * truth[i]!, 0) / Math.hypot(...truth)))) / radians
}
function correlation(a: number[], b: number[]): number | null {
  if (a.length < 2) return null
  const ma = a.reduce((sum, x) => sum + x, 0) / a.length, mb = b.reduce((sum, x) => sum + x, 0) / b.length
  const covariance = a.reduce((sum, x, i) => sum + (x - ma) * (b[i]! - mb), 0)
  const denominator = Math.sqrt(a.reduce((sum, x) => sum + (x - ma) ** 2, 0) * b.reduce((sum, x) => sum + (x - mb) ** 2, 0))
  return denominator > 1e-12 ? covariance / denominator : null
}

export function runAntennaBench(options: { scenario?: AntennaBenchScenario, seconds?: number } = {}) {
  const scenario = options.scenario ?? 'nominal', seconds = options.seconds ?? 12
  if (!antennaBenchScenarios.includes(scenario)) throw new RangeError('Unknown antenna scenario')
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 60) throw new RangeError('Antenna bench duration must be an integer from 10 to 60 seconds')
  const config = antennaBenchConfig()
  if (scenario === 'cable-limit') config.initialPanDeg = 230
  let time = 1000, actual = { panDeg: config.initialPanDeg, tiltDeg: config.initialTiltDeg }, sequence = 0
  const tracker = createAntennaTracker(config, () => time)
  tracker.selectTarget({ targetId: 'selected-vehicle', telemetrySessionId: 'synthetic-boot' })
  let previousFix: AntennaTelemetry | null = null, final = tracker.tick()
  let firstStop: { atMs: number, reason: AntennaSnapshot['reason'] } | null = null, trajectoryCommandsAfterStop = 0
  const errors: number[] = [], rssi: number[] = [], squaredErrors: number[] = []
  const samples: { elapsedMs: number, mode: AntennaSnapshot['mode'], errorDeg: number, linkErrorDeg: number, modeledRssiDbm: number, panDeg: number, tiltDeg: number }[] = []
  for (let elapsed = 0; elapsed <= seconds * 1000; elapsed += 20) {
    time = 1000 + elapsed
    if (scenario === 'clock-reset' && elapsed >= 6000) time -= 1000
    const truth = truthAt(elapsed / 1000, scenario === 'cable-limit'), before = errorDeg(actual, truth, config)
    // Deliberately simple beam model. Correlation is by construction, never a measured link claim.
    const modeledRssiDbm = -45 - 0.04 * before ** 2
    if (elapsed % 100 === 0 && !(scenario === 'target-loss' && elapsed >= 6000)) {
      const fix: AntennaTelemetry = {
        targetId: 'selected-vehicle', telemetrySessionId: 'synthetic-boot', sequence: ++sequence,
        clockDomainId: config.clockDomainId, capturedAtMs: time - 40, clockUncertaintyMs: 1,
        position: geodeticMeasurement(truthAt((elapsed - 40) / 1000, scenario === 'cable-limit')),
        horizontalAccuracyM: 0.2, verticalAccuracyM: 0.3,
        link: { capturedAtMs: time, rssiDbm: Math.max(-149, modeledRssiDbm), snrDb: 30, packetLossFraction: 0.01 },
      }
      if (elapsed === 6000) {
        if (scenario === 'wrong-session') fix.telemetrySessionId = 'unselected-reboot'
        if (scenario === 'poor-link') fix.link.snrDb = -10
        if (scenario === 'stale-fix') fix.capturedAtMs = time - 900
      }
      tracker.ingest(scenario === 'replay' && elapsed === 6000 ? previousFix! : fix)
      previousFix = fix
      if (elapsed === 0) tracker.engage()
    }
    if (scenario === 'manual' && elapsed >= 6000 && elapsed < 7000 && elapsed % 100 === 0) tracker.manual({ panDeg: 0, tiltDeg: 10 }, 150)
    if (scenario === 'emergency' && elapsed === 6000) tracker.emergencyStop()
    final = tracker.tick()
    if (!firstStop && (final.mode === 'fault' || final.mode === 'emergency')) firstStop = { atMs: elapsed, reason: final.reason }
    if (firstStop && (final.directive !== 'stop' || final.velocity.panDegPerSecond !== 0 || final.velocity.tiltDegPerSecond !== 0)) trajectoryCommandsAfterStop++
    // Independent lagged mount model, including continuing settling after a stop directive.
    // Physical emergency braking/hold performance cannot be inferred from this simulation.
    const gain = 1 - Math.exp(-0.02 / 0.1)
    actual = { panDeg: actual.panDeg + (final.position.panDeg - actual.panDeg) * gain, tiltDeg: actual.tiltDeg + (final.position.tiltDeg - actual.tiltDeg) * gain }
    if (elapsed >= 2000 && final.mode === 'tracking') {
      errors.push(errorDeg(actual, truth, config)); squaredErrors.push(before ** 2); rssi.push(modeledRssiDbm)
    }
    if (elapsed % 100 === 0) samples.push({ elapsedMs: elapsed, mode: final.mode, errorDeg: errorDeg(actual, truth, config), linkErrorDeg: before, modeledRssiDbm, ...actual })
  }
  const maximum = errors.length ? Math.max(...errors) : null
  return {
    version: 1 as const, evidence: 'modeled-bench' as const, physicalActuationEnabled: false as const, scenario, seconds,
    model: { dtMs: 20, telemetryPeriodMs: 100, telemetryLatencyMs: 40, mountLagMs: 100, encoderModel: 'ideal modeled encoder', rfModel: 'RSSI = -45 - 0.04 * angularErrorDeg^2', scoring: 'independent generated local N/E/U truth', scoringStartsMs: 2000 },
    calibration: config.calibration, selectedTarget: 'selected-vehicle',
    pointing: { samples: errors.length, toleranceDeg: 3.5, maxErrorDeg: maximum, rmsErrorDeg: errors.length ? Math.sqrt(errors.reduce((sum, x) => sum + x * x, 0) / errors.length) : null },
    link: { evidence: 'modeled' as const, samples: rssi.length, errorSquaredRssiCorrelation: correlation(squaredErrors, rssi) },
    withinModeledPointingTolerance: scenario === 'nominal' && maximum !== null && maximum < 3.5,
    firstStop, trajectoryCommandsAfterStop, final, samples,
    hardwareAcceptance: 'pending measured surveyed mount, encoders, braking, cable limits and RF/link observations',
  }
}
