import type { V3, EnvironmentProfile } from './plan'
import { compact, dataRecord, denseArray, finite, integer, sha256, unavailable, vector } from './plan'

const environmentStandards = Object.freeze([[0, 911], [50, 6061], [100, 11211]].map(pair => Object.freeze(pair)))
export const environmentHeldOut = Object.freeze([[0.7, 983], [13.37, 2288], [41.23, 5158], [73.19, 8450], [98.51, 11058]].map(pair => Object.freeze(pair)))
export function fitEnvironmentCalibration(input: unknown = environmentStandards) {
  const standards = denseArray(input, 3, 3).map(row => {
    const pair = denseArray(row, 2, 2)
    return [finite(pair[0], 0, 100), integer(pair[1], 0, 65535)]
  })
  if (standards.some((row, i) => i > 0 && row[0]! <= standards[i - 1]![0]!)) return unavailable()
  const meanU = standards.reduce((sum, row) => sum + row[0]!, 0) / 3
  const meanC = standards.reduce((sum, row) => sum + row[1]!, 0) / 3
  const slope = standards.reduce((sum, row) => sum + (row[0]! - meanU) * (row[1]! - meanC), 0) / standards.reduce((sum, row) => sum + (row[0]! - meanU) ** 2, 0)
  const offset = meanC - slope * meanU
  if (!Number.isFinite(slope) || slope <= 0 || !Number.isFinite(offset)) return unavailable()
  const data = { version: 1, id: 'environment-adc-synthetic-v1', evidence: 'synthetic', unit: 'U', rangeU: [0, 100], standards, slope, offset, referenceAbsBoundU: 0.01 }
  return { ...data, sha256: sha256(compact(data)) }
}
export type EnvironmentCalibration = ReturnType<typeof fitEnvironmentCalibration>
export function reduceEnvironmentCount(counts: unknown, calibration: EnvironmentCalibration): number {
  integer(counts, 0, 65535)
  if (!Number.isFinite(calibration.slope) || calibration.slope <= 0 || !Number.isFinite(calibration.offset)) return unavailable()
  return finite(((counts as number) - calibration.offset) / calibration.slope, 0, 100)
}
export interface Diagnostic { atMs: number, positionM: V3, velocityMps: V3, fieldU: number, cellU: number, plantMotorsN: [number, number, number, number] }
export interface RawPacket { version: 1, sourceId: 'environment-detector-1', sessionId: 'environment-fixture-v1', sequence: number, capturedAtMs: number, receivedAtMs: number, counts: number, clockDomain: 'fixture-monotonic-ms', clockUncertaintyMs: 1 }
export interface PacketRecord { sequence: number, capturedAtMs: number, dueAtMs: number, packet: RawPacket | null, disposition: 'delivered' | 'suppressed' | 'unreceived-on-retirement', admission: 'admitted' | 'not-airborne' | 'rejected' | null, reason: string | null }
export function environmentField(position: V3, atMs: number): number { return 40 + 2 * position[0] + position[1] - 3 * position[2] + 4 * Math.sin(2 * Math.PI * atMs / 10000) }
export function stepEnvironmentCell(previous: number, field: number): number {
  finite(previous, 0, 100); finite(field, 0, 100)
  const a = Math.exp(-0.020 / 0.4)
  return a * previous + (1 - a) * field
}
export function validateRawEnvironmentPacket(input: unknown): RawPacket {
  const p = dataRecord(input, ['version', 'sourceId', 'sessionId', 'sequence', 'capturedAtMs', 'receivedAtMs', 'counts', 'clockDomain', 'clockUncertaintyMs'])
  if (Object.keys(p).join(',') !== 'version,sourceId,sessionId,sequence,capturedAtMs,receivedAtMs,counts,clockDomain,clockUncertaintyMs') return unavailable()
  // Identity mismatches may be representable rejected evidence, but wire types remain closed.
  if (p.version !== 1 || typeof p.sourceId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.sourceId) || typeof p.sessionId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.sessionId) || typeof p.clockDomain !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.clockDomain)) return unavailable()
  integer(p.sequence, 1, 1001); integer(p.capturedAtMs); integer(p.receivedAtMs); integer(p.counts, 0, 65535); finite(p.clockUncertaintyMs, 0, 100000)
  return p as unknown as RawPacket
}
/** Concrete zero-lever detector. Only actual render epochs advance this cell. */
export function createEnvironmentDetector(profile: EnvironmentProfile) {
  const diagnostics: Diagnostic[] = [], packets: PacketRecord[] = []
  let lastAt: number | null = null, cell: number | null = null
  let pending: { record: PacketRecord, counts: number } | null = null
  let retired = false, renderAttempts = 0, lastRenderAttemptAtMs: number | null = null
  return {
    diagnostics, packets,
    snapshot() { return { renderAttempts, lastRenderAttemptAtMs, lastRenderedAtMs: lastAt, pending: pending !== null, retired } },
    render(state: { positionM: unknown, velocityMps: unknown, motorsN: unknown }, atMs: number) {
      renderAttempts++; lastRenderAttemptAtMs = atMs
      if (retired || !Number.isSafeInteger(atMs) || atMs < 600 || atMs > 100000 || (lastAt === null ? atMs !== 600 : atMs !== lastAt + 20)) throw new Error('instrument-clock')
      let scheduled: PacketRecord | null = null
      if (atMs % 100 === 0) {
        if (packets.length >= 1001) throw new Error('resource-limit')
        scheduled = { sequence: packets.length + 1, capturedAtMs: atMs, dueAtMs: atMs + 60, packet: null, disposition: 'unreceived-on-retirement', admission: null, reason: 'retired-without-receipt' }
        packets.push(scheduled)
      }
      let positionM: V3, velocityMps: V3, plantMotorsN: Diagnostic['plantMotorsN']
      try {
        positionM = vector(state.positionM); velocityMps = vector(state.velocityMps)
        plantMotorsN = denseArray(state.motorsN, 4, 4).map(n => finite(n, 0, 10)) as Diagnostic['plantMotorsN']
      }
      catch { throw new Error('model-envelope') }
      if (Math.abs(positionM[0]) > 12 || Math.abs(positionM[1]) > 12 || positionM[2] < -5 || positionM[2] > 0 || Math.hypot(...velocityMps) > 3) throw new Error('model-envelope')
      const fieldU = environmentField(positionM, atMs)
      if (!Number.isFinite(fieldU) || fieldU < 0 || fieldU > 100) throw new Error('model-envelope')
      cell = cell === null ? fieldU : stepEnvironmentCell(cell, fieldU)
      if (diagnostics.length >= 5001) throw new Error('resource-limit')
      diagnostics.push({ atMs, positionM, velocityMps, fieldU, cellU: cell, plantMotorsN }); lastAt = atMs
      if (scheduled) {
        if (profile === 'sensor-loss' && atMs >= 5000) { scheduled.disposition = 'suppressed'; scheduled.reason = 'profile-suppression' }
        else {
          if (pending) throw new Error('resource-limit')
          pending = { record: scheduled, counts: Math.round(911 + 103 * cell) }
        }
      }
    },
    receive(atMs: number): PacketRecord | null {
      const due = packets.find(record => record.dueAtMs === atMs)
      if (!due) return null
      if (!pending || pending.record !== due) return due
      const p = pending; pending = null
      due.packet = { version: 1, sourceId: 'environment-detector-1', sessionId: 'environment-fixture-v1', sequence: due.sequence, capturedAtMs: due.capturedAtMs, receivedAtMs: atMs, counts: p.counts, clockDomain: 'fixture-monotonic-ms', clockUncertaintyMs: 1 }
      due.disposition = 'delivered'
      return due
    },
    close() {
      if (retired) return unavailable()
      retired = true; pending = null
      return packets.filter(record => record.disposition === 'unreceived-on-retirement').length
    },
  }
}
