import type { SurfaceMetadata } from '../../resources/functions/drone/volumes/types'
import { describe, expect, test } from 'bun:test'
import { exportGridSurface, exportPlySurface, importGridSurface, importPlySurface, parseVolumeRequest, surfaceSourceDigest } from '../../resources/functions/drone/volumes/import'

const asciiGrid = 'ncols 3\nnrows 2\nxllcorner 500000\nyllcorner 4100000\ncellsize 2\nNODATA_value -9999\n8 -9999 4\n-2 3 6\n'
function metadata(hash: string): SurfaceMetadata {
  return {
    version: 1, id: 'literal-surface',
    reference: { horizontalCrs: { kind: 'wgs84-utm', id: 'EPSG:32611', definition: 'WGS 84 UTM zone 11N', coordinateEpoch: null }, axes: 'EAST_NORTH', horizontalUnit: 'metre', verticalDatum: { kind: 'ellipsoidal', id: 'WGS84', definition: 'WGS84 ellipsoidal height' }, verticalUnit: 'metre', elevationPositive: 'up' },
    provenance: { evidence: 'operator-imported', sourceKind: 'surveyed-mesh', sourceSha256: hash, acquisition: { status: 'unknown', sourceId: null }, reconstructionOrMeshing: { status: 'unknown', sourceId: null }, boresightCalibration: { status: 'unknown', reportId: null }, timeCalibration: { status: 'unknown', reportId: null }, groundClassification: { status: 'unknown', description: 'No classification supplied', reportId: null }, georeferencing: { verticalBoundM: null, horizontalBoundM: null, reportId: null } },
  }
}

describe('known surface interchange', () => {
  test('imports independently authored north-first cell elevations and keeps nodata missing', async () => {
    const source = metadata(await surfaceSourceDigest(asciiGrid))
    const surface = await importGridSurface(asciiGrid, source)
    expect(surface.geometry).toEqual({ kind: 'cell-grid', width: 3, height: 2, westM: 500000, southM: 4100000, cellSizeM: 2, rows: [[8, null, 4], [-2, 3, 6]], rowOrder: 'north-to-south', interpretation: 'piecewise-constant-cell-elevation' })
    expect(surface.metadata).toEqual(source)
    source.reference.verticalDatum.id = 'mutated'
    expect(surface.metadata.reference.verticalDatum.id).toBe('WGS84')
  })
})

const asciiMesh = 'ply\nformat ascii 1.0\nelement vertex 4\nproperty double x\nproperty double y\nproperty double z\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n4 0 4\n4 3 4\n0 3 0\n3 0 1 2\n3 0 2 3\n'

test('source hashes bind exact bytes, not normalized line endings or parsed values', async () => {
  expect(await surfaceSourceDigest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const sidecar = metadata(await surfaceSourceDigest(asciiGrid))
  await expect(importGridSurface(asciiGrid.replace(/\n/g, '\r\n'), sidecar)).rejects.toThrow('SHA256')
  await expect(importGridSurface(asciiGrid, { ...sidecar, reference: undefined } as unknown as SurfaceMetadata)).rejects.toThrow()
})

test('imports indexed triangular PLY with explicit sidecar and roundtrips numerical topology', async () => {
  const mesh = await importPlySurface(asciiMesh, metadata(await surfaceSourceDigest(asciiMesh)))
  expect(mesh.geometry).toEqual({ kind: 'tin', vertices: [[0, 0, 0], [4, 0, 4], [4, 3, 4], [0, 3, 0]], triangles: [[0, 1, 2], [0, 2, 3]] })
  const encoded = exportPlySurface(mesh)
  const rebound = structuredClone(mesh.metadata)
  rebound.provenance.sourceSha256 = await surfaceSourceDigest(encoded)
  expect((await importPlySurface(encoded, rebound)).geometry).toEqual(mesh.geometry)
  expect(() => exportGridSurface(mesh)).toThrow('cell-grid')
})

test('grid output preserves nodata when valid heights equal a common nodata sentinel', async () => {
  const grid = await importGridSurface(asciiGrid, metadata(await surfaceSourceDigest(asciiGrid)))
  if (grid.geometry.kind !== 'cell-grid') throw new Error('fixture kind')
  grid.geometry.rows[0]![0] = -9999
  const encoded = exportGridSurface(grid)
  expect(encoded).toContain('NODATA_value -99990')
  const rebound = structuredClone(grid.metadata)
  rebound.provenance.sourceSha256 = await surfaceSourceDigest(encoded)
  expect((await importGridSurface(encoded, rebound)).geometry).toEqual(grid.geometry)
  expect(() => exportPlySurface(grid)).toThrow('TIN')
})

test('rejects AAIGrid semantics changes, malformed records and oversized declarations', async () => {
  const invalid = [
    asciiGrid.replace('xllcorner', 'xllcenter'),
    asciiGrid.replace('cellsize 2', 'DX 2'),
    asciiGrid.replace('ncols 3', 'ncols 3\nncols 3'),
    asciiGrid.replace('ncols 3', 'ncols 999999999999999999999'),
    asciiGrid.replace('nrows 2', 'nrows 32768'),
    asciiGrid.replace('8 -9999 4', '8 4'),
    asciiGrid.replace('8 -9999 4', '8 NaN 4'),
    asciiGrid.replace('cellsize 2', 'cellsize -2'),
    `${asciiGrid}1 2 3\n`,
    `\uFEFF${asciiGrid}`,
  ]
  for (const text of invalid)
    await expect(importGridSurface(text, metadata(await surfaceSourceDigest(text)))).rejects.toThrow()
  const noNodata = asciiGrid.replace('NODATA_value -9999\n', '')
  const grid = await importGridSurface(noNodata, metadata(await surfaceSourceDigest(noNodata)))
  expect(grid.geometry.kind === 'cell-grid' && grid.geometry.rows[0]![1]).toBe(-9999)
})

test('rejects raw point files and unsupported PLY properties instead of inventing topology or discarding metadata', async () => {
  const invalid = [
    asciiMesh.replace('format ascii 1.0', 'format binary_little_endian 1.0'),
    asciiMesh.replace('element face 2', 'element face 0'),
    asciiMesh.replace('element vertex 4', 'element vertex 32769'),
    asciiMesh.replace('element face 2', 'element face 16385'),
    asciiMesh.replace('property double z', 'property double z\nproperty uchar classification'),
    asciiMesh.replace('3 0 1 2', '4 0 1 2 3'),
    asciiMesh.replace('3 0 1 2', '3 0 1 4'),
    asciiMesh.replace('3 0 1 2', '3 0 1 1'),
    asciiMesh.replace('3 0 2 3', '3 0 1 2'),
    asciiMesh.replace('0 0 0', '0 0 Infinity'),
    `${asciiMesh}3 0 1 2\n`,
    asciiMesh.slice(0, asciiMesh.lastIndexOf('3 0 2 3')),
  ]
  for (const text of invalid)
    await expect(importPlySurface(text, metadata(await surfaceSourceDigest(text)))).rejects.toThrow()
  const singular = asciiMesh.replace('vertex_indices', 'vertex_index')
  expect((await importPlySurface(singular, metadata(await surfaceSourceDigest(singular)))).geometry.kind).toBe('tin')
})

test('rejects oversized text before JSON parsing or geometry allocation', async () => {
  await expect(surfaceSourceDigest(' '.repeat(8 * 1024 * 1024 + 1))).rejects.toThrow('bytes')
  expect(() => parseVolumeRequest(' '.repeat(16 * 1024 * 1024 + 1))).toThrow('bytes')
  expect(() => parseVolumeRequest('{')).toThrow()
})
