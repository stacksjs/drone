import type { AntennaConfig, AntennaTelemetry } from '../../../resources/functions/drone/antenna/types'

export function antennaFixtureConfig(): AntennaConfig {
  return {
    origin: { latitudeDeg: 0, longitudeDeg: 0, ellipsoidHeightM: 0 },
    calibration: { id: 'fixture-level-survey', panZeroTrueNorthDeg: 10, tiltZeroElevationDeg: 2, surveyAccuracyM: 0.1 },
    clockDomainId: 'bench-monotonic',
    panMinDeg: -270, panMaxDeg: 270, tiltMinDeg: -10, tiltMaxDeg: 85,
    cableNeutralPanDeg: 0, maxCableTwistDeg: 240,
    initialPanDeg: 0, initialTiltDeg: 0,
    maxRateDegPerSecond: 60, maxAccelerationDegPerSecond2: 120,
    maxFixAgeMs: 500, maxClockUncertaintyMs: 5, maxTickGapMs: 100,
    maxPositionAccuracyM: 5, maxPointingUncertaintyDeg: 3, maxRangeM: 20000,
    minSnrDb: 0, maxPacketLossFraction: 0.3,
  }
}
export function antennaFix(now: number, sequence: number): AntennaTelemetry {
  return {
    targetId: 'vehicle-1', telemetrySessionId: 'boot-1', sequence,
    clockDomainId: 'bench-monotonic', capturedAtMs: now, clockUncertaintyMs: 0,
    position: { latitudeDeg: 0, longitudeDeg: 0.01, ellipsoidHeightM: 0 },
    horizontalAccuracyM: 0.2, verticalAccuracyM: 0.3,
    link: { capturedAtMs: now, rssiDbm: -50, snrDb: 30, packetLossFraction: 0 },
  }
}
