import { geodeticToEcef } from '../estimation/frames'
import { antennaPointing, unwrapPan } from './geometry'
import type { AntennaAngles, AntennaConfig, AntennaMode, AntennaSelection, AntennaSnapshot, AntennaStopReason, AntennaTelemetry } from './types'

const identity = (s: string) => typeof s === 'string' && /^[\w.:/-]{1,80}$/.test(s)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x))

export function validateAntennaConfig(input: AntennaConfig): AntennaConfig {
  const c = structuredClone(input)
  geodeticToEcef(c.origin)
  if (!c.calibration || !identity(c.calibration.id) || !identity(c.clockDomainId)
    || ![c.calibration.panZeroTrueNorthDeg, c.calibration.tiltZeroElevationDeg, c.calibration.surveyAccuracyM].every(finite)
    || c.calibration.panZeroTrueNorthDeg < 0 || c.calibration.panZeroTrueNorthDeg >= 360 || Math.abs(c.calibration.tiltZeroElevationDeg) > 90 || c.calibration.surveyAccuracyM < 0)
    throw new RangeError('Invalid antenna survey, calibration or clock identity')
  const numbers = [c.panMinDeg, c.panMaxDeg, c.tiltMinDeg, c.tiltMaxDeg, c.cableNeutralPanDeg, c.maxCableTwistDeg, c.initialPanDeg, c.initialTiltDeg, c.maxRateDegPerSecond, c.maxAccelerationDegPerSecond2, c.maxFixAgeMs, c.maxClockUncertaintyMs, c.maxTickGapMs, c.maxPositionAccuracyM, c.maxPointingUncertaintyDeg, c.maxRangeM, c.minSnrDb, c.maxPacketLossFraction]
  if (!numbers.every(finite) || c.panMinDeg >= c.panMaxDeg || c.panMinDeg < -720 || c.panMaxDeg > 720
    || c.tiltMinDeg >= c.tiltMaxDeg || c.tiltMinDeg < -90 || c.tiltMaxDeg > 90
    || c.maxCableTwistDeg <= 0 || c.maxCableTwistDeg > 720 || c.cableNeutralPanDeg < c.panMinDeg || c.cableNeutralPanDeg > c.panMaxDeg
    || c.maxRateDegPerSecond <= 0 || c.maxRateDegPerSecond > 360 || c.maxAccelerationDegPerSecond2 <= 0 || c.maxAccelerationDegPerSecond2 > 2000
    || c.maxFixAgeMs <= 0 || c.maxFixAgeMs > 2000 || c.maxClockUncertaintyMs < 0 || c.maxClockUncertaintyMs > 50
    || c.maxTickGapMs <= 0 || c.maxTickGapMs > 200 || c.maxPositionAccuracyM <= 0 || c.maxPositionAccuracyM > 100
    || c.maxPointingUncertaintyDeg <= 0 || c.maxPointingUncertaintyDeg > 20 || c.maxRangeM < 1 || c.maxRangeM > 200000
    || c.minSnrDb < -30 || c.minSnrDb > 60 || c.maxPacketLossFraction < 0 || c.maxPacketLossFraction > 1)
    throw new RangeError('Invalid antenna motion or telemetry limits')
  if (angleFailure(c, { panDeg: c.initialPanDeg, tiltDeg: c.initialTiltDeg })) throw new RangeError('Initial antenna position violates travel or cable limits')
  return c
}

function angleFailure(c: AntennaConfig, a: AntennaAngles): AntennaStopReason | null {
  if (!a || typeof a !== 'object' || !finite(a.panDeg) || !finite(a.tiltDeg) || a.panDeg < c.panMinDeg || a.panDeg > c.panMaxDeg || a.tiltDeg < c.tiltMinDeg || a.tiltDeg > c.tiltMaxDeg) return 'travel-limit'
  if (Math.abs(a.panDeg - c.cableNeutralPanDeg) > c.maxCableTwistDeg) return 'cable-twist'
  return null
}

/** Owned trajectory planner. No bus, network, PWM, GPIO or physical adapter is reachable here. */
export function createAntennaTracker(input: AntennaConfig, now: () => number) {
  const c = validateAntennaConfig(input)
  let at = now()
  if (!finite(at) || at < 0) throw new RangeError('Invalid antenna monotonic clock')
  let tickAt = at, mode: AntennaMode = 'disabled', reason: AntennaStopReason | null = 'disabled'
  let selection: AntennaSelection | null = null, latest: (AntennaTelemetry & { receivedAtMs: number }) | null = null
  let position: AntennaAngles = { panDeg: c.initialPanDeg, tiltDeg: c.initialTiltDeg }
  let velocity = { panDegPerSecond: 0, tiltDegPerSecond: 0 }, goal: AntennaAngles | null = null
  let pointing: AntennaSnapshot['pointing'] = null, uncertainty: number | null = null, manualUntil = 0
  // Bounded lifetime replay ledger, retained across selection/override/stop. Recreate the tracker after 16 distinct streams.
  const watermarks = new Map<string, { sequence: number, capturedAtMs: number }>()
  const streamKey = (s: AntennaSelection) => JSON.stringify([s.targetId, s.telemetrySessionId])
  function halt(why: AntennaStopReason, next: AntennaMode = 'fault') {
    if (mode !== 'emergency') { mode = next; reason = why }
    velocity = { panDegPerSecond: 0, tiltDegPerSecond: 0 }; goal = null; pointing = null; uncertainty = null
  }
  function clock(): boolean {
    const value = now()
    if (!finite(value) || value < at) { halt('clock'); return false }
    at = value; return true
  }
  function qualify(): AntennaStopReason | null {
    if (!selection) return 'no-selection'
    if (!latest) return 'no-target'
    if (at - latest.capturedAtMs + latest.clockUncertaintyMs > c.maxFixAgeMs || at - latest.receivedAtMs > c.maxFixAgeMs) return 'stale-target'
    if (at - latest.link.capturedAtMs + latest.clockUncertaintyMs > c.maxFixAgeMs) return 'link-quality'
    return null
  }
  function snapshot(): AntennaSnapshot {
    return structuredClone({ evidence: 'simulation-only', physicalActuationEnabled: false, mode, directive: mode === 'tracking' || mode === 'manual' ? 'trajectory' : 'stop', reason, atMs: at, selection, calibrationId: c.calibration.id, position, velocity, goal, pointing, pointingUncertaintyDeg: uncertainty, targetSequence: latest?.sequence ?? null, link: latest?.link ?? null })
  }
  return {
    selectTarget(next: AntennaSelection): boolean {
      if (!clock() || mode === 'emergency') return false
      latest = null; selection = null; halt('no-selection')
      if (!next || typeof next !== 'object' || !identity(next.targetId) || !identity(next.telemetrySessionId)) throw new RangeError('Invalid antenna target selection')
      const key = streamKey(next)
      if (!watermarks.has(key)) {
        if (watermarks.size >= 16) throw new RangeError('Antenna stream ledger exhausted; create a new tracker session')
        watermarks.set(key, { sequence: -1, capturedAtMs: -1 })
      }
      selection = { targetId: next.targetId, telemetrySessionId: next.telemetrySessionId }; latest = null; tickAt = at; halt('disabled', 'disabled'); return true
    },
    ingest(sample: AntennaTelemetry): { accepted: boolean, reason: AntennaStopReason | null } {
      if (!clock()) return { accepted: false, reason: 'clock' }
      if (!sample || typeof sample !== 'object') { latest = null; halt('invalid-target'); return { accepted: false, reason: 'invalid-target' } }
      if (!selection || sample.targetId !== selection.targetId) return { accepted: false, reason: selection ? 'other-target' : 'no-selection' }
      let failure: AntennaStopReason | null = null
      if (sample.telemetrySessionId !== selection.telemetrySessionId) failure = 'wrong-session'
      else if (sample.clockDomainId !== c.clockDomainId || ![sample.capturedAtMs, sample.clockUncertaintyMs].every(finite) || sample.capturedAtMs < 0 || sample.capturedAtMs > at || sample.clockUncertaintyMs < 0 || sample.clockUncertaintyMs > c.maxClockUncertaintyMs) failure = 'clock'
      else if (!Number.isSafeInteger(sample.sequence) || sample.sequence < 0) failure = 'invalid-target'
      else {
        const previous = watermarks.get(streamKey(selection))!
        if (at - sample.capturedAtMs + sample.clockUncertaintyMs > c.maxFixAgeMs) failure = 'stale-target'
        else if (sample.sequence <= previous.sequence || sample.capturedAtMs <= previous.capturedAtMs) failure = 'replay'
        else if (![sample.horizontalAccuracyM, sample.verticalAccuracyM].every(finite) || sample.horizontalAccuracyM < 0 || sample.verticalAccuracyM < 0 || Math.max(sample.horizontalAccuracyM, sample.verticalAccuracyM) > c.maxPositionAccuracyM) failure = 'uncertain-target'
        else if (!sample.link || ![sample.link.capturedAtMs, sample.link.rssiDbm, sample.link.snrDb, sample.link.packetLossFraction].every(finite)
          || sample.link.capturedAtMs < 0 || sample.link.capturedAtMs > at || at - sample.link.capturedAtMs + sample.clockUncertaintyMs > c.maxFixAgeMs
          || sample.link.rssiDbm < -150 || sample.link.rssiDbm > 10 || sample.link.snrDb < c.minSnrDb || sample.link.snrDb > 100 || sample.link.packetLossFraction < 0 || sample.link.packetLossFraction > c.maxPacketLossFraction) failure = 'link-quality'
        else {
          try { geodeticToEcef(sample.position) }
          catch { failure = 'invalid-target' }
        }
      }
      if (failure) { latest = null; halt(failure); return { accepted: false, reason: failure } }
      latest = {
        targetId: sample.targetId, telemetrySessionId: sample.telemetrySessionId, sequence: sample.sequence,
        clockDomainId: sample.clockDomainId, capturedAtMs: sample.capturedAtMs, clockUncertaintyMs: sample.clockUncertaintyMs,
        position: { latitudeDeg: sample.position.latitudeDeg, longitudeDeg: sample.position.longitudeDeg, ellipsoidHeightM: sample.position.ellipsoidHeightM },
        horizontalAccuracyM: sample.horizontalAccuracyM, verticalAccuracyM: sample.verticalAccuracyM,
        link: { capturedAtMs: sample.link.capturedAtMs, rssiDbm: sample.link.rssiDbm, snrDb: sample.link.snrDb, packetLossFraction: sample.link.packetLossFraction },
        receivedAtMs: at,
      }
      watermarks.set(streamKey(selection), { sequence: sample.sequence, capturedAtMs: sample.capturedAtMs })
      return { accepted: true, reason: null }
    },
    engage(): boolean {
      if (!clock() || mode !== 'disabled') return false
      const failure = qualify()
      if (failure) { halt(failure); return false }
      mode = 'tracking'; reason = null; tickAt = at; return true
    },
    manual(next: AntennaAngles, leaseMs = 250): boolean {
      if (!clock() || mode === 'emergency' || mode === 'fault') return false
      if (!finite(leaseMs) || leaseMs < 1 || leaseMs > 1000) { halt('manual-expired'); throw new RangeError('Manual antenna lease must be 1..1000 ms') }
      const failure = angleFailure(c, next)
      if (failure) { halt(failure); return false }
      if (mode !== 'manual') { velocity = { panDegPerSecond: 0, tiltDegPerSecond: 0 }; tickAt = at }
      mode = 'manual'; reason = null; goal = { panDeg: next.panDeg, tiltDeg: next.tiltDeg }; pointing = null; uncertainty = null; latest = null; manualUntil = at + leaseMs; return true
    },
    stop() { if (clock()) { halt('disabled', 'disabled'); latest = null; selection = null; tickAt = at } },
    emergencyStop() { clock(); mode = 'emergency'; reason = 'emergency'; halt('emergency'); latest = null; selection = null },
    resetEmergency(): boolean {
      if (!clock() || mode !== 'emergency') return false
      mode = 'disabled'; reason = 'disabled'; tickAt = at; return true
    },
    tick(): AntennaSnapshot {
      if (!clock()) return snapshot()
      const dt = (at - tickAt) / 1000; tickAt = at
      if (mode !== 'tracking' && mode !== 'manual') return snapshot()
      if (dt * 1000 > c.maxTickGapMs) { halt('tick-gap'); return snapshot() }
      if (mode === 'manual') {
        if (at >= manualUntil) { halt('manual-expired'); return snapshot() }
      }
      else {
        const failure = qualify()
        if (failure) { halt(failure); return snapshot() }
        try { pointing = antennaPointing(c.origin, latest!.position) }
        catch { halt('singular-target'); return snapshot() }
        if (pointing.rangeM > c.maxRangeM) { halt('range'); return snapshot() }
        uncertainty = Math.atan2(Math.hypot(latest!.horizontalAccuracyM, latest!.verticalAccuracyM, c.calibration.surveyAccuracyM), pointing.rangeM) * 180 / Math.PI
        if (uncertainty > c.maxPointingUncertaintyDeg) { halt('uncertain-target'); return snapshot() }
        goal = { panDeg: unwrapPan(pointing.azimuthDeg - c.calibration.panZeroTrueNorthDeg, position.panDeg), tiltDeg: pointing.elevationDeg - c.calibration.tiltZeroElevationDeg }
        const outside = angleFailure(c, goal)
        if (outside) { halt(outside); return snapshot() }
      }
      if (dt <= 0) return snapshot()
      const advance = (current: number, speed: number, target: number) => {
        const error = target - current
        // Brake early, then slew velocity. A moving goal may reverse without a velocity discontinuity.
        const desired = Math.sign(error) * Math.min(c.maxRateDegPerSecond, Math.sqrt(2 * c.maxAccelerationDegPerSecond2 * Math.abs(error)), Math.abs(error) / dt)
        const nextSpeed = speed + clamp(desired - speed, -c.maxAccelerationDegPerSecond2 * dt, c.maxAccelerationDegPerSecond2 * dt)
        return { position: current + nextSpeed * dt, speed: nextSpeed }
      }
      const pan = advance(position.panDeg, velocity.panDegPerSecond, goal!.panDeg), tilt = advance(position.tiltDeg, velocity.tiltDegPerSecond, goal!.tiltDeg)
      const next = { panDeg: pan.position, tiltDeg: tilt.position }, outside = angleFailure(c, next)
      if (outside) { halt(outside); return snapshot() }
      position = next; velocity = { panDegPerSecond: pan.speed, tiltDegPerSecond: tilt.speed }
      return snapshot()
    },
  }
}
