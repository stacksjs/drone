import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exampleVolumeRequest } from '../../resources/functions/drone/volumes/fixtures'

async function fixture(root: string) {
  const text = 'ncols 2\nnrows 2\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n1 2\n3 4\n'
  const request = exampleVolumeRequest()
  const metadata = structuredClone(request.surface.metadata)
  metadata.id = 'literal-grid'
  metadata.provenance.sourceSha256 = new Bun.CryptoHasher('sha256').update(text).digest('hex')
  const measurement = { version: 1, id: 'literal-grid-measurement', boundary: { outer: [[0, 0], [2, 0], [2, 2], [0, 2]], holes: [] }, base: request.base, reference: null }
  await writeFile(join(root, 'surface.asc'), text)
  await writeFile(join(root, 'metadata.json'), JSON.stringify(metadata))
  await writeFile(join(root, 'measurement.json'), JSON.stringify(measurement))
  return text
}
test('native import must bind metadata to original bytes and reject a stripped BOM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volumes-bom-'))
  try {
    const text = await fixture(root)
    await writeFile(join(root, 'surface.asc'), `\uFEFF${text}`)
    const output = await command(['volumes:import', join(root, 'surface.asc'), '--format', 'asc', '--metadata', join(root, 'metadata.json'), '--measurement', join(root, 'measurement.json'), '--output', join(root, 'dataset')]).withTimeout(60000)
    expect(output.exitCode).toBe(1)
    await expect(stat(join(root, 'dataset'))).rejects.toThrow('ENOENT')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 90000)

test('native commands import numeric grids, publish complete datasets and reprocess the retained request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volumes-cli-'))
  try {
    await fixture(root)
    const args = ['volumes:import', join(root, 'surface.asc'), '--format', 'asc', '--metadata', join(root, 'metadata.json'), '--measurement', join(root, 'measurement.json')]
    const imported = await command([...args, '--output', join(root, 'dataset')]).withTimeout(60000)
    expect(imported.exitCode).toBe(0)
    const result = JSON.parse(imported.stdout)
    expect(result.report.aboveBaseM3).toBe(10)
    expect(result.report.coveredAreaM2).toBe(4)
    expect(result.report.physicalAccuracyVerified).toBe(false)
    const manifest = JSON.parse(await readFile(result.dataset.manifest, 'utf8'))
    for (const entry of manifest.files) {
      const bytes = await readFile(join(result.dataset.directory, entry.path))
      expect(bytes.length).toBe(entry.bytes)
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    }
    const processed = await command(['volumes:process', join(root, 'dataset/request.json')]).withTimeout(60000)
    expect(processed.exitCode).toBe(0)
    expect(JSON.parse(processed.stdout).report).toEqual(result.report)
    expect((await stat(result.dataset.manifest)).mode & 0o777).toBe(0o600)
    expect((await command([...args, '--output', join(root, 'dataset')]).withTimeout(60000)).exitCode).toBe(1)
    const broken = 'PRIVATE_SURVEY_TOKEN 2\n'
    const metadata = JSON.parse(await readFile(join(root, 'metadata.json'), 'utf8'))
    metadata.provenance.sourceSha256 = new Bun.CryptoHasher('sha256').update(broken).digest('hex')
    await writeFile(join(root, 'surface.asc'), broken)
    await writeFile(join(root, 'metadata.json'), JSON.stringify(metadata))
    const rejected = await command(args).withTimeout(60000)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr.toLowerCase()).not.toContain('private_survey_token')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)

test('native analytic examples distinguish cut/fill, missing coverage and unknown error before PLY reimport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volumes-scenarios-'))
  try {
    for (const scenario of ['cut-fill', 'coverage-gap', 'unknown-uncertainty', 'reference-comparison'] as const) {
      const run = await command(['volumes:demo', '--scenario', scenario]).withTimeout(60000)
      expect(run.exitCode).toBe(0)
      const { report } = JSON.parse(run.stdout)
      if (scenario === 'cut-fill') { expect(report.aboveBaseM3).toBeCloseTo(.5, 12); expect(report.belowBaseM3).toBeCloseTo(.5, 12) }
      if (scenario === 'coverage-gap') { expect(report.status).toBe('partial-coverage'); expect(report.fullBoundarySignedM3).toBeNull() }
      if (scenario === 'unknown-uncertainty') expect(report.uncertainty.conditionalVerticalBoundM3).toBeNull()
      if (scenario === 'reference-comparison') { expect(report.comparison.status).toBe('synthetic-comparison'); expect(report.comparison.signedDifferenceM3).toBe(0) }
    }
    const run = await command(['volumes:demo', '--output', join(root, 'pyramid')]).withTimeout(60000)
    expect(run.exitCode).toBe(0)
    const request = exampleVolumeRequest()
    await writeFile(join(root, 'measurement.json'), JSON.stringify({ version: request.version, id: request.id, boundary: request.boundary, base: request.base, reference: null }))
    const reimport = await command(['volumes:import', join(root, 'pyramid/surface.ply'), '--format', 'ply', '--metadata', join(root, 'pyramid/surface.metadata.json'), '--measurement', join(root, 'measurement.json')]).withTimeout(60000)
    expect(reimport.exitCode).toBe(0)
    expect(JSON.parse(reimport.stdout).report.fullBoundarySignedM3).toBe(16)
    expect((await command(['volumes:demo', '--scenario', 'unknown']).withTimeout(60000)).exitCode).toBe(1)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)

// Native CLI seam catches error presentation; it does not validate survey acquisition.
test('native processing rejects malformed private JSON without echoing its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'volumes-private-json-'))
  try {
    const path = join(root, 'request.json')
    await writeFile(path, '{"secret":PRIVATE_SURVEY_TOKEN}')
    const rejected = await command(['volumes:process', path]).withTimeout(60000)
    expect(rejected.exitCode).toBe(1)
    expect(rejected.stderr).not.toContain('PRIVATE_SURVEY_TOKEN')
    expect(rejected.stderr).not.toContain('secret')
    expect(rejected.stderr).toContain('Invalid volume request JSON')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 90000)
