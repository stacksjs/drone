import type { SurfaceMetadata } from '../../../resources/functions/drone/volumes/types'
// Literal binary worksheet, independently encoded from ASPRS LAS1.2 tables.
// Five selected samples mean north-first cells3,6,9; one missing cell stays unknown.
export const primaryLasSha256 = '17efc5a7cfe3a40ea8ba8ddb10a1d5330e5621b95866fc3df47eb1c69a24f702'
const hex = '4c415346000000000000000000000000000000000000000001020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e30039010000010000000014000800000007000000010000000000000000000000000000007b14ae47e17a843f7b14ae47e17a843f7b14ae47e17a843f0000000080841e4100000000d0474f4100000000000000000000000088841e410000000081841e41000000e0d0474f4100000020d0474f410000000000005940000000000000004000004c4153465f50726f6a656374696f6e00af872000000000000000000000000000000000000000000000000000000000000000000001000100000003000004000001000100000c000001006a7f040c000001002923190000007d000000c800000000000901000000004b000000af0000009001000000001201000000007d0000007d00000058020000000009010000000019000000190000002003000000000901000000004b0000004b000000e80300000000090100000000af000000190000001027000000000981000000007d0000004b000000ac2600000000090700000000c800000064000000f40100000000090100000000'
export function primaryLasBytes(): Uint8Array { return Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16)) }
export function primaryLasDeclaration(): string {
  const metadata: SurfaceMetadata = {
    version: 1, id: 'synthetic-las-cell-means',
    reference: { horizontalCrs: { kind: 'wgs84-utm', id: 'EPSG:32618', definition: 'Synthetic metre UTM coordinate worksheet', coordinateEpoch: null }, axes: 'EAST_NORTH', horizontalUnit: 'metre', verticalDatum: { kind: 'engineering', id: 'synthetic-zero', definition: 'Declared synthetic zero plane; not a surveyed vertical datum' }, verticalUnit: 'metre', elevationPositive: 'up' },
    provenance: { evidence: 'synthetic', sourceKind: 'analytic', sourceSha256: primaryLasSha256, acquisition: { status: 'synthetic', sourceId: 'independent-eight-point-worksheet' }, reconstructionOrMeshing: { status: 'unknown', sourceId: null }, boresightCalibration: { status: 'not-applicable', reportId: null }, timeCalibration: { status: 'not-applicable', reportId: null }, groundClassification: { status: 'unknown', description: 'Explicit class1 selection; labels do not verify classification or identify a stockpile surface', reportId: null }, georeferencing: { verticalBoundM: null, horizontalBoundM: null, reportId: null } },
  }
  return JSON.stringify({ version: 1, profile: 'las12-utm-mean-grid-v1', verticalReference: 'declared-sidecar', metadata,
    selection: { classes: [1], returns: 'all', synthetic: 'exclude' },
    grid: { westM: 500000, southM: 4100000, width: 2, height: 2, cellSizeM: 1, minimumPoints: 1, maximumSpreadM: 5 } })
}
export function primaryLasMeasurement() {
  return { version: 1, id: 'synthetic-las-volume', boundary: { outer: [[500000,4100000],[500002,4100000],[500002,4100002],[500000,4100002]], holes: [] }, base: { kind: 'plane', anchorM: [500000,4100000,0], gradientEast: 0, gradientNorth: 0, assumption: 'Explicit synthetic zero base, not fitted to point elevations', evidence: 'synthetic', verticalBoundM: null }, reference: null }
}

// Literal table extensions for the three optional GPS/RGB record layouts.
export function primaryLasRecordFormat(format: 0 | 1 | 2 | 3, encoding: 0 | 1 = 0): Uint8Array {
  const original = primaryLasBytes(), length = [20, 28, 26, 34][format]!
  const bytes = new Uint8Array(313 + 8 * length); bytes.set(original.subarray(0, 313))
  const v = new DataView(bytes.buffer); v.setUint16(6, encoding, true); v.setUint8(104, format); v.setUint16(105, length, true)
  for (let i = 0; i < 8; i++) {
    bytes.set(original.subarray(313 + 20 * i, 333 + 20 * i), 313 + i * length)
    if (format === 1 || format === 3) v.setFloat64(333 + i * length, encoding ? -20 + i : 100 + i, true)
    if (format === 2 || format === 3) for (let color = 0; color < 3; color++) v.setUint16(313 + i * length + (format === 2 ? 20 : 28) + 2 * color, 1234, true)
  }
  return bytes
}

// Extend only the literal GeoKey table; the independently encoded points stay exact.
export function primaryLasVerticalCrs(code: number, explicitMetreUnit: boolean): Uint8Array {
  const original = primaryLasBytes(), extra = explicitMetreUnit ? 16 : 8
  const bytes = new Uint8Array(original.length + extra)
  bytes.set(original.subarray(0, 313)); bytes.set(original.subarray(313), 313 + extra)
  const v = new DataView(bytes.buffer)
  v.setUint32(96, 313 + extra, true); v.setUint16(247, 32 + extra, true); v.setUint16(287, explicitMetreUnit ? 5 : 4, true)
  v.setUint16(313, 4096, true); v.setUint16(317, 1, true); v.setUint16(319, code, true)
  if (explicitMetreUnit) { v.setUint16(321, 4099, true); v.setUint16(325, 1, true); v.setUint16(327, 9001, true) }
  return bytes
}
