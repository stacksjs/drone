import type { GnssMeasurement, SensorCalibrationSet, SensorClockAnchor, SensorKind, SensorObservation, SensorPacket } from './types'
import type { RuntimeFrame } from '../runtime/protocol'
import { convertImu, convertPressure, validateSensorCalibrations } from './calibration'
import { decodeSensorFrame, sensorKinds } from './protocol'

export const sensorLimits = { imu: { maxAgeMs: 80, stuckMs: 500 }, barometer: { maxAgeMs: 300, stuckMs: 2000 }, gnss: { maxAgeMs: 1500, stuckMs: 2000 } } as const
export function sensorAnchorFromHandshake(input: { startedMs: number, receivedMs: number, sessionId: bigint, status: RuntimeFrame }): SensorClockAnchor {
  const { status, startedMs, receivedMs } = input
  if (![startedMs, receivedMs].every(Number.isFinite) || receivedMs < startedMs || receivedMs - startedMs > 20 || status.kind !== 'status'
    || status.bootId <= 0n || status.sessionId !== input.sessionId || input.sessionId <= 0n || (status.flags & 95) !== 67 || (status.flags & ~127) !== 0
    || status.sequence === 0 || status.stateBytes < 1 || status.stateBytes > 128 || status.maxExecutionUs > 500 || status.deadlineMisses !== 0 || status.leaseUs !== 0 || status.ticks === 0)
    throw new RangeError('A fresh, healthy nonce-matched runtime handshake within 20 ms is required')
  return { bootId: status.bootId, boardUs: status.sampleTimeUs, localMs: (startedMs + receivedMs) / 2, uncertaintyUs: (receivedMs - startedMs) * 500 + 1500, driftPpm: 200, source: 'handshake' }
}
function gnssValue(payload: Uint8Array): GnssMeasurement {
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (payload[20] !== 3 || !(payload[21]! & 1) || (v.getUint16(78, true) & 1) || payload[23]! < 4) throw new RangeError('GNSS requires a valid 3D fix and LLH')
  const latitudeDeg = v.getInt32(28, true) / 1e7, longitudeDeg = v.getInt32(24, true) / 1e7
  const h = v.getUint32(40, true) / 1000, a = v.getUint32(44, true) / 1000, s = v.getUint32(68, true) / 1000
  const sourceTowMs = v.getUint32(0, true)
  if (Math.abs(latitudeDeg) > 90 || Math.abs(longitudeDeg) > 180 || sourceTowMs >= 604800000 || [h, a, s].some(n => n <= 0 || n > 1000)) throw new RangeError('Invalid GNSS coordinates, epoch or accuracy')
  return { frame: 'WGS84_GEODETIC_NED_VELOCITY', sourceTowMs, latitudeDeg, longitudeDeg, ellipsoidHeightM: v.getInt32(32, true) / 1000, mslHeightM: v.getInt32(36, true) / 1000,
    velocityNedMps: [v.getInt32(48, true) / 1000, v.getInt32(52, true) / 1000, v.getInt32(56, true) / 1000],
    positionVarianceNedM2: [h * h, h * h, a * a], velocityVarianceNedM2S2: [s * s, s * s, s * s] }
}
export function validateSensorAnchor(input: SensorClockAnchor): SensorClockAnchor {
  const anchor = structuredClone(input)
  if (typeof anchor.bootId !== 'bigint' || anchor.bootId <= 0n || anchor.bootId > 0xFFFFFFFFFFFFFFFFn || typeof anchor.boardUs !== 'bigint' || anchor.boardUs < 0n || anchor.boardUs > 0xFFFFFFFFFFFFFFFFn
    || ![anchor.localMs, anchor.uncertaintyUs, anchor.driftPpm].every(Number.isFinite) || anchor.uncertaintyUs < 0 || anchor.uncertaintyUs > 20000
    || anchor.driftPpm < 0 || anchor.driftPpm > 1000 || !['fixture', 'handshake'].includes(anchor.source)) throw new RangeError('Invalid sensor clock anchor')
  return anchor
}
interface State { packet?: SensorPacket, observation?: SensorObservation, fingerprint?: string, changedUs?: bigint, tow?: number, fault: string | null }
/** Sensor diagnostics only. No estimator, arming authority or flight Telemetry is produced. */
export function createSensorPipeline(options: { anchor: SensorClockAnchor, calibrations?: SensorCalibrationSet }) {
  let anchor = validateSensorAnchor(options.anchor)
  const calibrations = validateSensorCalibrations(options.calibrations ?? {})
  const states: Record<SensorKind, State> = { imu: { fault: null }, barometer: { fault: null }, gnss: { fault: null } }
  let lastNow = anchor.localMs
  let rejected = 0
  let invalidAnchor: string | null = null
  function clock(now: number) {
    if (!Number.isFinite(now) || now < lastNow) {
      invalidAnchor = 'clock-discontinuity'
      for (const state of Object.values(states)) { state.observation = undefined; state.fault = 'clock-discontinuity' }
      throw new RangeError('Sensor consumer clock discontinuity')
    }
    lastNow = now
  }
  function reject(kind: SensorKind | null, reason: string) {
    rejected++
    for (const key of kind ? [kind] : sensorKinds) { states[key].observation = undefined; states[key].fault = reason }
    return { accepted: false as const, reason }
  }
  function age(observation: SensorObservation, packet: SensorPacket, now: number) {
    const drift = Math.max(Math.abs(now - anchor.localMs), Math.abs(observation.estimatedCaptureMs - anchor.localMs)) * anchor.driftPpm / 1000
    const transportAgeUpperMs = Math.max(0, now - observation.estimatedCaptureMs + (anchor.uncertaintyUs + drift) / 1000)
    const unknown = packet.uncertaintyUs === 0xFFFFFFFF || !!(packet.flags & 32)
    return { transportAgeUpperMs, measurementAgeUpperMs: unknown ? null : transportAgeUpperMs + packet.uncertaintyUs / 1000, timeUncertaintyUs: unknown ? null : anchor.uncertaintyUs + drift + packet.uncertaintyUs }
  }
  return {
    reanchor(input: SensorClockAnchor, nowMs: number) {
      const next = validateSensorAnchor(input)
      clock(nowMs)
      if (next.source !== anchor.source || next.localMs <= anchor.localMs || next.localMs > nowMs || nowMs - next.localMs > 20) throw new RangeError('Clock refresh must be fresh, ordered and retain its evidence source')
      if (next.bootId === anchor.bootId) {
        const deltaUs = Number(next.boardUs - anchor.boardUs)
        const skewUs = Math.abs((next.localMs - anchor.localMs) * 1000 - deltaUs)
        const boundUs = anchor.uncertaintyUs + next.uncertaintyUs + (next.localMs - anchor.localMs) * anchor.driftPpm / 1000
        if (deltaUs <= 0 || !Number.isSafeInteger(deltaUs) || skewUs > boundUs) throw new RangeError('Clock refresh disagrees with the existing board clock')
        for (const state of Object.values(states)) if (state.observation) state.observation.estimatedCaptureMs = next.localMs + Number(state.observation.capturedUs - next.boardUs) / 1000
      }
      else for (const kind of sensorKinds) states[kind] = { fault: 'board-boot-changed' }
      anchor = next; invalidAnchor = null
    },
    ingest(bytes: Uint8Array, receivedAtMs: number) {
      clock(receivedAtMs)
      let packet: SensorPacket
      try { packet = decodeSensorFrame(bytes) }
      catch { return reject(null, 'invalid-wire-frame') }
      const state = states[packet.kind]
      if (packet.bootId !== anchor.bootId) invalidAnchor = 'board-boot-changed'
      if (receivedAtMs - anchor.localMs > 5000) invalidAnchor = 'clock-anchor-expired'
      if (invalidAnchor) return reject(null, invalidAnchor)
      const delta = Number(packet.capturedUs - anchor.boardUs)
      if (!Number.isSafeInteger(delta)) return reject(packet.kind, 'timestamp-range')
      const estimatedCaptureMs = anchor.localMs + delta / 1000
      const estimatedCompletionMs = estimatedCaptureMs + Number(packet.completedUs - packet.capturedUs) / 1000
      const uncertaintyMs = (anchor.uncertaintyUs + Math.max(Math.abs(receivedAtMs - anchor.localMs), Math.abs(estimatedCompletionMs - anchor.localMs)) * anchor.driftPpm / 1000) / 1000
      if (estimatedCompletionMs - uncertaintyMs > receivedAtMs) return reject(packet.kind, 'future-sample')
      if (state.packet && (packet.sequence <= state.packet.sequence || packet.capturedUs <= state.packet.capturedUs)) return reject(packet.kind, 'replayed-or-reversed-sample')
      state.packet = packet
      if (!(packet.flags & 1) || (packet.flags & 18)) return reject(packet.kind, packet.flags & 2 ? 'sensor-bus-error' : 'source-time-error')
      const quality: string[] = []
      if (anchor.source === 'fixture') quality.push('synthetic-fixture')
      if (packet.flags & 4) quality.push('stream-overrun')
      if (packet.flags & 8) quality.push('timestamp-estimated')
      if (packet.flags & 32) quality.push('timing-unvalidated')
      if (packet.uncertaintyUs === 0xFFFFFFFF) quality.push('measurement-epoch-unaligned')
      const fingerprint = Array.from(packet.payload).join(',')
      if (state.fingerprint !== fingerprint) state.changedUs = packet.capturedUs
      state.fingerprint = fingerprint
      if (state.changedUs !== undefined && Number(packet.capturedUs - state.changedUs) / 1000 >= sensorLimits[packet.kind].stuckMs) quality.push('stuck-suspected')
      let value: SensorObservation['value'], calibrationId: string | null = null
      try {
        if (packet.kind === 'imu') {
          const cal = calibrations.imu
          value = convertImu(packet.payload, cal); calibrationId = cal?.id ?? null
          if (!cal) quality.push('uncalibrated', 'covariance-unknown')
          else { if (value.temperatureC < cal.minC || value.temperatureC > cal.maxC) quality.push('temperature-outside-calibration'); quality.push(`calibration-${cal.provenance}`) }
        }
        else if (packet.kind === 'barometer') {
          const cal = calibrations.barometer
          value = convertPressure(packet.payload, cal); calibrationId = cal?.id ?? null
          if (!cal) quality.push('field-calibration-missing', 'covariance-unknown')
          else { if (value.temperatureC < cal.minC || value.temperatureC > cal.maxC) quality.push('temperature-outside-calibration'); quality.push(`calibration-${cal.provenance}`) }
        }
        else {
          value = gnssValue(packet.payload)
          if (state.tow !== undefined && (value.sourceTowMs <= state.tow) && !(state.tow > 604798000 && value.sourceTowMs < 2000)) return reject('gnss', 'gnss-epoch-stalled-or-reversed')
          state.tow = value.sourceTowMs
          quality.push('accuracy-derived-diagonal-covariance')
        }
      }
      catch (error) { return reject(packet.kind, error instanceof Error ? error.message : 'invalid-measurement') }
      const observation: SensorObservation = { kind: packet.kind, deviceId: `pico2/${packet.kind}/${packet.deviceId}`, sequence: packet.sequence, capturedUs: packet.capturedUs, receivedAtMs,
        estimatedCaptureMs, measurementAgeUpperMs: null, transportAgeUpperMs: 0, timeUncertaintyUs: null, quality, healthy: false, calibrationId, value }
      Object.assign(observation, age(observation, packet, receivedAtMs))
      if (observation.transportAgeUpperMs > sensorLimits[packet.kind].maxAgeMs || (observation.measurementAgeUpperMs !== null && observation.measurementAgeUpperMs > sensorLimits[packet.kind].maxAgeMs)) return reject(packet.kind, 'stale-at-ingress')
      state.observation = observation; state.fault = null
      return { accepted: true as const, kind: packet.kind }
    },
    snapshot(nowMs: number) {
      clock(nowMs)
      const result = sensorKinds.map(kind => {
        const state = states[kind]
        if (!state.observation || !state.packet) return { kind, healthy: false, quality: [state.fault ?? 'missing'], observation: null }
        const observation = structuredClone(state.observation)
        Object.assign(observation, age(observation, state.packet, nowMs))
        if (nowMs - anchor.localMs > 5000) observation.quality.push('clock-anchor-expired')
        if (invalidAnchor) observation.quality.push(invalidAnchor)
        if (observation.transportAgeUpperMs > sensorLimits[kind].maxAgeMs || (observation.measurementAgeUpperMs !== null && observation.measurementAgeUpperMs > sensorLimits[kind].maxAgeMs)) observation.quality.push('dropout-or-stale')
        const faults = ['uncalibrated', 'covariance-unknown', 'field-calibration-missing', 'stuck-suspected', 'temperature-outside-calibration', 'measurement-epoch-unaligned', 'timing-unvalidated', 'dropout-or-stale', 'clock-anchor-expired']
        observation.healthy = !invalidAnchor && !observation.quality.some(q => faults.includes(q))
        return { kind, healthy: observation.healthy, quality: observation.quality, observation }
      })
      return { sensors: result, rejected, physicalFlightEnabled: false as const, evidence: anchor.source }
    },
  }
}
