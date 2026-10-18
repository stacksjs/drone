import type { SensorCalibrationSet, SensorClockAnchor } from './types'
import { validateSensorCalibrations } from './calibration'
import { createSensorPipeline, validateSensorAnchor } from './pipeline'
export const maxSensorDatasetBytes = 1048576
type RecordedAnchor = Omit<SensorClockAnchor, 'bootId' | 'boardUs'> & { bootId: string, boardUs: string }
export interface SensorDataset {
  version: 1
  evidence: 'synthetic-register-fixture' | 'bench-capture'
  provenance: string
  anchor: RecordedAnchor
  anchors?: { receivedAtMs: number, anchor: RecordedAnchor }[]
  calibrations: SensorCalibrationSet
  records: { receivedAtMs: number, hex: string }[]
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function restoreAnchor(input: unknown, source: string): SensorClockAnchor {
  if (!record(input) || typeof input.bootId !== 'string' || !/^\d{1,20}$/.test(input.bootId) || typeof input.boardUs !== 'string' || !/^\d{1,20}$/.test(input.boardUs)
    || input.source !== source) throw new TypeError('Dataset evidence and clock source disagree')
  return validateSensorAnchor({ ...input, bootId: BigInt(input.bootId), boardUs: BigInt(input.boardUs) } as SensorClockAnchor)
}
export function parseSensorDataset(input: unknown): SensorDataset {
  if (!record(input) || input.version !== 1 || !['synthetic-register-fixture', 'bench-capture'].includes(String(input.evidence))
    || typeof input.provenance !== 'string' || input.provenance.length > 1024 || !record(input.anchor) || !record(input.calibrations)
    || !Array.isArray(input.records) || input.records.length < 1 || input.records.length > 4096) throw new TypeError('Invalid bounded sensor dataset')
  const anchor = restoreAnchor(input.anchor, input.evidence === 'synthetic-register-fixture' ? 'fixture' : 'handshake')
  const calibrations = validateSensorCalibrations(input.calibrations as unknown as SensorCalibrationSet)
  const dataset = structuredClone({ ...input, calibrations }) as unknown as SensorDataset
  // Validate the actual clock and calibration contracts before allocating replay state.
  const validation = createSensorPipeline({ anchor, calibrations })
  if (dataset.anchors !== undefined) {
    if (!Array.isArray(dataset.anchors) || dataset.anchors.length > 4096) throw new TypeError('Invalid bounded clock refresh records')
    let previousAnchor = anchor.localMs
    for (const item of dataset.anchors) {
      if (!record(item) || !Number.isFinite(item.receivedAtMs) || item.receivedAtMs < previousAnchor || item.receivedAtMs - anchor.localMs > 600000) throw new TypeError('Clock refresh receipts must be bounded and ordered')
      validation.reanchor(restoreAnchor(item.anchor, anchor.source), item.receivedAtMs)
      previousAnchor = item.receivedAtMs
    }
  }
  let previous = dataset.anchor.localMs
  for (const item of dataset.records) {
    if (!record(item) || typeof item.receivedAtMs !== 'number' || !Number.isFinite(item.receivedAtMs) || item.receivedAtMs < previous
      || item.receivedAtMs - dataset.anchor.localMs > 600000 || typeof item.hex !== 'string' || !/^[a-f\d]{256}$/i.test(item.hex)) throw new TypeError('Dataset records must be bounded, ordered and fixed-length')
    previous = item.receivedAtMs
  }
  return dataset
}
export function createSensorReplay(input: unknown) {
  const dataset = parseSensorDataset(input)
  const offsetMs = dataset.anchor.localMs
  const pipeline = createSensorPipeline({ anchor: { ...dataset.anchor, localMs: 0, bootId: BigInt(dataset.anchor.bootId), boardUs: BigInt(dataset.anchor.boardUs) }, calibrations: dataset.calibrations })
  let cursor = 0, anchorCursor = 0, now = 0, accepted = 0
  function snapshot() { return { ...pipeline.snapshot(now), evidence: dataset.evidence, nowMs: now, consumed: cursor, accepted, total: dataset.records.length } }
  return {
    snapshot,
    advanceTo(nowMs: number) {
      if (!Number.isFinite(nowMs) || nowMs < now) throw new RangeError('Replay clock must advance monotonically')
      while (true) {
        const item = dataset.records[cursor], refresh = dataset.anchors?.[anchorCursor]
        const recordAt = item ? item.receivedAtMs - offsetMs : Infinity
        const anchorAt = refresh ? refresh.receivedAtMs - offsetMs : Infinity
        if (Math.min(recordAt, anchorAt) > nowMs) break
        if (refresh && anchorAt <= recordAt) {
          const next = restoreAnchor(refresh.anchor, dataset.anchor.source)
          pipeline.reanchor({ ...next, localMs: next.localMs - offsetMs }, anchorAt); anchorCursor++
        }
        else if (item) {
          if (pipeline.ingest(Uint8Array.fromHex(item.hex), recordAt).accepted) accepted++
          cursor++
        }
      }
      now = nowMs
      return snapshot()
    },
  }
}
export type SensorReplay = ReturnType<typeof createSensorReplay>
