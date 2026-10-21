import type { SurfaceMetadata, VolumeRequest } from '../../../resources/functions/drone/volumes/types'

// Independent corrected paper worksheet, not a production encoder or parser table.
// The original 352-byte worksheet remains a missing-required-fields negative.
export const primaryGeoTiffSha256 = '0ea4ce0222161867d3acf1923a0fa79c610e5dc1d28590a7d97775485e779b74'
export const primaryGeoTiffAscSha256 = 'e4c6c7bf6c246ede37fe7b4031ce089c61bdb233a8780def78e0a2a359e78b4c'
export const primaryGeoTiffAsc = 'ncols 3\nnrows 2\nxllcorner 500000\nyllcorner 4100000\ncellsize 2\nNODATA_value -9999\n8 -9999 4\n-2 3 6\n'

export function primaryGeoTiffBytes(): Uint8Array {
  const bytes = new Uint8Array(404), view = new DataView(bytes.buffer)
  bytes.set([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0])
  view.setUint16(8, 20, true)
  const entries: [number, number, number, number][] = [
    [256, 4, 1, 3], [257, 4, 1, 2], [258, 3, 1, 32],
    [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 380],
    [274, 3, 1, 1], [277, 3, 1, 1], [278, 4, 1, 2],
    [279, 4, 1, 24], [282, 5, 1, 358], [283, 5, 1, 366],
    [284, 3, 1, 1], [296, 3, 1, 1], [317, 3, 1, 1],
    [339, 3, 1, 3], [33550, 12, 3, 254], [33922, 12, 6, 278],
    [34735, 3, 16, 326], [42113, 2, 6, 374],
  ]
  for (const [index, [tag, type, count, value]] of entries.entries()) {
    const at = 10 + index * 12
    view.setUint16(at, tag, true)
    view.setUint16(at + 2, type, true)
    view.setUint32(at + 4, count, true)
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true)
    else view.setUint32(at + 8, value, true)
  }
  view.setUint32(250, 0, true)
  for (const [index, value] of [2, 2, 0].entries()) view.setFloat64(254 + index * 8, value, true)
  for (const [index, value] of [0, 0, 0, 500000, 4100004, 0].entries()) view.setFloat64(278 + index * 8, value, true)
  for (const [index, value] of [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32611].entries()) view.setUint16(326 + index * 2, value, true)
  view.setUint32(358, 1, true); view.setUint32(362, 1, true)
  view.setUint32(366, 1, true); view.setUint32(370, 1, true)
  bytes.set([0x2d, 0x39, 0x39, 0x39, 0x39, 0], 374)
  // Literal IEEE words, north row first. Expected heights are not encoded through floats.
  for (const [index, word] of [0x41000000, 0xc61c3c00, 0x40800000, 0xc0000000, 0x40400000, 0x40c00000].entries()) view.setUint32(380 + index * 4, word, true)
  return bytes
}

export function primaryGeoTiffMetadata(sourceSha256: string): SurfaceMetadata {
  return {
    version: 1,
    id: 'literal-geotiff-primary',
    reference: {
      horizontalCrs: { kind: 'wgs84-utm', id: 'EPSG:32611', definition: 'WGS84 UTM zone11N', coordinateEpoch: null },
      axes: 'EAST_NORTH',
      horizontalUnit: 'metre',
      verticalDatum: { kind: 'ellipsoidal', id: 'WGS84', definition: 'WGS84 ellipsoidal height' },
      verticalUnit: 'metre',
      elevationPositive: 'up',
    },
    provenance: {
      evidence: 'synthetic', sourceKind: 'analytic', sourceSha256,
      acquisition: { status: 'unknown', sourceId: null },
      reconstructionOrMeshing: { status: 'unknown', sourceId: null },
      boresightCalibration: { status: 'unknown', reportId: null },
      timeCalibration: { status: 'unknown', reportId: null },
      groundClassification: { status: 'unknown', description: 'Synthetic fixture; no ground classification supplied', reportId: null },
      georeferencing: { verticalBoundM: null, horizontalBoundM: null, reportId: null },
    },
  }
}

export function primaryGeoTiffDeclaration(): string {
  return JSON.stringify({
    version: 1,
    profile: 'classic-le-f32-utm-area-v1',
    sampleMeaning: 'cell-elevation-metres-up',
    interpretation: 'piecewise-constant-cell-elevation',
    metadata: primaryGeoTiffMetadata(primaryGeoTiffSha256),
  }, null, 2) + '\n'
}

export function primaryGeoTiffMeasurement(): Pick<VolumeRequest, 'version' | 'id' | 'boundary' | 'base' | 'reference'> {
  return {
    version: 1,
    id: 'literal-geotiff-g0',
    boundary: { outer: [[500000, 4100000], [500006, 4100000], [500006, 4100004], [500000, 4100004]], holes: [] },
    base: { kind: 'plane', anchorM: [500000, 4100000, 0], gradientEast: 0, gradientNorth: 0, assumption: 'Synthetic zero plane, no field basal survey', evidence: 'synthetic', verticalBoundM: null },
    reference: null,
  }
}


// Closed paper worksheets, independently reviewed before any assembly. This is
// test-only literal storage, with no production parser/encoder or caller options.
export type GeoTiffWorksheetName =
  | 'N19' | 'N19-zero' | 'K4' | 'I-zero' | 'I-minus-zero'
  | 'O-exact' | 'O-pad' | 'L-exact' | 'L-integer-control'
  | 'L-rounded-decimal-negative' | 'L-integer-negative'
  | 'S-outside' | 'S-nonmatching-height-negative'

type LiteralIfdRow = readonly [tag: number, type: number, count: number, value: number]

function literalWorksheet(length: number, ifdAt: number, count: 19 | 20, rows: readonly LiteralIfdRow[]) {
  if (rows.length !== count) throw new Error('Literal worksheet row-count mismatch')
  const bytes = new Uint8Array(length), view = new DataView(bytes.buffer)
  view.setUint16(0, 0x4949, true)
  view.setUint16(2, 42, true)
  view.setUint32(4, ifdAt, true)
  view.setUint16(ifdAt, count, true)
  for (const [index, [tag, type, values, value]] of rows.entries()) {
    const at = ifdAt + 2 + index * 12
    view.setUint16(at, tag, true)
    view.setUint16(at + 2, type, true)
    view.setUint32(at + 4, values, true)
    if (type === 3 && values === 1) view.setUint16(at + 8, value, true)
    else view.setUint32(at + 8, value, true)
  }
  view.setUint32(ifdAt + 2 + count * 12, 0, true)
  return { bytes, view }
}

function literalModel(view: DataView, scaleAt: number, tieAt: number, keysAt: number, fourKeys = false) {
  const scale = [0x4000000000000000n, 0x4000000000000000n, 0x0000000000000000n]
  const tie = [0x0000000000000000n, 0x0000000000000000n, 0x0000000000000000n, 0x411e848000000000n, 0x414f47d200000000n, 0x0000000000000000n]
  for (const [index, word] of scale.entries()) view.setBigUint64(scaleAt + index * 8, word, true)
  for (const [index, word] of tie.entries()) view.setBigUint64(tieAt + index * 8, word, true)
  const keys = fourKeys
    ? [1, 1, 0, 4, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32611, 3076, 0, 1, 9001]
    : [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32611]
  for (const [index, value] of keys.entries()) view.setUint16(keysAt + index * 2, value, true)
}

function literalResolutions(view: DataView, xAt: number, yAt: number) {
  view.setUint32(xAt, 1, true); view.setUint32(xAt + 4, 1, true)
  view.setUint32(yAt, 1, true); view.setUint32(yAt + 4, 1, true)
}

function literalSamples(view: DataView, at: number, words: readonly number[]) {
  if (words.length !== 6) throw new Error('Literal worksheet sample-count mismatch')
  for (const [index, word] of words.entries()) view.setUint32(at + index * 4, word, true)
}

function noNodataWorksheet(zeroData: boolean): Uint8Array {
  const { bytes, view } = literalWorksheet(386, 8, 19, [
    [256, 4, 1, 3], [257, 4, 1, 2], [258, 3, 1, 32],
    [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 242],
    [274, 3, 1, 1], [277, 3, 1, 1], [278, 4, 1, 2],
    [279, 4, 1, 24], [282, 5, 1, 370], [283, 5, 1, 378],
    [284, 3, 1, 1], [296, 3, 1, 1], [317, 3, 1, 1],
    [339, 3, 1, 3], [33550, 12, 3, 266], [33922, 12, 6, 290],
    [34735, 3, 16, 338],
  ])
  literalModel(view, 266, 290, 338)
  literalResolutions(view, 370, 378)
  literalSamples(view, 242, zeroData
    ? [0x00000000, 0x80000000, 0x40800000, 0xc0000000, 0x40400000, 0x40c00000]
    : [0x41000000, 0xc61c3c00, 0x40800000, 0xc0000000, 0x40400000, 0x40c00000])
  return bytes
}

function fourKeyWorksheet(): Uint8Array {
  const { bytes, view } = literalWorksheet(412, 8, 20, [
    [256, 4, 1, 3], [257, 4, 1, 2], [258, 3, 1, 32],
    [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 388],
    [274, 3, 1, 1], [277, 3, 1, 1], [278, 4, 1, 2],
    [279, 4, 1, 24], [282, 5, 1, 366], [283, 5, 1, 374],
    [284, 3, 1, 1], [296, 3, 1, 1], [317, 3, 1, 1],
    [339, 3, 1, 3], [33550, 12, 3, 254], [33922, 12, 6, 278],
    [34735, 3, 20, 326], [42113, 2, 6, 382],
  ])
  literalModel(view, 254, 278, 326, true)
  literalResolutions(view, 366, 374)
  bytes.set([0x2d, 0x39, 0x39, 0x39, 0x39, 0], 382)
  literalSamples(view, 388, [0x41000000, 0xc61c3c00, 0x40800000, 0xc0000000, 0x40400000, 0x40c00000])
  return bytes
}

function inlineZeroWorksheet(negativeSentinel: boolean): Uint8Array {
  const { bytes, view } = literalWorksheet(400, 154, 20, [
    [256, 4, 1, 3], [257, 4, 1, 2], [258, 3, 1, 32],
    [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 8],
    [274, 3, 1, 1], [277, 3, 1, 1], [278, 4, 1, 2],
    [279, 4, 1, 24], [282, 5, 1, 138], [283, 5, 1, 146],
    [284, 3, 1, 1], [296, 3, 1, 1], [317, 3, 1, 1],
    [339, 3, 1, 3], [33550, 12, 3, 34], [33922, 12, 6, 58],
    [34735, 3, 16, 106],
    // These are inline ASCII bytes at392, never an external offset.
    [42113, 2, negativeSentinel ? 3 : 2, negativeSentinel ? 0x0000302d : 0x00000030],
  ])
  literalModel(view, 34, 58, 106)
  literalResolutions(view, 138, 146)
  literalSamples(view, 8, [0x00000000, 0x80000000, 0x40800000, 0xc0000000, 0x40400000, 0x40c00000])
  // Fresh zero initialization retains the sole internal gap[32,34).
  return bytes
}

type TailWorksheetName = 'O-exact' | 'O-pad' | 'L-exact' | 'L-integer-control' | 'L-rounded-decimal-negative' | 'L-integer-negative'
function tailWorksheet(name: TailWorksheetName): Uint8Array {
  let length: number, count: number, token: readonly number[], missingWord: number
  switch (name) {
    case 'O-exact':
      length = 405; count = 7; token = [0x2d, 0x39, 0x39, 0x39, 0x39, 0x2e, 0]; missingWord = 0xc61c3c00
      break
    case 'O-pad':
      length = 406; count = 7; token = [0x2d, 0x39, 0x39, 0x39, 0x39, 0x2e, 0]; missingWord = 0xc61c3c00
      break
    case 'L-exact':
      length = 428; count = 30
      token = [0x30, 0x2e, 0x31, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x34, 0x39, 0x30, 0x31, 0x31, 0x36, 0x31, 0x31, 0x39, 0x33, 0x38, 0x34, 0x37, 0x36, 0x35, 0x36, 0x32, 0x35, 0]
      missingWord = 0x3dcccccd
      break
    case 'L-integer-control':
      length = 407; count = 9; token = [0x31, 0x36, 0x37, 0x37, 0x37, 0x32, 0x31, 0x36, 0]; missingWord = 0x4b800000
      break
    case 'L-rounded-decimal-negative':
      length = 417; count = 19
      token = [0x31, 0x36, 0x37, 0x37, 0x37, 0x32, 0x31, 0x36, 0x2e, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0]
      missingWord = 0x4b800000
      break
    case 'L-integer-negative':
      length = 407; count = 9; token = [0x31, 0x36, 0x37, 0x37, 0x37, 0x32, 0x31, 0x37, 0]; missingWord = 0x4b800000
      break
    default: throw new TypeError('Unknown GeoTIFF tail worksheet')
  }
  if (token.length !== count) throw new Error('Literal worksheet token-count mismatch')
  const { bytes, view } = literalWorksheet(length, 8, 20, [
    [256, 4, 1, 3], [257, 4, 1, 2], [258, 3, 1, 32],
    [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 374],
    [274, 3, 1, 1], [277, 3, 1, 1], [278, 4, 1, 2],
    [279, 4, 1, 24], [282, 5, 1, 358], [283, 5, 1, 366],
    [284, 3, 1, 1], [296, 3, 1, 1], [317, 3, 1, 1],
    [339, 3, 1, 3], [33550, 12, 3, 254], [33922, 12, 6, 278],
    [34735, 3, 16, 326], [42113, 2, count, 398],
  ])
  literalModel(view, 254, 278, 326)
  literalResolutions(view, 358, 366)
  literalSamples(view, 374, [0x41000000, missingWord, 0x40800000, 0xc0000000, 0x40400000, 0x40c00000])
  bytes.set(token, 398)
  // O-pad alone includes the additional zero at405; exact odd EOF is unchanged.
  return bytes
}

function outsideSentinelWorksheet(nonmatchingHeight: boolean): Uint8Array {
  const { bytes, view } = literalWorksheet(404, 8, 20, [
    [256, 4, 1, 3], [257, 4, 1, 2], [258, 3, 1, 32],
    [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, 380],
    [274, 3, 1, 1], [277, 3, 1, 1], [278, 4, 1, 2],
    [279, 4, 1, 24], [282, 5, 1, 358], [283, 5, 1, 366],
    [284, 3, 1, 1], [296, 3, 1, 1], [317, 3, 1, 1],
    [339, 3, 1, 3], [33550, 12, 3, 254], [33922, 12, 6, 278],
    [34735, 3, 16, 326], [42113, 2, 6, 374],
  ])
  literalModel(view, 254, 278, 326)
  literalResolutions(view, 358, 366)
  bytes.set([0x2d, 0x32, 0x65, 0x30, 0x38, 0], 374)
  literalSamples(view, 380, [nonmatchingHeight ? 0x4d3ebc20 : 0x41000000, 0xcd3ebc20, 0x40800000, 0xc0000000, 0x40400000, 0x40c00000])
  return bytes
}

export function geoTiffWorksheetBytes(name: GeoTiffWorksheetName): Uint8Array {
  switch (name) {
    case 'N19': return noNodataWorksheet(false)
    case 'N19-zero': return noNodataWorksheet(true)
    case 'K4': return fourKeyWorksheet()
    case 'I-zero': return inlineZeroWorksheet(false)
    case 'I-minus-zero': return inlineZeroWorksheet(true)
    case 'O-exact': case 'O-pad': case 'L-exact': case 'L-integer-control': case 'L-rounded-decimal-negative': case 'L-integer-negative': return tailWorksheet(name)
    case 'S-outside': return outsideSentinelWorksheet(false)
    case 'S-nonmatching-height-negative': return outsideSentinelWorksheet(true)
    default: throw new TypeError('Unknown GeoTIFF worksheet')
  }
}
