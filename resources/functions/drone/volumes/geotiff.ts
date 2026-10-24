import { captureSurfaceBytes, SurfaceByteRejection } from './bytes'
import type { SurfaceGeometry, SurfaceMetadata } from './types'
import { validateKnownSurface, validateSurfaceMetadata } from './validation'

export interface GeoTiffElevationDeclaration {
  version: 1
  profile: 'classic-le-f32-utm-area-v1'
  sampleMeaning: 'cell-elevation-metres-up'
  interpretation: 'piecewise-constant-cell-elevation'
  metadata: SurfaceMetadata
}
export interface GeoTiffCellSurface {
  version: 1
  metadata: SurfaceMetadata
  geometry: Extract<SurfaceGeometry, { kind: 'cell-grid' }>
}

type FailureKind = 'input' | 'budget' | 'digest' | 'unavailable'
class Rejection extends Error {
  constructor(readonly kind: FailureKind) { super(kind) }
}
function reject(kind: FailureKind = 'input'): never { throw new Rejection(kind) }

// Called only on JSON.parse-owned data, never an arbitrary caller object graph.
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return reject()
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return reject()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return reject()
    result[key] = descriptor.value
  }
  return result
}

function declaration(input: string): SurfaceMetadata {
  if (typeof input !== 'string') return reject()
  if (input.length > 32768) return reject('budget')
  if (typeof TextEncoder !== 'function') return reject('unavailable')
  if (new TextEncoder().encode(input).length > 32768) return reject('budget')
  let parsed: unknown
  try { parsed = JSON.parse(input) }
  catch (error) {
    if (error instanceof SyntaxError) return reject()
    throw error
  }
  const d = closed(parsed, ['version', 'profile', 'sampleMeaning', 'interpretation', 'metadata'])
  if (d.version !== 1 || d.profile !== 'classic-le-f32-utm-area-v1' || d.sampleMeaning !== 'cell-elevation-metres-up' || d.interpretation !== 'piecewise-constant-cell-elevation') return reject()
  const m = closed(d.metadata, ['version', 'id', 'reference', 'provenance'])
  const reference = closed(m.reference, ['horizontalCrs', 'axes', 'horizontalUnit', 'verticalDatum', 'verticalUnit', 'elevationPositive'])
  closed(reference.horizontalCrs, ['kind', 'id', 'definition', 'coordinateEpoch'])
  closed(reference.verticalDatum, ['kind', 'id', 'definition'])
  const provenance = closed(m.provenance, ['evidence', 'sourceKind', 'sourceSha256', 'acquisition', 'reconstructionOrMeshing', 'boresightCalibration', 'timeCalibration', 'groundClassification', 'georeferencing'])
  for (const key of ['acquisition', 'reconstructionOrMeshing']) closed(provenance[key], ['status', 'sourceId'])
  for (const key of ['boresightCalibration', 'timeCalibration']) closed(provenance[key], ['status', 'reportId'])
  closed(provenance.groundClassification, ['status', 'description', 'reportId'])
  closed(provenance.georeferencing, ['verticalBoundM', 'horizontalBoundM', 'reportId'])
  let metadata: SurfaceMetadata
  try { metadata = validateSurfaceMetadata(m) }
  catch (error) {
    if (error instanceof Error && error.message.startsWith('Volume input: ')) return reject()
    throw error
  }
  if (metadata.reference.horizontalCrs.kind !== 'wgs84-utm') return reject()
  return metadata
}

interface Span { start: number, end: number }
interface Field { type: number, count: number, at: number }
interface Raster { width: number, height: number, westM: number, southM: number, cellSizeM: number, stripAt: number, nodata: number | null }
const requiredTags: readonly number[] = [256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 282, 283, 284, 296, 317, 339, 33550, 33922, 34735]

function fieldSize(tag: number, type: number, count: number): number {
  if ([256, 257, 273, 278, 279].includes(tag)) {
    if (type !== 4 || count !== 1) return reject()
    return 4
  }
  if ([258, 259, 262, 274, 277, 284, 296, 317, 339].includes(tag)) {
    if (type !== 3 || count !== 1) return reject()
    return 2
  }
  if (tag === 282 || tag === 283) {
    if (type !== 5 || count !== 1) return reject()
    return 8
  }
  if (tag === 33550 || tag === 33922) {
    if (type !== 12 || count !== (tag === 33550 ? 3 : 6)) return reject()
    return count * 8
  }
  if (tag === 34735) {
    if (type !== 3) return reject()
    if (count > 68) return reject('budget')
    if (count !== 16 && count !== 20) return reject()
    return count * 2
  }
  if (tag === 42113) {
    if (type !== 2 || count < 2 || count > 65) return reject()
    return count
  }
  return reject()
}

function regions(owned: Uint8Array<ArrayBuffer>, spans: Span[]): void {
  spans.sort((a, b) => a.start - b.start)
  let through = 0
  for (const span of spans) {
    if (span.start < through) return reject()
    for (let at = through; at < span.start; at++) if (owned[at] !== 0) return reject()
    through = span.end
  }
  // Exact EOF is allowed. An odd last payload may additionally have one zero pad byte.
  if (through !== owned.length && (through % 2 !== 1 || owned.length !== through + 1 || owned[through] !== 0)) return reject()
}

function nodataValue(view: DataView, field: Field | undefined): number | null {
  if (!field) return null
  if (view.getUint8(field.at + field.count - 1) !== 0) return reject()
  let token = ''
  for (let at = field.at; at < field.at + field.count - 1; at++) {
    const byte = view.getUint8(at)
    if (byte === 0 || byte > 127) return reject()
    token += String.fromCharCode(byte)
  }
  const match = /^([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?)([0-9]{1,3}))?$/.exec(token)
  if (!match) return reject()
  const exponent = match[6] ? Number((match[5] ?? '') + match[6]) : 0
  if (exponent < -200 || exponent > 200) return reject()
  const fraction = match[3] ?? match[4] ?? ''
  const digits = (match[2] ?? '') + fraction
  const coefficient = BigInt(digits) * (match[1] === '-' ? -1n : 1n)
  const decimalExponent = exponent - fraction.length
  const decimalNumerator = coefficient * (decimalExponent >= 0 ? 10n ** BigInt(decimalExponent) : 1n)
  const decimalDenominator = decimalExponent < 0 ? 10n ** BigInt(-decimalExponent) : 1n
  const value = Math.fround(Number(token))
  if (!Number.isFinite(value)) return reject()
  const bitsView = new DataView(new ArrayBuffer(4))
  bitsView.setFloat32(0, value, true)
  const word = bitsView.getUint32(0, true), binaryExponent = (word >>> 23) & 255
  const significand = (word & 0x7fffff) + (binaryExponent === 0 ? 0 : 0x800000)
  const power = binaryExponent === 0 ? -149 : binaryExponent - 150
  const signedSignificand = BigInt(significand) * ((word & 0x80000000) === 0 ? 1n : -1n)
  const binaryNumerator = signedSignificand * (power >= 0 ? 2n ** BigInt(power) : 1n)
  const binaryDenominator = power < 0 ? 2n ** BigInt(-power) : 1n
  if (decimalNumerator * binaryDenominator !== binaryNumerator * decimalDenominator) return reject()
  return value
}

function raster(owned: Uint8Array<ArrayBuffer>, metadata: SurfaceMetadata): Raster {
  const view = new DataView(owned.buffer), spans: Span[] = [{ start: 0, end: 8 }]
  function span(start: number, size: number): void {
    if (!Number.isSafeInteger(start) || start < 8 || start % 2 !== 0 || !Number.isSafeInteger(size) || size < 1 || size > owned.length || start > owned.length - size) return reject()
    spans.push({ start, end: start + size })
  }
  if (view.getUint16(0, true) !== 0x4949 || view.getUint16(2, true) !== 42) return reject()
  const ifd = view.getUint32(4, true)
  // Check two count bytes before reading them, then retain only the complete IFD span.
  span(ifd, 2)
  spans.pop()
  const count = view.getUint16(ifd, true)
  if (count > 32) return reject('budget')
  if (count !== 19 && count !== 20) return reject()
  span(ifd, 2 + count * 12 + 4)
  if (view.getUint32(ifd + 2 + count * 12, true) !== 0) return reject()
  const fields = new Map<number, Field>()
  let previous = -1
  for (let index = 0; index < count; index++) {
    const at = ifd + 2 + index * 12, tag = view.getUint16(at, true), type = view.getUint16(at + 2, true), values = view.getUint32(at + 4, true)
    if (tag <= previous || !requiredTags.includes(tag) && tag !== 42113) return reject()
    previous = tag
    const size = fieldSize(tag, type, values)
    let dataAt = at + 8
    if (size > 4) { dataAt = view.getUint32(at + 8, true); span(dataAt, size) }
    else for (let pad = size; pad < 4; pad++) if (view.getUint8(dataAt + pad) !== 0) return reject()
    fields.set(tag, { type, count: values, at: dataAt })
  }
  for (const tag of requiredTags) if (!fields.has(tag)) return reject()
  function field(tag: number): Field { const result = fields.get(tag); return result ?? reject() }
  function scalar(tag: number): number {
    const value = field(tag)
    if (value.type === 3) return view.getUint16(value.at, true)
    if (value.type === 4) return view.getUint32(value.at, true)
    return reject('unavailable')
  }
  const width = scalar(256), height = scalar(257)
  if (width < 1 || height < 1) return reject()
  if (width > 32768 || height > 32768 || width * height > 32768) return reject('budget')
  if (scalar(258) !== 32 || scalar(259) !== 1 || scalar(262) !== 1 || scalar(274) !== 1 || scalar(277) !== 1 || scalar(278) !== height || scalar(279) !== width * height * 4 || scalar(284) !== 1 || scalar(317) !== 1 || scalar(339) !== 3 || ![1, 2, 3].includes(scalar(296))) return reject()
  const stripAt = scalar(273)
  span(stripAt, width * height * 4)
  regions(owned, spans)

  for (const tag of [282, 283]) {
    const at = field(tag).at
    if (view.getUint32(at, true) === 0 || view.getUint32(at + 4, true) === 0) return reject()
  }
  const keys = field(34735), at = keys.at, keyCount = view.getUint16(at + 6, true)
  if (keyCount > 16) return reject('budget')
  if (view.getUint16(at, true) !== 1 || view.getUint16(at + 2, true) !== 1 || ![0, 1].includes(view.getUint16(at + 4, true)) || keyCount !== 3 && keyCount !== 4 || keys.count !== 4 + keyCount * 4) return reject()
  const expectedCrs = Number(metadata.reference.horizontalCrs.id.slice(5))
  let previousKey = -1, model = false, area = false, crs = false
  for (let index = 0; index < keyCount; index++) {
    const here = at + 8 + index * 8, key = view.getUint16(here, true), value = view.getUint16(here + 6, true)
    if (key <= previousKey || view.getUint16(here + 2, true) !== 0 || view.getUint16(here + 4, true) !== 1) return reject()
    previousKey = key
    if (key === 1024 && value === 1) model = true
    else if (key === 1025 && value === 1) area = true
    else if (key === 3072 && value === expectedCrs) crs = true
    else if (key !== 3076 || value !== 9001) return reject()
  }
  if (!model || !area || !crs) return reject()
  const scaleAt = field(33550).at, tieAt = field(33922).at
  const size = view.getFloat64(scaleAt, true), westM = view.getFloat64(tieAt + 24, true), northM = view.getFloat64(tieAt + 32, true)
  if (!Number.isFinite(size) || size < 1e-5 || size > 1e6 || view.getFloat64(scaleAt + 8, true) !== size || view.getFloat64(scaleAt + 16, true) !== 0 || view.getFloat64(tieAt, true) !== 0 || view.getFloat64(tieAt + 8, true) !== 0 || view.getFloat64(tieAt + 16, true) !== 0 || view.getFloat64(tieAt + 40, true) !== 0) return reject()
  const southM = northM - height * size, eastM = westM + width * size
  if (![westM, northM, southM, eastM, southM + height * size].every(value => Number.isFinite(value) && Math.abs(value) <= 1e8)) return reject()
  const nodata = nodataValue(view, fields.get(42113))
  let hasSurface = false
  for (let index = 0; index < width * height; index++) {
    const value = view.getFloat32(stripAt + index * 4, true)
    if (!Number.isFinite(value)) return reject()
    // Numeric equality intentionally makes either zero sentinel match both zero signs.
    if (nodata !== null && value === nodata) continue
    if (Math.abs(value) > 1e8) return reject()
    hasSurface = true
  }
  if (!hasSurface) return reject()
  return { width, height, westM, southM, cellSizeM: size, stripAt, nodata }
}

/** Restrictive numeric elevation profile, without acquisition or accuracy authentication. */
export async function importGeoTiffSurface(bytes: Uint8Array, declarationJson: string): Promise<GeoTiffCellSurface> {
  try {
    const owned = captureSurfaceBytes(bytes), metadata = declaration(declarationJson), grid = raster(owned, metadata)
    const subtle = globalThis.crypto?.subtle
    if (!subtle || typeof subtle.digest !== 'function') return reject('unavailable')
    const digest = new Uint8Array(await subtle.digest('SHA-256', owned))
    if (digest.length !== 32) return reject('unavailable')
    let hex = ''
    for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
    if (hex !== metadata.provenance.sourceSha256) return reject('digest')
    const view = new DataView(owned.buffer), rows: (number | null)[][] = []
    for (let row = 0; row < grid.height; row++) {
      const cells: (number | null)[] = []
      for (let column = 0; column < grid.width; column++) {
        const value = view.getFloat32(grid.stripAt + (row * grid.width + column) * 4, true)
        cells.push(grid.nodata !== null && value === grid.nodata ? null : value)
      }
      rows.push(cells)
    }
    const surface = validateKnownSurface({ version: 1, metadata, geometry: { kind: 'cell-grid', width: grid.width, height: grid.height, westM: grid.westM, southM: grid.southM, cellSizeM: grid.cellSizeM, rows, rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' } })
    if (surface.geometry.kind !== 'cell-grid') return reject('unavailable')
    return { version: 1, metadata: surface.metadata, geometry: surface.geometry }
  }
  catch (error) {
    if (error instanceof Rejection || error instanceof SurfaceByteRejection) {
      if (error.kind === 'input') throw new TypeError('geotiff-surface-input')
      if (error.kind === 'budget') throw new RangeError('geotiff-surface-budget')
      if (error.kind === 'digest') throw new Error('geotiff-source-sha256-mismatch')
    }
    throw new Error('geotiff-surface-unavailable')
  }
}
