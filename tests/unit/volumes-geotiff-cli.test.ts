import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readGeoTiffFile } from '../../resources/functions/drone/volumes/files'
import { primaryGeoTiffBytes, primaryGeoTiffDeclaration, primaryGeoTiffMeasurement, primaryGeoTiffSha256 } from '../fixtures/volumes/geotiff'

// Public server file seam: actual local bytes, without UTF-8 decoding or survey claims.
test('reads an exact independent binary snapshot of the literal GeoTIFF file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-geotiff-file-'))
  try {
    const path = join(root, 'surface.tif'), original = primaryGeoTiffBytes()
    await writeFile(path, original, { mode: 0o600 })
    const result = await readGeoTiffFile(path)
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result).toEqual(original)
    expect(result.byteLength).toBe(404)
    expect(result.byteOffset).toBe(0)
    expect(result.buffer.byteLength).toBe(404)
    result[0] = 0
    expect(Array.from(await readFile(path))).toEqual(Array.from(original))
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

// Native command seam: explicit binary format, retained dataset identities and report replay.
test('native GeoTIFF import retains the original digest and publishes a replayable ASC dataset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-geotiff-import-'))
  const project = resolve(import.meta.dir, '../..')
  try {
    await writeFile(join(root, 'surface.tif'), primaryGeoTiffBytes())
    await writeFile(join(root, 'declaration.json'), primaryGeoTiffDeclaration())
    await writeFile(join(root, 'measurement.json'), JSON.stringify(primaryGeoTiffMeasurement()))
    const args = ['volumes:import', join(root, 'surface.tif'), '--format', 'geotiff', '--metadata', join(root, 'declaration.json'), '--measurement', join(root, 'measurement.json'), '--output', join(root, 'dataset')]
    const result = await command(args).withCwd(project).withTimeout(60000)
    expect(result.exitCode).toBe(0)
    const imported = JSON.parse(result.stdout)
    expect(imported.report.status).toBe('partial-coverage')
    expect(imported.report.aboveBaseM3).toBe(84)
    expect(imported.report.belowBaseM3).toBe(8)
    expect(imported.report.coveredAreaM2).toBe(20)
    expect(imported.report.fullBoundarySignedM3).toBeNull()
    expect(imported.report.physicalAccuracyVerified).toBe(false)
    const manifest = JSON.parse(await readFile(join(root, 'dataset/manifest.json'), 'utf8'))
    const request = JSON.parse(await readFile(join(root, 'dataset/request.json'), 'utf8'))
    const regenerated = await readFile(join(root, 'dataset/surface.asc'))
    const metadata = JSON.parse(await readFile(join(root, 'dataset/surface.metadata.json'), 'utf8'))
    expect(manifest.originalSourceSha256).toBe(primaryGeoTiffSha256)
    expect(request.surface.metadata.provenance.sourceSha256).toBe(primaryGeoTiffSha256)
    expect(manifest.regeneratedSourceSha256).toBe(createHash('sha256').update(regenerated).digest('hex'))
    expect(metadata.provenance.sourceSha256).toBe(manifest.regeneratedSourceSha256)
    expect(manifest.regeneratedSourceSha256).not.toBe(primaryGeoTiffSha256)
    expect(manifest.sourcePath).toBe('surface.asc')
    expect(manifest.files.map((entry: { path: string }) => entry.path)).not.toContain('surface.tif')
    const replay = await command(['volumes:process', join(root, 'dataset/request.json')]).withCwd(project).withTimeout(60000)
    expect(replay.exitCode).toBe(0)
    expect(JSON.parse(replay.stdout).report).toEqual(imported.report)
    const asc = await command(['volumes:import', join(root, 'dataset/surface.asc'), '--format', 'asc', '--metadata', join(root, 'dataset/surface.metadata.json'), '--measurement', join(root, 'measurement.json')]).withCwd(project).withTimeout(60000)
    expect(asc.exitCode).toBe(0)
    expect(JSON.parse(asc.stdout).report).toEqual(imported.report)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)


test('binary reader rejects unsafe paths, links, special files and oversized files with one safe error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-geotiff-reject-'))
  try {
    const source = join(root, 'PRIVATE_FILE_NAME.tif')
    await writeFile(source, primaryGeoTiffBytes())
    const linked = join(root, 'link.tif')
    await symlink(source, linked)
    const directory = join(root, 'directory')
    await mkdir(directory)
    const large = join(root, 'large.tif'), file = await open(large, 'wx')
    try { await file.truncate(8 * 1024 * 1024 + 1) }
    finally { await file.close() }
    const fifo = join(root, 'fifo.tif')
    const created = Bun.spawnSync(['mkfifo', fifo], { stdout: 'pipe', stderr: 'pipe' })
    expect(created.exitCode).toBe(0)
    let touched = false
    const nonPrimitive = { toString() { touched = true; throw new Error('PRIVATE_VALUE') } }
    for (const path of [null, undefined, nonPrimitive, '', linked, directory, large, fifo, join(root, 'missing-PRIVATE_FILE_NAME')]) {
      await expect(readGeoTiffFile(path as string)).rejects.toEqual(new Error('geotiff-file-unavailable'))
    }
    expect(touched).toBe(false)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 10000)

test('binary reader permits the exact byte limit and an empty regular file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-geotiff-file-bound-'))
  try {
    const path = join(root, 'limit.tif'), bytes = new Uint8Array(8 * 1024 * 1024)
    bytes[0] = 0xff; bytes[bytes.length - 1] = 0x80
    await writeFile(path, bytes)
    const actual = await readGeoTiffFile(path)
    expect(actual.byteLength).toBe(bytes.length)
    expect(actual.buffer.byteLength).toBe(bytes.length)
    expect(actual).toEqual(bytes)
    await writeFile(path, new Uint8Array())
    const empty = await readGeoTiffFile(path)
    expect(empty.byteLength).toBe(0)
    expect(empty.buffer.byteLength).toBe(0)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('native GeoTIFF rejection publishes no dataset or private input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-geotiff-private-'))
  const project = resolve(import.meta.dir, '../..')
  try {
    const source = join(root, 'PRIVATE_FILE_NAME.tif')
    await writeFile(source, new TextEncoder().encode('PRIVATE_SURVEY_VALUE'))
    await writeFile(join(root, 'declaration.json'), primaryGeoTiffDeclaration())
    await writeFile(join(root, 'measurement.json'), JSON.stringify(primaryGeoTiffMeasurement()))
    const args = ['volumes:import', source, '--format', 'geotiff', '--metadata', join(root, 'declaration.json'), '--measurement', join(root, 'measurement.json'), '--output', join(root, 'dataset')]
    const rejected = await command(args).withCwd(project).withTimeout(60000)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr).toContain('geotiff-surface-input')
    expect(rejected.stderr).not.toContain('PRIVATE_SURVEY_VALUE')
    expect(rejected.stdout).toBe('')
    await expect(stat(join(root, 'dataset'))).rejects.toThrow('ENOENT')
    await rm(source)
    const missing = await command(args).withCwd(project).withTimeout(60000)
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('geotiff-file-unavailable')
    expect(missing.stderr).not.toContain('PRIVATE_FILE_NAME')
    await expect(stat(join(root, 'dataset'))).rejects.toThrow('ENOENT')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 150000)
