import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exampleAgricultureConfig } from '../../resources/functions/drone/agriculture/fixtures'

test('native agriculture commands collect, reprocess and retain an explicit selected-animal declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agriculture-cli-'))
  try {
    const config = join(root, 'config.json')
    await writeFile(config, JSON.stringify(exampleAgricultureConfig()))
    const plan = await command(['agriculture:plan', config]).withTimeout(60000)
    expect(plan.exitCode, plan.stderr).toBe(0)
    expect(JSON.parse(plan.stdout).survey.areaM2).toBeCloseTo(2.56, 10)
    const collected = await command(['agriculture:simulate', '--config', config, '--output', join(root, 'collected')]).withTimeout(60000)
    expect(collected.exitCode, collected.stderr).toBe(0)
    const result = JSON.parse(collected.stdout)
    expect(result.captures).toBe(32)
    expect(result.boardNeutral).toBe(true)
    expect(result.physicalCalibrationVerified).toBe(false)
    const original = await readFile(result.dataset.recording, 'utf8')
    const processed = await command(['agriculture:process', result.dataset.recording]).withTimeout(60000)
    expect(processed.exitCode, processed.stderr).toBe(0)
    const layer = JSON.parse(processed.stdout).layer
    expect(layer.parcels).toHaveLength(2)
    expect(layer.physicalAgronomyVerified).toBe(false)
    expect(layer.observedAreaM2).toBeGreaterThan(0)
    const cell = layer.cells.find((c: { ndvi: number | null, parcelIds: string[], source: unknown }) => c.ndvi !== null && c.parcelIds.length && c.source)
    expect(cell).toBeDefined()
    const selected = await command(['agriculture:observe', result.dataset.recording, '--id', 'qa-observation', '--animal', 'qa-animal', '--capture', cell.source.captureId, '--x', String(cell.source.pixel[0]), '--y', String(cell.source.pixel[1]), '--observer', 'qa-operator', '--observed-at', '2026-10-18T12:00:00.000Z', '--note', 'Synthetic source-binding declaration. No animal identity verified.', '--output', join(root, 'observed')]).withTimeout(60000)
    expect(selected.exitCode, selected.stderr).toBe(0)
    const record = JSON.parse(selected.stdout)
    expect(record.observation.animalId).toBe('qa-animal')
    expect(record.observation.selection).toBe('explicit-operator-selected-animal')
    expect(record.observation.identityAuthenticated).toBe(false)
    expect(record.observation.physicalAnimalVerified).toBe(false)
    expect(record.observation.parcelIds.length).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(join(record.dataset.directory, 'livestock-observations.json'), 'utf8'))).toHaveLength(1)
    expect((await stat(record.dataset.manifest)).mode & 0o777).toBe(0o600)
    expect((await stat(record.dataset.directory)).mode & 0o777).toBe(0o700)
    expect(await readFile(result.dataset.recording, 'utf8')).toBe(original)
    const retained = await command(['agriculture:process', record.dataset.recording, '--observations', join(record.dataset.directory, 'livestock-observations.json'), '--output', join(root, 'reprocessed')]).withTimeout(60000)
    expect(retained.exitCode, retained.stderr).toBe(0)
    expect(JSON.parse(retained.stdout).observations).toBe(1)
    expect(JSON.parse(await readFile(join(root, 'reprocessed', 'livestock-observations.json'), 'utf8'))[0].captureSha256).toBe(record.observation.captureSha256)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)

test('native hazards reject premature runs and malformed field contents stay private', async () => {
  for (const scenario of ['irradiance-loss', 'band-skew', 'saturation', 'camera-loss', 'position-loss'] as const) {
    const result = await command(['agriculture:simulate', '--scenario', scenario]).withTimeout(60000)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).status).not.toBe('completed')
    expect(JSON.parse(result.stdout).boardNeutral).toBe(true)
  }
  for (const args of [['--seconds', 'nan'], ['--scenario', 'unknown'], ['--scenario', 'band-skew', '--seconds', '8']]) expect((await command(['agriculture:simulate', ...args]).withTimeout(60000)).exitCode).toBe(1)
  const root = await mkdtemp(join(tmpdir(), 'agriculture-private-'))
  try {
    const path = join(root, 'invalid.json')
    await writeFile(path, '{"field":PRIVATE_FIELD_TOKEN}')
    for (const name of ['agriculture:process', 'agriculture:plan']) {
      const result = await command([name, path]).withTimeout(60000)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).not.toContain('PRIVATE_FIELD_TOKEN')
    }
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)
