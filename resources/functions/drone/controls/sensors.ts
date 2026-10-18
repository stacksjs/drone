import type { RigidBodyState } from './physics'
import { rotateNedToBody } from './physics'
import { createSensorPipeline } from '../sensors/pipeline'
import { runtimeCrc32 } from '../runtime/protocol'
import { multirotorModel } from './model'
const bootId = 55n, boardOrigin = 1000000n
/** Modeled raw IMU/GNSS only. Measurement epoch is known because this is a synthetic source. */
export function createPhysicsSensorFeed(additionalDelayMs: number) {
  if (!Number.isFinite(additionalDelayMs) || additionalDelayMs < 0 || additionalDelayMs > 200) throw new RangeError('Sensor delay must be 0..200 ms')
  const pipeline = createSensorPipeline({ anchor: { bootId, boardUs: boardOrigin, localMs: 0, uncertaintyUs: 0, driftPpm: 0, source: 'fixture' }, calibrations: { imu: {
    id: 'physics-frd-synthetic', provenance: 'fixture', axes: [1, 2, 3], referenceC: 25, minC: -20, maxC: 60, accelBias: [0, 0, 0], gyroBias: [0, 0, 0], accelScale: [1, 1, 1], gyroScale: [1, 1, 1], accelTempSlope: [0, 0, 0], gyroTempSlope: [0, 0, 0], accelNoiseStd: [0.005, 0.005, 0.005], gyroNoiseStd: [0.001, 0.001, 0.001],
  } } })
  const queue: { atMs: number, bytes: Uint8Array }[] = []
  let imuSequence = 0, gnssSequence = 0, lastAnchor = 0
  function packet(kind: number, sequence: number, atMs: number, payload: Uint8Array, valid: boolean) {
    if (queue.length >= 32) throw new RangeError('Synthetic sensor queue budget exceeded')
    const bytes = new Uint8Array(128), v = new DataView(bytes.buffer)
    bytes.set([68, 83, 1, kind]); v.setUint32(4, sequence, true); v.setBigUint64(8, bootId, true)
    const captured = boardOrigin + BigInt(atMs * 1000)
    v.setBigUint64(16, captured, true); v.setBigUint64(24, captured + 100n, true)
    v.setUint32(32, valid ? 9 : 10, true); v.setUint16(36, kind, true); v.setUint16(38, payload.length, true); v.setUint32(40, 1000, true)
    bytes.set(payload, 44); v.setUint32(124, runtimeCrc32(bytes.subarray(0, 124)), true)
    queue.push({ atMs: atMs + 4 + additionalDelayMs, bytes })
  }
  return {
    capture(state: RigidBodyState, atMs: number, dropImu = false) {
      if (atMs % 20 === 0 && !dropImu) {
        const p = new Uint8Array(16), v = new DataView(p.buffer)
        const specific = rotateNedToBody(state.quaternionWxyz, [state.accelerationMps2[0], state.accelerationMps2[1], state.accelerationMps2[2] - multirotorModel.gravityMps2])
        const counts = [...specific.map(n => n / multirotorModel.gravityMps2 * 2048), ...state.angularRateRadS.map(n => n * 180 / Math.PI / 2000 * 32768)]
        counts[0] = counts[0]! + (++imuSequence % 3 - 1) // Deterministic one-count dither avoids an artificial bit-perfect stuck source.
        const valid = counts.every(n => Number.isFinite(n) && Math.abs(n) < 32767)
        counts.forEach((n, i) => v.setInt16(2 + i * 2, Math.max(-32768, Math.min(32767, Math.round(n))), false))
        p[14] = 6; p[15] = 6; packet(1, imuSequence, atMs, p, valid)
      }
      if (atMs % 100 === 0) {
        const p = new Uint8Array(80), v = new DataView(p.buffer)
        v.setUint32(0, 100000 + atMs, true); p[20] = 3; p[21] = 1; p[23] = 12
        v.setInt32(28, Math.round(state.positionM[0] / 6335539.3272928195 * 180 / Math.PI * 1e7), true)
        v.setInt32(24, Math.round(state.positionM[1] / 6378237 * 180 / Math.PI * 1e7), true)
        v.setInt32(32, Math.round((100 - state.positionM[2]) * 1000), true); v.setInt32(36, Math.round((70 - state.positionM[2]) * 1000), true)
        v.setUint32(40, 20, true); v.setUint32(44, 30, true); v.setUint32(68, 10, true)
        state.velocityMps.forEach((n, i) => v.setInt32(48 + i * 4, Math.round(n * 1000), true))
        packet(3, ++gnssSequence, atMs, p, true)
      }
    },
    advanceTo(nowMs: number) {
      if (nowMs - lastAnchor >= 4000) {
        pipeline.reanchor({ bootId, boardUs: boardOrigin + BigInt(nowMs * 1000), localMs: nowMs, uncertaintyUs: 0, driftPpm: 0, source: 'fixture' }, nowMs); lastAnchor = nowMs
      }
      while (queue[0] && queue[0].atMs <= nowMs) pipeline.ingest(queue.shift()!.bytes, nowMs)
      return pipeline.snapshot(nowMs)
    },
  }
}
