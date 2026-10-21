import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { importGeoTiffSurface } from '../../resources/functions/drone/volumes/geotiff'
import { importGridSurface } from '../../resources/functions/drone/volumes/import'
import { processStockpile } from '../../resources/functions/drone/volumes/engine'
import { primaryGeoTiffAsc, primaryGeoTiffAscSha256, primaryGeoTiffBytes, primaryGeoTiffDeclaration, primaryGeoTiffMeasurement, primaryGeoTiffMetadata, primaryGeoTiffSha256 } from '../fixtures/volumes/geotiff'

// Public function seam: literal geometry plus independent ASC and hand integration.
// This does not establish general GeoTIFF interoperability or physical survey accuracy.
test('imports the literal GeoTIFF cell surface and preserves missing-area volume', async () => {
  const bytes = primaryGeoTiffBytes()
  const surface = await importGeoTiffSurface(bytes, primaryGeoTiffDeclaration())
  const report = processStockpile({ ...primaryGeoTiffMeasurement(), surface })
  const asc = await importGridSurface(primaryGeoTiffAsc, primaryGeoTiffMetadata(primaryGeoTiffAscSha256))
  const ascReport = processStockpile({ ...primaryGeoTiffMeasurement(), surface: asc })

  expect(bytes.length).toBe(404)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(primaryGeoTiffSha256)
  expect(createHash('sha256').update(primaryGeoTiffAsc, 'utf8').digest('hex')).toBe(primaryGeoTiffAscSha256)
  expect(surface.metadata.provenance.sourceSha256).not.toBe(asc.metadata.provenance.sourceSha256)
  expect(surface.version).toBe(1)
  expect(surface.geometry).toEqual({ kind: 'cell-grid', width: 3, height: 2, westM: 500000, southM: 4100000, cellSizeM: 2, rows: [[8, null, 4], [-2, 3, 6]], rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' })
  expect(surface.metadata).toEqual(primaryGeoTiffMetadata(primaryGeoTiffSha256))
  expect(asc.geometry).toEqual(surface.geometry)
  expect(asc.metadata.provenance.sourceSha256).toBe(primaryGeoTiffAscSha256)
  expect(report.method).toBe('clipped-affine-surface-plane-v1')
  expect(report.evidence).toBe('synthetic')
  expect(report.status).toBe('partial-coverage')
  expect(report.boundaryAreaM2).toBe(24)
  expect(report.coveredAreaM2).toBe(20)
  expect(report.uncoveredAreaM2).toBe(4)
  expect(report.coverageFraction).toBe(5 / 6)
  expect(report.aboveBaseM3).toBe(84)
  expect(report.belowBaseM3).toBe(8)
  expect(report.signedTopMinusBaseM3).toBe(76)
  expect(report.fullBoundarySignedM3).toBe(null)
  expect(report.excludedGridCells).toEqual([{ row: 0, column: 1 }])
  expect(report.uncertainty.conditionalVerticalBoundM3).toBe(null)
  expect(report.uncertainty.overallAccuracyBoundM3).toBe(null)
  expect(report.physicalActuationEnabled).toBe(false)
  expect(report.acquisitionPerformed).toBe(false)
  expect(report.reconstructionPerformed).toBe(false)
  expect(report.physicalAccuracyVerified).toBe(false)
  expect(ascReport).toEqual(report)
})

// Public importer boundary only: malformed derivatives use the accepted 404-byte
// worksheet and their own exact digest. No parser internals or production encoder.
function boundaryDeclaration(sourceSha256 = primaryGeoTiffSha256) {
  return {
    version: 1,
    profile: 'classic-le-f32-utm-area-v1',
    sampleMeaning: 'cell-elevation-metres-up',
    interpretation: 'piecewise-constant-cell-elevation',
    metadata: primaryGeoTiffMetadata(sourceSha256),
  }
}

async function refusesGeoTiff(bytes: unknown, declaration: unknown, kind: 'input' | 'budget' | 'digest' = 'input') {
  // @ts-expect-error The public runtime boundary must reject unknown caller inputs.
  const outcome = await importGeoTiffSurface(bytes, declaration).then(
    () => ({ rejected: false, error: null }),
    (error: unknown) => ({ rejected: true, error }),
  )
  expect(outcome.rejected).toBe(true)
  expect(outcome.error).toBeInstanceOf(kind === 'input' ? TypeError : kind === 'budget' ? RangeError : Error)
  expect(outcome.error instanceof Error ? outcome.error.message : null).toBe(kind === 'input' ? 'geotiff-surface-input' : kind === 'budget' ? 'geotiff-surface-budget' : 'geotiff-source-sha256-mismatch')
}

test('accepts ordinary declaration whitespace and native final duplicate-key values', async () => {
  const ordinary = primaryGeoTiffDeclaration()
  const duplicates = '{"version":0,"metadata":{"unknown":true},' + ordinary.slice(1)
  const surface = await importGeoTiffSurface(primaryGeoTiffBytes(), '\t\r\n' + duplicates + ' \n\t')
  expect(surface.metadata).toEqual(primaryGeoTiffMetadata(primaryGeoTiffSha256))
  expect(surface.geometry.rows).toEqual([[8, null, 4], [-2, 3, 6]])
  const invalidLast = ordinary.trimEnd().slice(0, -1) + ',"profile":"unsupported"}'
  await refusesGeoTiff(primaryGeoTiffBytes(), invalidLast)
})

test('bounds complete declaration code units and UTF8 bytes independently', async () => {
  const ordinary = primaryGeoTiffDeclaration()
  const atLimit = ordinary + ' '.repeat(32768 - ordinary.length)
  const accepted = await importGeoTiffSurface(primaryGeoTiffBytes(), atLimit)
  expect(accepted.geometry.rows[0]).toEqual([8, null, 4])
  await refusesGeoTiff(primaryGeoTiffBytes(), atLimit + ' ', 'budget')
  const multibyte = boundaryDeclaration()
  multibyte.metadata.reference.horizontalCrs.definition = 'é'.repeat(512)
  const text = JSON.stringify(multibyte)
  const byteOverflow = text + ' '.repeat(32768 - text.length)
  expect(byteOverflow.length).toBe(32768)
  expect(new TextEncoder().encode(byteOverflow).length).toBeGreaterThan(32768)
  await refusesGeoTiff(primaryGeoTiffBytes(), byteOverflow, 'budget')
})

test('rejects nonprimitive declarations without invoking coercion or proxy hooks', async () => {
  let reads = 0
  const trap = () => { reads++; throw new Error('private-declaration-marker') }
  const wrapped = new String(primaryGeoTiffDeclaration())
  Object.defineProperty(wrapped, Symbol.toPrimitive, { get: trap })
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap })
  for (const declaration of [null, undefined, 1, true, {}, [], wrapped, proxy]) {
    await refusesGeoTiff(primaryGeoTiffBytes(), declaration)
  }
  expect(reads).toBe(0)
})

const invalidDeclarationText = [
  { name: 'BOM', text: '\uFEFF' + primaryGeoTiffDeclaration() },
  { name: 'syntax', text: '{' },
  { name: 'root array', text: '[]' },
  { name: 'root null', text: 'null' },
  { name: 'root number', text: '1' },
]
for (const entry of invalidDeclarationText) {
  test('rejects declaration ' + entry.name, async () => {
    await refusesGeoTiff(primaryGeoTiffBytes(), entry.text)
  })
}

const invalidDeclarations: { name: string, mutate: (value: ReturnType<typeof boundaryDeclaration>) => void }[] = [
  { name: 'unknown top field', mutate: value => { Object.assign(value, { extra: true }) } },
  { name: 'missing sample meaning', mutate: value => { Reflect.deleteProperty(value, 'sampleMeaning') } },
  { name: 'wrong profile', mutate: value => { value.profile = 'general-geotiff' } },
  { name: 'wrong sample meaning', mutate: value => { value.sampleMeaning = 'pixel-value' } },
  { name: 'wrong cell interpretation', mutate: value => { value.interpretation = 'interpolated' } },
  { name: 'unknown metadata field', mutate: value => { Object.assign(value.metadata, { extra: true }) } },
  { name: 'unknown reference field', mutate: value => { Object.assign(value.metadata.reference, { extra: true }) } },
  { name: 'unknown CRS field', mutate: value => { Object.assign(value.metadata.reference.horizontalCrs, { extra: true }) } },
  { name: 'missing explicit coordinate epoch', mutate: value => { Reflect.deleteProperty(value.metadata.reference.horizontalCrs, 'coordinateEpoch') } },
  { name: 'unknown vertical datum field', mutate: value => { Object.assign(value.metadata.reference.verticalDatum, { extra: true }) } },
  { name: 'unknown provenance field', mutate: value => { Object.assign(value.metadata.provenance, { extra: true }) } },
  { name: 'unknown acquisition field', mutate: value => { Object.assign(value.metadata.provenance.acquisition, { extra: true }) } },
  { name: 'unknown reconstruction field', mutate: value => { Object.assign(value.metadata.provenance.reconstructionOrMeshing, { extra: true }) } },
  { name: 'unknown boresight field', mutate: value => { Object.assign(value.metadata.provenance.boresightCalibration, { extra: true }) } },
  { name: 'unknown time calibration field', mutate: value => { Object.assign(value.metadata.provenance.timeCalibration, { extra: true }) } },
  { name: 'unknown classification field', mutate: value => { Object.assign(value.metadata.provenance.groundClassification, { extra: true }) } },
  { name: 'unknown georeferencing field', mutate: value => { Object.assign(value.metadata.provenance.georeferencing, { extra: true }) } },
  { name: 'contradictory acquisition', mutate: value => { value.metadata.provenance.acquisition.sourceId = 'undeclared-source' } },
  { name: 'contradictory calibration', mutate: value => { value.metadata.provenance.timeCalibration.reportId = 'undeclared-report' } },
  { name: 'CRS disagreement', mutate: value => { value.metadata.reference.horizontalCrs.id = 'EPSG:32612' } },
  { name: 'non-UTM EPSG', mutate: value => { value.metadata.reference.horizontalCrs.id = 'EPSG:32661' } },
  { name: 'short source digest', mutate: value => { value.metadata.provenance.sourceSha256 = '0' } },
]
for (const entry of invalidDeclarations) {
  test('rejects closed declaration ' + entry.name, async () => {
    const value = boundaryDeclaration()
    entry.mutate(value)
    await refusesGeoTiff(primaryGeoTiffBytes(), JSON.stringify(value))
  })
}

test('binds source identity to exact binary bytes rather than declaration or ASC text', async () => {
  await refusesGeoTiff(primaryGeoTiffBytes(), JSON.stringify(boundaryDeclaration('0'.repeat(64))), 'digest')
  await refusesGeoTiff(primaryGeoTiffBytes(), JSON.stringify(boundaryDeclaration(primaryGeoTiffAscSha256)), 'digest')
})

test('hashes only genuine visible Uint8Array and Buffer view bytes', async () => {
  const backing = new Uint8Array(412)
  backing.fill(0xa5)
  backing.set(primaryGeoTiffBytes(), 4)
  const visible = new Uint8Array(backing.buffer, 4, 404)
  const surface = await importGeoTiffSurface(visible, primaryGeoTiffDeclaration())
  expect(surface.metadata.provenance.sourceSha256).toBe(primaryGeoTiffSha256)
  expect(surface.geometry.rows).toEqual([[8, null, 4], [-2, 3, 6]])
  const { Buffer } = await import('node:buffer')
  const buffer = Buffer.from(backing.buffer, 4, 404)
  const fromBuffer = await importGeoTiffSurface(buffer, primaryGeoTiffDeclaration())
  expect(fromBuffer).toEqual(surface)
  expect(backing[0]).toBe(0xa5)
  expect(backing[411]).toBe(0xa5)
})

test('uses intrinsic byte ownership without subclass getter species or iterator reads', async () => {
  let reads = 0
  const trap = () => { reads++; throw new Error('private-byte-getter-marker') }
  class GuardedBytes extends Uint8Array {}
  const bytes = new GuardedBytes(404)
  bytes.set(primaryGeoTiffBytes())
  for (const key of ['length', 'byteLength', 'byteOffset', 'buffer', 'constructor', Symbol.toStringTag, Symbol.iterator]) {
    Object.defineProperty(bytes, key, { get: trap })
  }
  Object.defineProperty(GuardedBytes, Symbol.species, { get: trap })
  const surface = await importGeoTiffSurface(bytes, primaryGeoTiffDeclaration())
  expect(reads).toBe(0)
  expect(surface.metadata.provenance.sourceSha256).toBe(primaryGeoTiffSha256)
  expect(surface.geometry.rows).toEqual([[8, null, 4], [-2, 3, 6]])
})

test('rejects proxy and revoked byte views without invoking traps', async () => {
  let reads = 0
  const trap = () => { reads++; throw new Error('private-byte-proxy-marker') }
  const handler = { get: trap, getPrototypeOf: trap, ownKeys: trap }
  const proxy = new Proxy(primaryGeoTiffBytes(), handler)
  const revoked = Proxy.revocable(primaryGeoTiffBytes(), handler)
  revoked.revoke()
  await refusesGeoTiff(proxy, primaryGeoTiffDeclaration())
  await refusesGeoTiff(revoked.proxy, primaryGeoTiffDeclaration())
  expect(reads).toBe(0)
})

test('rejects non-byte shared resizable detached and empty inputs', async () => {
  const shared = new Uint8Array(new SharedArrayBuffer(404))
  shared.set(primaryGeoTiffBytes())
  const resizable = new Uint8Array(new ArrayBuffer(404, { maxByteLength: 808 }))
  resizable.set(primaryGeoTiffBytes())
  const detached = primaryGeoTiffBytes()
  structuredClone(detached.buffer, { transfer: [detached.buffer] })
  for (const bytes of [[], {}, null, undefined, new ArrayBuffer(404), new DataView(new ArrayBuffer(404)), new Int8Array(404), new Uint8ClampedArray(404), shared, resizable, detached, new Uint8Array(0)]) {
    await refusesGeoTiff(bytes, primaryGeoTiffDeclaration())
  }
})

test('owns pre-await bytes and independently returned rows and metadata', async () => {
  const bytes = primaryGeoTiffBytes()
  const pending = importGeoTiffSurface(bytes, primaryGeoTiffDeclaration())
  bytes.fill(0)
  const surface = await pending
  expect(surface.metadata.provenance.sourceSha256).toBe(primaryGeoTiffSha256)
  expect(surface.geometry.rows).toEqual([[8, null, 4], [-2, 3, 6]])
  expect(surface.geometry.rows[0]).not.toBe(surface.geometry.rows[1])
  surface.geometry.rows[0]![0] = 99
  surface.metadata.reference.horizontalCrs.definition = 'caller changed result'
  expect(surface.geometry.rows[1]).toEqual([-2, 3, 6])
  const independent = await importGeoTiffSurface(primaryGeoTiffBytes(), primaryGeoTiffDeclaration())
  expect(independent.geometry.rows).toEqual([[8, null, 4], [-2, 3, 6]])
  expect(independent.metadata).toEqual(primaryGeoTiffMetadata(primaryGeoTiffSha256))
  expect(independent.geometry.rows[0]).not.toBe(surface.geometry.rows[0])
  expect(independent.metadata.reference).not.toBe(surface.metadata.reference)
})

test('rejects source length above the fixed byte budget before parsing', async () => {
  await refusesGeoTiff(new Uint8Array(8388609), primaryGeoTiffDeclaration(), 'budget')
})

interface InvalidGeoTiffCase {
  name: string
  mutate: (view: DataView) => void
  kind?: 'input' | 'budget'
}
// Offsets are from the independent primary worksheet, not discovered by parser code.
const invalidGeoTiffs: InvalidGeoTiffCase[] = [
  { name: 'big endian', mutate: view => { view.setUint8(0, 0x4d) } },
  { name: 'BigTIFF magic', mutate: view => { view.setUint16(2, 43, true) } },
  { name: 'IFD inside header', mutate: view => { view.setUint32(4, 6, true) } },
  { name: 'odd IFD', mutate: view => { view.setUint32(4, 9, true) } },
  { name: 'IFD beyond EOF', mutate: view => { view.setUint32(4, 0xfffffffe, true) } },
  { name: 'IFD entry ceiling', kind: 'budget', mutate: view => { view.setUint16(8, 33, true) } },
  { name: 'wrong IFD count', mutate: view => { view.setUint16(8, 18, true) } },
  { name: 'extra IFD', mutate: view => { view.setUint32(250, 8, true) } },
  { name: 'unknown tag', mutate: view => { view.setUint16(238, 42114, true) } },
  { name: 'missing required X resolution', mutate: view => { view.setUint16(130, 281, true) } },
  { name: 'duplicate tag', mutate: view => { view.setUint16(22, 256, true) } },
  { name: 'unsorted tag', mutate: view => { view.setUint16(22, 255, true) } },
  { name: 'wrong width type', mutate: view => { view.setUint16(12, 3, true) } },
  { name: 'wrong scalar count', mutate: view => { view.setUint32(14, 2, true) } },
  { name: 'nonzero inline SHORT padding', mutate: view => { view.setUint8(44, 1) } },
  { name: 'zero width', mutate: view => { view.setUint32(18, 0, true) } },
  { name: 'cell ceiling', kind: 'budget', mutate: view => { view.setUint32(18, 16385, true) } },
  { name: 'huge dimension', kind: 'budget', mutate: view => { view.setUint32(30, 0xffffffff, true) } },
  { name: 'Float64 samples', mutate: view => { view.setUint16(42, 64, true) } },
  { name: 'compression', mutate: view => { view.setUint16(54, 5, true) } },
  { name: 'orientation', mutate: view => { view.setUint16(90, 4, true) } },
  { name: 'extra band', mutate: view => { view.setUint16(102, 2, true) } },
  { name: 'multiple strips', mutate: view => { view.setUint32(114, 1, true) } },
  { name: 'wrong strip size', mutate: view => { view.setUint32(126, 23, true) } },
  { name: 'separate planar samples', mutate: view => { view.setUint16(162, 2, true) } },
  { name: 'resolution unit', mutate: view => { view.setUint16(174, 4, true) } },
  { name: 'predictor', mutate: view => { view.setUint16(186, 2, true) } },
  { name: 'integer samples', mutate: view => { view.setUint16(198, 1, true) } },
  { name: 'zero X resolution numerator', mutate: view => { view.setUint32(358, 0, true) } },
  { name: 'zero Y resolution denominator', mutate: view => { view.setUint32(370, 0, true) } },
  { name: 'scale payload type', mutate: view => { view.setUint16(204, 11, true) } },
  { name: 'tiepoint payload count', mutate: view => { view.setUint32(218, 12, true) } },
  { name: 'GeoKey field count ceiling', kind: 'budget', mutate: view => { view.setUint32(230, 69, true) } },
  { name: 'GeoKey header version', mutate: view => { view.setUint16(326, 2, true) } },
  { name: 'GeoKey revision', mutate: view => { view.setUint16(328, 2, true) } },
  { name: 'GeoKey minor', mutate: view => { view.setUint16(330, 2, true) } },
  { name: 'GeoKey key ceiling', kind: 'budget', mutate: view => { view.setUint16(332, 17, true) } },
  { name: 'GeoKey directory tail count', mutate: view => { view.setUint16(332, 2, true) } },
  { name: 'GeoKey duplicate', mutate: view => { view.setUint16(342, 1024, true) } },
  { name: 'indirect GeoKey', mutate: view => { view.setUint16(336, 34735, true) } },
  { name: 'GeoKey value count', mutate: view => { view.setUint16(338, 2, true) } },
  { name: 'nonprojected model', mutate: view => { view.setUint16(340, 2, true) } },
  { name: 'PixelIsPoint', mutate: view => { view.setUint16(348, 2, true) } },
  { name: 'unknown GeoKey', mutate: view => { view.setUint16(350, 4096, true) } },
  { name: 'user-defined CRS', mutate: view => { view.setUint16(356, 32767, true) } },
  { name: 'rectangular cells', mutate: view => { view.setFloat64(262, 3, true) } },
  { name: 'zero scale', mutate: view => { view.setFloat64(254, 0, true) } },
  { name: 'negative scale', mutate: view => { view.setFloat64(254, -2, true) } },
  { name: 'nonfinite scale', mutate: view => { view.setFloat64(254, Infinity, true) } },
  { name: 'Z scale', mutate: view => { view.setFloat64(270, 1, true) } },
  { name: 'half-cell tiepoint', mutate: view => { view.setFloat64(278, 0.5, true) } },
  { name: 'model Z', mutate: view => { view.setFloat64(318, 1, true) } },
  { name: 'nonfinite north', mutate: view => { view.setFloat64(310, NaN, true) } },
  { name: 'out-of-bound east corner', mutate: view => { view.setFloat64(302, 99999996, true) } },
  { name: 'missing nodata terminator', mutate: view => { view.setUint8(379, 1) } },
  { name: 'early nodata terminator', mutate: view => { view.setUint8(376, 0) } },
  { name: 'non-ASCII nodata', mutate: view => { view.setUint8(376, 0x80) } },
  { name: 'quiet NaN sample', mutate: view => { view.setUint32(380, 0x7fc00000, true) } },
  { name: 'signalling NaN sample', mutate: view => { view.setUint32(380, 0x7f800001, true) } },
  { name: 'positive infinite sample', mutate: view => { view.setUint32(380, 0x7f800000, true) } },
  { name: 'negative infinite sample', mutate: view => { view.setUint32(380, 0xff800000, true) } },
  { name: 'finite sample above range', mutate: view => { view.setUint32(380, 0x4d000000, true) } },
  { name: 'all cells missing', mutate: view => { for (let at = 380; at < 404; at += 4) view.setUint32(at, 0xc61c3c00, true) } },
]
for (const pointer of [78, 138, 150, 210, 222, 234, 246]) {
  for (const [name, value] of [['header overlap', 6], ['odd payload', 9], ['past EOF', 404], ['uint32 offset', 0xfffffffe]] as const) {
    invalidGeoTiffs.push({ name: 'offset' + pointer + ' ' + name, mutate: view => { view.setUint32(pointer, value, true) } })
  }
}
invalidGeoTiffs.push(
  { name: 'strip overlaps scale', mutate: view => { view.setUint32(78, 254, true) } },
  { name: 'scale overlaps IFD value slot', mutate: view => { view.setUint32(210, 18, true) } },
  { name: 'tiepoint partially aliases scale', mutate: view => { view.setUint32(222, 262, true) } },
  { name: 'resolution exact alias', mutate: view => { view.setUint32(138, 366, true) } },
  { name: 'nodata overlaps keys', mutate: view => { view.setUint32(246, 326, true) } },
)
for (const token of ['0.100', '-0.10', '1e-99', '1e201', '1e999', '-1e99', ' 9999', '9999 ', '0x010', '1,234', 'NaN00']) {
  invalidGeoTiffs.push({ name: 'nodata token ' + JSON.stringify(token), mutate: view => { new Uint8Array(view.buffer).set(new TextEncoder().encode(token), 374) } })
}
for (const entry of invalidGeoTiffs) {
  test('rejects GeoTIFF ' + entry.name, async () => {
    const bytes = primaryGeoTiffBytes()
    entry.mutate(new DataView(bytes.buffer))
    const digest = createHash('sha256').update(bytes).digest('hex')
    await refusesGeoTiff(bytes, JSON.stringify(boundaryDeclaration(digest)), entry.kind)
  })
}

test('rejects truncated or unreferenced trailing bytes without a partial surface', async () => {
  for (const bytes of [primaryGeoTiffBytes().subarray(0, 403), new Uint8Array(405), new Uint8Array(406)]) {
    if (bytes.length > 404) bytes.set(primaryGeoTiffBytes())
    const digest = createHash('sha256').update(bytes).digest('hex')
    await refusesGeoTiff(bytes, JSON.stringify(boundaryDeclaration(digest)))
  }
})


// Literal complete-file identities are from root's single fixture-only assembly,
// independently inspected against the paper before the first public variant call.
const validGeoTiffWorksheets = [
  { name: 'N19', bytes: 386, sha256: 'd541b744ba2051774465a76e65ff34132a29d24cd8c6997fe1c2ef6321e65231', rows: [[8, -9999, 4], [-2, 3, 6]], covered: 24, uncovered: 0, fraction: 1, above: 84, below: 40004, signed: -39920, full: -39920, excluded: [] },
  { name: 'N19-zero', bytes: 386, sha256: '742b38f8f8375edc85dbd52f99360f8cf225696815250ff65c33da514964dfcf', rows: [[0, -0, 4], [-2, 3, 6]], covered: 24, uncovered: 0, fraction: 1, above: 52, below: 8, signed: 44, full: 44, excluded: [] },
  { name: 'K4', bytes: 412, sha256: '20e9ae0177ce54185317748caaa5c6e1c20464801618bf0ca8479776f3d8184e', rows: [[8, null, 4], [-2, 3, 6]], covered: 20, uncovered: 4, fraction: 5 / 6, above: 84, below: 8, signed: 76, full: null, excluded: [{ row: 0, column: 1 }] },
  { name: 'I-zero', bytes: 400, sha256: '8f5eddf74fe5a7fabf2fde9ffba377ce1d57bd35d6c7d6fbfe8547cdf3d29587', rows: [[null, null, 4], [-2, 3, 6]], covered: 16, uncovered: 8, fraction: 2 / 3, above: 52, below: 8, signed: 44, full: null, excluded: [{ row: 0, column: 0 }, { row: 0, column: 1 }] },
  { name: 'I-minus-zero', bytes: 400, sha256: '416a5296834572266f534bca3f8872cc89b8df113c94426ea5e48eac9d5951d2', rows: [[null, null, 4], [-2, 3, 6]], covered: 16, uncovered: 8, fraction: 2 / 3, above: 52, below: 8, signed: 44, full: null, excluded: [{ row: 0, column: 0 }, { row: 0, column: 1 }] },
  { name: 'O-exact', bytes: 405, sha256: 'c7d4884697a53cde56db0a64ecd3a10e56c4f131acb68de224886b0e4104987b', rows: [[8, null, 4], [-2, 3, 6]], covered: 20, uncovered: 4, fraction: 5 / 6, above: 84, below: 8, signed: 76, full: null, excluded: [{ row: 0, column: 1 }] },
  { name: 'O-pad', bytes: 406, sha256: 'a99ff55be6cb481e2959183948fef242d19d24d9920f51d9f3f673951bc54d5b', rows: [[8, null, 4], [-2, 3, 6]], covered: 20, uncovered: 4, fraction: 5 / 6, above: 84, below: 8, signed: 76, full: null, excluded: [{ row: 0, column: 1 }] },
  { name: 'L-exact', bytes: 428, sha256: '45a2a2e6173d651094c3c48c1417541218ead2c1cb08787d73b04f18e245bb0c', rows: [[8, null, 4], [-2, 3, 6]], covered: 20, uncovered: 4, fraction: 5 / 6, above: 84, below: 8, signed: 76, full: null, excluded: [{ row: 0, column: 1 }] },
  { name: 'L-integer-control', bytes: 407, sha256: '57a18a66b71cce46cb0b161ccef586945a8c08b66542c7e4d1859a3733b7106e', rows: [[8, null, 4], [-2, 3, 6]], covered: 20, uncovered: 4, fraction: 5 / 6, above: 84, below: 8, signed: 76, full: null, excluded: [{ row: 0, column: 1 }] },
  { name: 'S-outside', bytes: 404, sha256: '74e3be71673d059072da0f888ac06cde34dd9c54d48fb3252e89c3ecbe0c1da9', rows: [[8, null, 4], [-2, 3, 6]], covered: 20, uncovered: 4, fraction: 5 / 6, above: 84, below: 8, signed: 76, full: null, excluded: [{ row: 0, column: 1 }] },
] as const
for (const entry of validGeoTiffWorksheets) {
  test('imports literal worksheet ' + entry.name + ' with hand G0 coverage and volume', async () => {
    const { geoTiffWorksheetBytes } = await import('../fixtures/volumes/geotiff')
    const bytes = geoTiffWorksheetBytes(entry.name)
    expect(bytes.length).toBe(entry.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    const surface = await importGeoTiffSurface(bytes, JSON.stringify(boundaryDeclaration(entry.sha256)))
    // Direct original Number observations precede any serialization.
    if (entry.name === 'N19-zero') {
      expect(Object.is(surface.geometry.rows[0]![0], 0)).toBe(true)
      expect(Object.is(surface.geometry.rows[0]![1], -0)).toBe(true)
    }
    expect(surface.geometry).toEqual({ kind: 'cell-grid', width: 3, height: 2, westM: 500000, southM: 4100000, cellSizeM: 2, rows: entry.rows.map(row => [...row]), rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' })
    expect(surface.metadata).toEqual(primaryGeoTiffMetadata(entry.sha256))
    const report = processStockpile({ ...primaryGeoTiffMeasurement(), surface })
    expect(report.method).toBe('clipped-affine-surface-plane-v1')
    expect(report.status).toBe(entry.uncovered === 0 ? 'covered-domain' : 'partial-coverage')
    expect(report.boundaryAreaM2).toBe(24)
    expect(report.coveredAreaM2).toBe(entry.covered)
    expect(report.uncoveredAreaM2).toBe(entry.uncovered)
    expect(report.coverageFraction).toBe(entry.fraction)
    expect(report.aboveBaseM3).toBe(entry.above)
    expect(report.belowBaseM3).toBe(entry.below)
    expect(report.signedTopMinusBaseM3).toBe(entry.signed)
    expect(report.fullBoundarySignedM3).toBe(entry.full)
    expect(report.excludedGridCells).toEqual(entry.excluded.map(cell => ({ ...cell })))
    expect(report.uncertainty.conditionalVerticalBoundM3).toBe(null)
    expect(report.uncertainty.overallAccuracyBoundM3).toBe(null)
    expect(report.physicalActuationEnabled).toBe(false)
    expect(report.acquisitionPerformed).toBe(false)
    expect(report.reconstructionPerformed).toBe(false)
    expect(report.physicalAccuracyVerified).toBe(false)
  })
  test('rejects only the changed declared digest for valid worksheet ' + entry.name, async () => {
    const { geoTiffWorksheetBytes } = await import('../fixtures/volumes/geotiff')
    const bytes = geoTiffWorksheetBytes(entry.name)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    const changed = (Number.parseInt(entry.sha256[0]!, 16) ^ 1).toString(16) + entry.sha256.slice(1)
    expect(changed).toMatch(/^[0-9a-f]{64}$/)
    expect(changed).not.toBe(entry.sha256)
    await refusesGeoTiff(bytes, JSON.stringify(boundaryDeclaration(changed)), 'digest')
  })
}

const semanticGeoTiffWorksheets = [
  { name: 'L-rounded-decimal-negative', bytes: 417, sha256: '7ad056b89608a8ecfc86adabcaa43aaa90ee65bc8767348e1b9bfad52494167d' },
  { name: 'L-integer-negative', bytes: 407, sha256: '68830304d21ff78b62c60ed1d9bb5338f062abbc4bd4d598d5df12103358e276' },
  { name: 'S-nonmatching-height-negative', bytes: 404, sha256: 'fe94b1b091989758cab67f5925ad86c473764a309b16aded05342f5999992e4b' },
] as const
for (const entry of semanticGeoTiffWorksheets) {
  test('rejects isolated numeric rule worksheet ' + entry.name, async () => {
    const { geoTiffWorksheetBytes } = await import('../fixtures/volumes/geotiff')
    const bytes = geoTiffWorksheetBytes(entry.name)
    expect(bytes.length).toBe(entry.bytes)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    await refusesGeoTiff(bytes, JSON.stringify(boundaryDeclaration(entry.sha256)))
  })
}
