import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { primaryLasBytes, primaryLasDeclaration, primaryLasMeasurement, primaryLasSha256 } from '../fixtures/volumes/las'
import { importLasSurface } from '../../resources/functions/drone/volumes/las'
import { validateVolumeRequest } from '../../resources/functions/drone/volumes/engine'
import { writeVolumeDataset } from '../../resources/functions/drone/volumes/export'

test('native LAS import retains exact source, declaration and grid evidence with a replayable volume dataset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-las-import-'))
  try {
    const raw = primaryLasBytes(), declaration = primaryLasDeclaration(), source = join(root, 'points.las'), metadata = join(root, 'declaration.json'), measurement = join(root, 'measurement.json'), output = join(root, 'dataset')
    await writeFile(source, raw); await writeFile(metadata, declaration); await writeFile(measurement, JSON.stringify(primaryLasMeasurement()))
    const result = await command(['volumes:import', source, '--format', 'las', '--metadata', metadata, '--measurement', measurement, '--output', output]).withTimeout(30000)
    expect(result.exitCode).toBe(0)
    const imported = JSON.parse(result.stdout)
    expect(imported.report.aboveBaseM3).toBe(18)
    expect(imported.report.coveredAreaM2).toBe(3)
    expect(imported.report.fullBoundarySignedM3).toBeNull()
    expect(imported.sourceProcessing.selectedPointCount).toBe(5)
    expect(imported.sourceProcessing.cells).toBeUndefined()
    expect(await readFile(join(output, 'source.las'))).toEqual(Buffer.from(raw))
    expect(await readFile(join(output, 'source.declaration.json'), 'utf8')).toBe(declaration)
    const processing = JSON.parse(await readFile(join(output, 'source.gridding.json'), 'utf8'))
    expect(processing.cells.map((c: { meanM: number | null }) => c.meanM)).toEqual([3, 6, 9, null])
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    expect(manifest.originalSourceSha256).toBe(primaryLasSha256)
    expect(manifest.sourceProcessing.format).toBe('las')
    for (const f of manifest.files) {
      const bytes = await readFile(join(output, f.path))
      expect(bytes.length).toBe(f.bytes)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256)
    }
    const replay = await command(['volumes:process', join(output, 'request.json')]).withTimeout(30000)
    expect(replay.exitCode).toBe(0)
    expect(JSON.parse(replay.stdout).report).toEqual(imported.report)
    const again = await command(['volumes:import', join(output, 'source.las'), '--format', 'las', '--metadata', join(output, 'source.declaration.json'), '--measurement', measurement]).withTimeout(30000)
    expect(again.exitCode).toBe(0)
    expect(JSON.parse(again.stdout).report).toEqual(imported.report)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 100000)

test('publication snapshots exact LAS bytes and refuses mismatched geometry or accessor evidence before creating a dataset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-las-publication-'))
  try {
    const bytes = primaryLasBytes(), declarationJson = primaryLasDeclaration(), imported = await importLasSurface(bytes, declarationJson)
    const request = validateVolumeRequest({ ...primaryLasMeasurement(), surface: imported.surface })
    const pending = writeVolumeDataset(join(root, 'valid'), request, { format: 'las', bytes, declarationJson })
    bytes.fill(0)
    await pending
    expect(await readFile(join(root, 'valid/source.las'))).toEqual(Buffer.from(primaryLasBytes()))
    const changed = structuredClone(request)
    if (changed.surface.geometry.kind === 'cell-grid') changed.surface.geometry.rows[0]![0] = 4
    await expect(writeVolumeDataset(join(root, 'changed'), changed, { format: 'las', bytes: primaryLasBytes(), declarationJson })).rejects.toThrow('las-dataset-source-mismatch')
    expect(await Bun.file(join(root, 'changed/manifest.json')).exists()).toBe(false)
    let invoked = 0
    const unsafe = { format: 'las' as const, declarationJson, get bytes() { invoked++; return primaryLasBytes() } }
    await expect(writeVolumeDataset(join(root, 'accessor'), request, unsafe)).rejects.toThrow('las-dataset-source-input')
    expect(invoked).toBe(0)
    expect(await Bun.file(join(root, 'accessor/manifest.json')).exists()).toBe(false)
  }
  finally { await rm(root, { recursive: true, force: true }) }
})

test('native LAS failures do not expose private file or declaration contents or publish a completion marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-las-private-'))
  try {
    const source = join(root, 'PRIVATE_POINTS.las'), metadata = join(root, 'PRIVATE_DECLARATION.json'), measurement = join(root, 'measurement.json'), output = join(root, 'failed')
    await writeFile(metadata, 'PRIVATE_INPUT_BODY'); await writeFile(measurement, JSON.stringify(primaryLasMeasurement()))
    const result = await command(['volumes:import', source, '--format', 'las', '--metadata', metadata, '--measurement', measurement, '--output', output]).withTimeout(30000)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('las-file-unavailable')
    expect(result.stderr).not.toContain('PRIVATE')
    await writeFile(source, primaryLasBytes())
    const malformed = await command(['volumes:import', source, '--format', 'las', '--metadata', metadata, '--measurement', measurement, '--output', output]).withTimeout(30000)
    expect(malformed.exitCode).toBe(1)
    expect(malformed.stdout).toBe('')
    expect(malformed.stderr).toContain('las-surface-input')
    expect(malformed.stderr).not.toContain('PRIVATE')
    expect(await Bun.file(join(output, 'manifest.json')).exists()).toBe(false)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 70000)

// Real command/filesystem seam: missing sidecars and failed publication must not
// disclose operator paths. This does not establish filesystem power-loss durability.
test('native LAS metadata, measurement and output filesystem failures retain fixed private diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-las-private-files-'))
  try {
    const source = join(root, 'PRIVATE_POINTS.las'), metadata = join(root, 'PRIVATE_DECLARATION.json'), measurement = join(root, 'PRIVATE_MEASUREMENT.json'), output = join(root, 'PRIVATE_OUTPUT')
    await writeFile(source, primaryLasBytes()); await writeFile(measurement, JSON.stringify(primaryLasMeasurement()))
    const run = () => command(['volumes:import', source, '--format', 'las', '--metadata', metadata, '--measurement', measurement, '--output', output]).withTimeout(30000)
    const missingDeclaration = await run()
    expect(missingDeclaration.exitCode).toBe(1)
    expect(missingDeclaration.stdout).toBe('')
    expect(missingDeclaration.stderr).toBe('las-import-unavailable\n')
    expect(missingDeclaration.stderr).not.toContain('PRIVATE')
    await writeFile(metadata, primaryLasDeclaration()); await rm(measurement)
    const missingMeasurement = await run()
    expect(missingMeasurement.exitCode).toBe(1)
    expect(missingMeasurement.stdout).toBe('')
    expect(missingMeasurement.stderr).toBe('las-import-unavailable\n')
    expect(missingMeasurement.stderr).not.toContain('PRIVATE')
    await writeFile(measurement, JSON.stringify(primaryLasMeasurement())); await writeFile(output, 'PRIVATE_EXISTING_FILE')
    const blockedOutput = await run()
    expect(blockedOutput.exitCode).toBe(1)
    expect(blockedOutput.stdout).toBe('')
    expect(blockedOutput.stderr).toBe('las-import-unavailable\n')
    expect(blockedOutput.stderr).not.toContain('PRIVATE')
    expect(await readFile(output, 'utf8')).toBe('PRIVATE_EXISTING_FILE')
    expect(await Bun.file(join(output, 'manifest.json')).exists()).toBe(false)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 100000)
