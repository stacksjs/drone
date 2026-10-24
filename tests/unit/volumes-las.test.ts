import { expect, test } from 'bun:test'
import { importLasSurface } from '../../resources/functions/drone/volumes/las'
import { processStockpile } from '../../resources/functions/drone/volumes/engine'
import { primaryLasBytes, primaryLasDeclaration, primaryLasMeasurement, primaryLasSha256, primaryLasVerticalCrs } from '../fixtures/volumes/las'
import type { LasGridDeclaration } from '../../resources/functions/drone/volumes/las'
import { createHash } from 'node:crypto'

function sidecar(bytes: Uint8Array, update?: (d: LasGridDeclaration) => void) {
  const d = JSON.parse(primaryLasDeclaration()) as LasGridDeclaration
  d.metadata.provenance.sourceSha256 = createHash('sha256').update(bytes).digest('hex')
  update?.(d)
  return JSON.stringify(d)
}

// Public computation seam: real binary bytes to declared cells and independent
// 18m3 worksheet. It does not establish acquisition/classification/survey accuracy.
test('a LAS point cloud produces only explicitly supported mean cells and a covered-domain volume', async () => {
  const imported = await importLasSurface(primaryLasBytes(), primaryLasDeclaration())
  expect(imported.surface.geometry.rows).toEqual([[3, 6], [9, null]])
  expect(imported.surface.metadata.provenance.sourceSha256).toBe(primaryLasSha256)
  expect(imported.processing.sourcePointCount).toBe(8)
  expect(imported.processing.selectedPointCount).toBe(5)
  expect(imported.processing.excluded).toEqual({ withheld: 1, synthetic: 0, classification: 1, returns: 0, outsideGrid: 1 })
  expect(imported.processing.coveredCells).toBe(3)
  expect(imported.processing.representationErrorBoundM).toBeNull()
  const report = processStockpile({ ...primaryLasMeasurement(), surface: imported.surface })
  expect(report.aboveBaseM3).toBe(18)
  expect(report.coveredAreaM2).toBe(3)
  expect(report.uncoveredAreaM2).toBe(1)
  expect(report.status).toBe('partial-coverage')
  expect(report.fullBoundarySignedM3).toBeNull()
  expect(report.uncertainty.overallAccuracyBoundM3).toBeNull()
  expect(report.physicalAccuracyVerified).toBe(false)
})

test('point-count, spread, return and class choices retain unknown cells without inventing a ground surface', async () => {
  const bytes = primaryLasBytes()
  const counted = await importLasSurface(bytes, sidecar(bytes, d => { d.grid.minimumPoints = 2 }))
  expect(counted.surface.geometry.rows).toEqual([[3, null], [9, null]])
  expect(counted.processing.cells[1]!.reason).toBe('insufficient-points')
  const spread = await importLasSurface(bytes, sidecar(bytes, d => { d.grid.maximumSpreadM = 1 }))
  expect(spread.surface.geometry.rows).toEqual([[null, 6], [null, null]])
  expect(spread.processing.cells[0]!.reason).toBe('excessive-spread')
  const first = await importLasSurface(bytes, sidecar(bytes, d => { d.selection.returns = 'first' }))
  expect(first.surface.geometry.rows).toEqual([[2, 6], [9, null]])
  expect(first.processing.excluded.returns).toBe(1)
  const classes = await importLasSurface(bytes, sidecar(bytes, d => { d.selection.classes = [7] }))
  expect(classes.surface.geometry.rows).toEqual([[null, null], [null, 99]])
  expect(classes.processing.classificationVerified).toBe(false)
  await expect(importLasSurface(bytes, sidecar(bytes, d => { d.selection.classes = [2] }))).rejects.toThrow('las-surface-no-supported-cells')
})

test('synthetic flags require an explicit choice while withheld samples are always excluded', async () => {
  const bytes = primaryLasBytes(); bytes[328] = 33
  const excluded = await importLasSurface(bytes, sidecar(bytes))
  expect(excluded.surface.geometry.rows).toEqual([[4, 6], [9, null]])
  expect(excluded.processing.excluded.synthetic).toBe(1)
  const included = await importLasSurface(bytes, sidecar(bytes, d => { d.selection.synthetic = 'include' }))
  expect(included.surface.geometry.rows).toEqual([[3, 6], [9, null]])
  expect(included.processing.excluded.withheld).toBe(1)
})

test('signed LAS elevations retain independent cut and fill while declared outer cell edges stay half-open', async () => {
  const negative = primaryLasBytes(), v = new DataView(negative.buffer)
  v.setInt32(321, -200, true); v.setInt32(341, -400, true); v.setFloat64(219, -4, true)
  const imported = await importLasSurface(negative, sidecar(negative))
  expect(imported.surface.geometry.rows).toEqual([[-3, 6], [9, null]])
  const report = processStockpile({ ...primaryLasMeasurement(), surface: imported.surface })
  expect(report.aboveBaseM3).toBe(15)
  expect(report.belowBaseM3).toBe(3)
  expect(report.signedTopMinusBaseM3).toBe(12)
  const edges = primaryLasBytes(), edge = new DataView(edges.buffer)
  edge.setInt32(313, 0, true); edge.setInt32(377, 0, true)
  edge.setInt32(453, 100, true); edge.setInt32(457, 200, true)
  edge.setFloat64(179, 500001.75, true); edge.setFloat64(187, 500000, true)
  edge.setFloat64(195, 4100002, true); edge.setFloat64(203, 4100000, true)
  const bounded = await importLasSurface(edges, sidecar(edges))
  expect(bounded.surface.geometry.rows).toEqual([[3, 6], [9, null]])
  expect(bounded.processing.excluded.outsideGrid).toBe(1)
})

// Independent record-layout extensions to the literal worksheet, not production encoders.
test('LAS1.2 formats1,2,3 preserve coordinate means and explicitly reported GPS time conventions', async () => {
  const original = primaryLasBytes()
  for (const [format, length] of [[1, 28], [2, 26], [3, 34]] as const) {
    for (const globalEncoding of [0, 1]) {
      const bytes = new Uint8Array(313 + 8 * length); bytes.set(original.subarray(0, 313))
      const v = new DataView(bytes.buffer); v.setUint16(6, globalEncoding, true); v.setUint8(104, format); v.setUint16(105, length, true)
      for (let i = 0; i < 8; i++) {
        bytes.set(original.subarray(313 + 20 * i, 333 + 20 * i), 313 + i * length)
        if (format !== 2) v.setFloat64(333 + i * length, globalEncoding ? -20 + i : 100 + i, true)
        if (format !== 1) for (let color = 0; color < 3; color++) v.setUint16(313 + i * length + (format === 2 ? 20 : 28) + 2 * color, 1234, true)
      }
      const parsed = await importLasSurface(bytes, sidecar(bytes))
      expect(parsed.surface.geometry.rows).toEqual([[3, 6], [9, null]])
      expect(parsed.processing.format).toBe(format)
      expect(parsed.processing.gps).toEqual(format === 2 ? { type: 'absent', minimum: null, maximum: null } : globalEncoding ? { type: 'adjusted-standard-seconds', minimum: -20, maximum: -13 } : { type: 'week-seconds', minimum: 100, maximum: 107 })
    }
  }
})

test('admission snapshots native visible bytes before await without invoking caller properties', async () => {
  const owner = new Uint8Array(500); owner.set(primaryLasBytes(), 11)
  const view = owner.subarray(11, 484)
  for (const key of ['length', 'byteLength', 'byteOffset', 'buffer', Symbol.iterator]) Object.defineProperty(view, key, { get() { throw new Error('PRIVATE_ACCESSOR') } })
  const pending = importLasSurface(view, primaryLasDeclaration())
  owner.fill(0)
  const first = await pending
  expect(first.surface.geometry.rows).toEqual([[3, 6], [9, null]])
  first.surface.geometry.rows[0]![0] = 999
  const second = await importLasSurface(primaryLasBytes(), primaryLasDeclaration())
  expect(second.surface.geometry.rows[0]![0]).toBe(3)
  for (const bad of [null, [], new Proxy(primaryLasBytes(), {}), new Uint8Array(new SharedArrayBuffer(473)), new Uint8Array(8388609)]) await expect(importLasSurface(bad as Uint8Array, primaryLasDeclaration())).rejects.toThrow(/^las-surface-(input|budget)$/)
})

test('malformed or contradictory LAS records cannot be laundered through a matching source digest', async () => {
  const changes: ((v: DataView, bytes: Uint8Array) => void)[] = [
    v => v.setUint8(25, 4), v => v.setUint8(104, 128), v => v.setUint16(105, 21, true), v => v.setUint32(96, 312, true),
    v => v.setUint32(107, 200001, true), v => v.setUint32(111, 8, true), v => v.setFloat64(131, 0, true),
    v => v.setFloat64(155, NaN, true), v => v.setFloat64(179, 500001, true), v => v.setUint16(311, 9002, true),
    v => v.setUint16(303, 32619, true), v => v.setUint16(299, 1, true), v => v.setUint8(327, 0), v => v.setInt8(329, -91),
  ]
  for (const change of changes) {
    const bytes = primaryLasBytes(); change(new DataView(bytes.buffer), bytes)
    await expect(importLasSurface(bytes, sidecar(bytes))).rejects.toThrow(/^las-surface-(input|budget)$/)
  }
  const good = primaryLasBytes()
  await expect(importLasSurface(good.subarray(0, 472), sidecar(good.subarray(0, 472)))).rejects.toThrow('las-surface-input')
  const trailer = new Uint8Array(474); trailer.set(good)
  await expect(importLasSurface(trailer, sidecar(trailer))).rejects.toThrow('las-surface-input')
  good[400] = good[400]! ^ 1
  await expect(importLasSurface(good, primaryLasDeclaration())).rejects.toThrow('las-source-sha256-mismatch')
  for (const declaration of ['PRIVATE_INVALID_JSON', '\uFEFF' + primaryLasDeclaration(), sidecar(primaryLasBytes(), d => { d.metadata.reference.horizontalCrs.id = 'EPSG:32619' }), sidecar(primaryLasBytes(), d => { d.selection.classes = [1, 1] })]) {
    let message = ''
    try { await importLasSurface(primaryLasBytes(), declaration) }
    catch (error) { message = (error as Error).message }
    expect(message).toBe('las-surface-input')
    expect(message).not.toContain('PRIVATE')
  }
})

// Matching labels cannot change the embedded vertical CRS's units or axis.
test('a matching sidecar cannot interpret a feet or depth vertical CRS as metres-up', async () => {
  for (const code of [5702, 5715]) {
    for (const explicitMetreUnit of [false, true]) {
      const bytes = primaryLasVerticalCrs(code, explicitMetreUnit)
      await expect(importLasSurface(bytes, sidecar(bytes, d => { d.metadata.reference.verticalDatum.id = `EPSG:${code}` }))).rejects.toThrow('las-surface-input')
    }
  }
})

test('verified metre-up embedded vertical CRS labels preserve numeric elevations and explicit unverified datum evidence', async () => {
  for (const code of [3855, 5701, 5703, 5714, 5773, 5783]) {
    for (const explicitMetreUnit of [false, true]) {
      const bytes = primaryLasVerticalCrs(code, explicitMetreUnit)
      const imported = await importLasSurface(bytes, sidecar(bytes, d => { d.metadata.reference.verticalDatum.id = `EPSG:${code}` }))
      expect(imported.surface.geometry.rows).toEqual([[3, 6], [9, null]])
      expect(imported.processing.verticalReference).toEqual({ mode: 'declared-sidecar', declaredDatumId: `EPSG:${code}`, embeddedCrs: `EPSG:${code}`, unit: 'metre', positive: 'up', coordinateTransformPerformed: false, datumVerified: false })
    }
  }
  const unknown = primaryLasVerticalCrs(65534, true)
  await expect(importLasSurface(unknown, sidecar(unknown, d => { d.metadata.reference.verticalDatum.id = 'EPSG:65534' }))).rejects.toThrow('las-surface-input')
  const different = primaryLasVerticalCrs(5703, true)
  await expect(importLasSurface(different, sidecar(different, d => { d.metadata.reference.verticalDatum.id = 'EPSG:5773' }))).rejects.toThrow('las-surface-input')
  const absent = await importLasSurface(primaryLasBytes(), primaryLasDeclaration())
  expect(absent.processing.verticalReference.embeddedCrs).toBeNull()
  expect(absent.processing.verticalReference.datumVerified).toBe(false)
})
