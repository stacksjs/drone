import type { SurfaceMetadata, SurfaceGeometry } from './types'
import { captureSurfaceBytes, SurfaceByteRejection } from './bytes'
import { validateKnownSurface, validateSurfaceMetadata, volumeLimits } from './validation'

export interface LasGridDeclaration {
  version: 1
  profile: 'las12-utm-mean-grid-v1'
  verticalReference: 'declared-sidecar'
  metadata: SurfaceMetadata
  selection: { classes: number[], returns: 'all' | 'first' | 'last', synthetic: 'exclude' | 'include' }
  grid: { westM: number, southM: number, width: number, height: number, cellSizeM: number, minimumPoints: number, maximumSpreadM: number }
}
// LAS profile admission only: these EPSG vertical CRSs have metre/up axes.
// PROJ 5fa31c29f0a806568ed7bc76c1a557604db4a804, vertical_crs.sql + axis.sql.
const metreUpVerticalCrs = new Set([3855, 5701, 5703, 5714, 5773, 5783])

class Rejection extends Error {
  constructor(readonly kind: 'input' | 'budget' | 'digest' | 'unavailable' | 'empty' = 'input') { super(kind) }
}
function reject(kind: Rejection['kind'] = 'input'): never { throw new Rejection(kind) }
const finite = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && finite(value, min, max)
function closed(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) return reject()
  return input as Record<string, unknown>
}
function declaration(text: string): LasGridDeclaration {
  if (typeof text !== 'string') return reject()
  if (text.length > 32768 || new TextEncoder().encode(text).length > 32768) return reject('budget')
  const d = closed(JSON.parse(text), ['version', 'profile', 'verticalReference', 'metadata', 'selection', 'grid'])
  if (d.version !== 1 || d.profile !== 'las12-utm-mean-grid-v1' || d.verticalReference !== 'declared-sidecar') return reject()
  let metadata: SurfaceMetadata
  try { metadata = validateSurfaceMetadata(d.metadata) }
  catch { return reject() }
  const selection = closed(d.selection, ['classes', 'returns', 'synthetic']), grid = closed(d.grid, ['westM', 'southM', 'width', 'height', 'cellSizeM', 'minimumPoints', 'maximumSpreadM'])
  if (metadata.reference.horizontalCrs.kind !== 'wgs84-utm' || metadata.provenance.sourceKind !== 'lidar' && metadata.provenance.sourceKind !== 'analytic') return reject()
  if (!Array.isArray(selection.classes) || selection.classes.length < 1 || selection.classes.length > 32 || selection.classes.some((n, i, values) => !integer(n, 0, 31) || i > 0 && n <= values[i - 1])
    || !['all', 'first', 'last'].includes(selection.returns as string) || !['exclude', 'include'].includes(selection.synthetic as string)) return reject()
  if (!finite(grid.westM, -1e8, 1e8) || !finite(grid.southM, -1e8, 1e8) || !integer(grid.width, 1, volumeLimits.gridCells) || !integer(grid.height, 1, volumeLimits.gridCells)
    || grid.width * grid.height > volumeLimits.gridCells || !finite(grid.cellSizeM, 1e-5, 1e6) || !integer(grid.minimumPoints, 1, 200000) || !finite(grid.maximumSpreadM, 0, 1e8)
    || !finite(grid.westM + grid.width * grid.cellSizeM, -1e8, 1e8) || !finite(grid.southM + grid.height * grid.cellSizeM, -1e8, 1e8)) return reject()
  return { version: 1, profile: 'las12-utm-mean-grid-v1', verticalReference: 'declared-sidecar', metadata, selection: selection as unknown as LasGridDeclaration['selection'], grid: grid as unknown as LasGridDeclaration['grid'] }
}
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(result, n => n.toString(16).padStart(2, '0')).join('')
}
function projection(view: DataView, d: LasGridDeclaration): { end: number, verticalCrs: number | null } {
  // This explicit profile permits one inline GeoKey directory and no hidden
  // transform, custom CRS, waveform, extra-byte or compressed-payload metadata.
  if (view.getUint16(94, true) !== 227 || view.getUint32(100, true) !== 1) return reject()
  const start = 227, size = view.getUint16(start + 20, true), end = start + 54 + size
  if (end > view.byteLength || size < 32 || view.getUint16(start, true) !== 0 || view.getUint16(start + 18, true) !== 34735) return reject()
  const id = 'LASF_Projection'
  for (let i = 0; i < 16; i++) if (view.getUint8(start + 2 + i) !== (i < id.length ? id.charCodeAt(i) : 0)) return reject()
  const at = start + 54, count = view.getUint16(at + 6, true)
  if (count < 3 || count > 8 || size !== 8 + count * 8 || view.getUint16(at, true) !== 1 || view.getUint16(at + 2, true) !== 1 || ![0, 1].includes(view.getUint16(at + 4, true))) return reject()
  const values = new Map<number, number>()
  for (let i = 0; i < count; i++) {
    const here = at + 8 + 8 * i, key = view.getUint16(here, true), value = view.getUint16(here + 6, true)
    if (values.has(key) || view.getUint16(here + 2, true) !== 0 || view.getUint16(here + 4, true) !== 1 || ![1024, 1025, 2048, 2054, 3072, 3076, 4096, 4099].includes(key)) return reject()
    values.set(key, value)
  }
  if (values.get(1024) !== 1 || values.get(3072) !== Number(d.metadata.reference.horizontalCrs.id.slice(5)) || values.get(3076) !== 9001) return reject()
  for (const [key, expected] of [[1025, 2], [2048, 4326], [2054, 9102], [4099, 9001]]) if (values.has(key!) && values.get(key!) !== expected) return reject()
  const verticalCrs = values.get(4096) ?? null
  if (verticalCrs !== null && (!metreUpVerticalCrs.has(verticalCrs) || d.metadata.reference.verticalDatum.id !== 'EPSG:' + verticalCrs)) return reject()
  return { end, verticalCrs }
}

/** Original point bytes to an explicitly declared cell-mean representation. No survey acquisition or implicit meshing. */
export async function importLasSurface(input: Uint8Array, declarationJson: string) {
  try {
    const bytes = captureSurfaceBytes(input), d = declaration(declarationJson), v = new DataView(bytes.buffer)
    if (bytes.length < 313 || v.getUint32(0, false) !== 0x4c415346 || v.getUint8(24) !== 1 || v.getUint8(25) !== 2 || v.getUint16(6, true) > 1) return reject()
    const format = v.getUint8(104), recordBytes = [20, 28, 26, 34][format], count = v.getUint32(107, true), offset = v.getUint32(96, true)
    if (recordBytes === undefined || v.getUint16(105, true) !== recordBytes || !count) return reject()
    if (count > 200000) return reject('budget')
    const { end, verticalCrs } = projection(v, d)
    if (offset < end || offset + count * recordBytes !== bytes.length) return reject()
    for (let i = end; i < offset; i++) if (bytes[i] !== 0) return reject()
    const scales = [0, 1, 2].map(i => v.getFloat64(131 + 8 * i, true)), offsets = [0, 1, 2].map(i => v.getFloat64(155 + 8 * i, true))
    if (scales.some(n => !finite(n, Number.MIN_VALUE, 1e6)) || offsets.some(n => !finite(n, -1e8, 1e8))) return reject()
    const sourceSha256 = await digest(bytes), declarationSha256 = await digest(new TextEncoder().encode(declarationJson))
    if (sourceSha256 !== d.metadata.provenance.sourceSha256) return reject('digest')
    const grid = d.grid, cells = grid.width * grid.height, counts = new Uint32Array(cells), sums = new Float64Array(cells), corrections = new Float64Array(cells), mins = new Float64Array(cells).fill(Infinity), maxs = new Float64Array(cells).fill(-Infinity)
    const sourceMins = [Infinity, Infinity, Infinity], sourceMaxs = [-Infinity, -Infinity, -Infinity], byReturn = [0, 0, 0, 0, 0], byClass = new Array<number>(32).fill(0)
    const excluded = { withheld: 0, synthetic: 0, classification: 0, returns: 0, outsideGrid: 0 }
    const hasGps = format === 1 || format === 3, gpsType = hasGps ? v.getUint16(6, true) ? 'adjusted-standard-seconds' : 'week-seconds' : 'absent'
    let selected = 0, gpsMin = Infinity, gpsMax = -Infinity
    for (let i = 0; i < count; i++) {
      const at = offset + i * recordBytes, xyz = [0, 1, 2].map(axis => v.getInt32(at + axis * 4, true) * scales[axis]! + offsets[axis]!)
      if (xyz.some(n => !finite(n, -1e8, 1e8))) return reject()
      for (let axis = 0; axis < 3; axis++) { sourceMins[axis] = Math.min(sourceMins[axis]!, xyz[axis]!); sourceMaxs[axis] = Math.max(sourceMaxs[axis]!, xyz[axis]!) }
      const returns = v.getUint8(at + 14), returned = returns & 7, totalReturns = (returns >> 3) & 7, classification = v.getUint8(at + 15), classId = classification & 31
      if (returned < 1 || returned > totalReturns || totalReturns > 5 || Math.abs(v.getInt8(at + 16)) > 90) return reject()
      byReturn[returned - 1] = byReturn[returned - 1]! + 1; byClass[classId] = byClass[classId]! + 1
      if (hasGps) {
        const time = v.getFloat64(at + 20, true)
        if (!finite(time, gpsType === 'week-seconds' ? 0 : -1e9, gpsType === 'week-seconds' ? 604800 : 1e10) || gpsType === 'week-seconds' && time === 604800) return reject()
        gpsMin = Math.min(gpsMin, time); gpsMax = Math.max(gpsMax, time)
      }
      if (classification & 128) { excluded.withheld++; continue }
      if (classification & 32 && d.selection.synthetic === 'exclude') { excluded.synthetic++; continue }
      if (!d.selection.classes.includes(classId)) { excluded.classification++; continue }
      if (d.selection.returns === 'first' && returned !== 1 || d.selection.returns === 'last' && returned !== totalReturns) { excluded.returns++; continue }
      const column = Math.floor((xyz[0]! - grid.westM) / grid.cellSizeM), southRow = Math.floor((xyz[1]! - grid.southM) / grid.cellSizeM)
      if (column < 0 || southRow < 0 || column >= grid.width || southRow >= grid.height) { excluded.outsideGrid++; continue }
      const cell = (grid.height - 1 - southRow) * grid.width + column, z = xyz[2]!, adjusted = z - corrections[cell]!, next = sums[cell]! + adjusted
      corrections[cell] = (next - sums[cell]!) - adjusted; sums[cell] = next; counts[cell] = counts[cell]! + 1; mins[cell] = Math.min(mins[cell]!, z); maxs[cell] = Math.max(maxs[cell]!, z); selected++
    }
    for (let i = 0; i < 5; i++) if (byReturn[i] !== v.getUint32(111 + i * 4, true)) return reject()
    for (let axis = 0; axis < 3; axis++) {
      const maximum = v.getFloat64(179 + axis * 16, true), minimum = v.getFloat64(187 + axis * 16, true), tolerance = 8 * Number.EPSILON * Math.max(1, Math.abs(sourceMins[axis]!), Math.abs(sourceMaxs[axis]!))
      if (!finite(maximum, -1e8, 1e8) || !finite(minimum, -1e8, 1e8) || Math.abs(maximum - sourceMaxs[axis]!) > tolerance || Math.abs(minimum - sourceMins[axis]!) > tolerance) return reject()
    }
    const statistics = Array.from(counts, (n, i) => ({ row: Math.floor(i / grid.width), column: i % grid.width, count: n, minimumM: n ? mins[i]! : null, maximumM: n ? maxs[i]! : null, meanM: n ? sums[i]! / n : null,
      reason: n < grid.minimumPoints ? 'insufficient-points' as const : maxs[i]! - mins[i]! > grid.maximumSpreadM ? 'excessive-spread' as const : 'accepted' as const }))
    if (!statistics.some(cell => cell.reason === 'accepted')) return reject('empty')
    const rows = Array.from({ length: grid.height }, (_, row) => statistics.slice(row * grid.width, (row + 1) * grid.width).map(cell => cell.reason === 'accepted' ? cell.meanM : null))
    const surface = validateKnownSurface({ version: 1, metadata: d.metadata, geometry: { kind: 'cell-grid', width: grid.width, height: grid.height, westM: grid.westM, southM: grid.southM, cellSizeM: grid.cellSizeM, rows, rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' } })
    return { surface: { ...surface, geometry: surface.geometry as Extract<SurfaceGeometry, { kind: 'cell-grid' }> }, processing: {
      version: 1, method: 'las12-cell-mean-v1', griddingPerformed: true, supportedAreaEvidence: 'declared-cell-model', pointSamplingCoverageVerified: false, sourceSha256, declarationSha256, format, sourcePointCount: count, selectedPointCount: selected, excluded,
      pointsByReturn: byReturn, pointsByClass: byClass, gps: { type: gpsType, minimum: hasGps ? gpsMin : null, maximum: hasGps ? gpsMax : null }, grid: d.grid, selection: d.selection,
      verticalReference: { mode: 'declared-sidecar', declaredDatumId: d.metadata.reference.verticalDatum.id, embeddedCrs: verticalCrs === null ? null : 'EPSG:' + verticalCrs, unit: 'metre', positive: 'up', coordinateTransformPerformed: false, datumVerified: false },
      coveredCells: statistics.filter(cell => cell.reason === 'accepted').length, representationErrorBoundM: null, physicalAccuracyVerified: false, classificationVerified: false, cells: statistics,
    } }
  }
  catch (error) {
    if (error instanceof Rejection || error instanceof SurfaceByteRejection) {
      if (error.kind === 'input') throw new TypeError('las-surface-input')
      if (error.kind === 'budget') throw new RangeError('las-surface-budget')
      if (error.kind === 'digest') throw new Error('las-source-sha256-mismatch')
      if (error.kind === 'empty') throw new Error('las-surface-no-supported-cells')
    }
    if (error instanceof SyntaxError || error instanceof RangeError) throw new TypeError('las-surface-input')
    throw new Error('las-surface-unavailable')
  }
}
