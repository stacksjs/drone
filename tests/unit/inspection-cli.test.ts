import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exampleInspectionConfig } from '../../resources/functions/drone/inspection/fixtures'

test('native inspection commands plan, collect, bind an explicit operator review and compare actual visit recordings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-cli-'))
  try {
    const config = join(root, 'config.json')
    await writeFile(config, JSON.stringify(exampleInspectionConfig()))
    const plan = await command(['inspection:plan', config]).withTimeout(60000)
    expect(plan.exitCode).toBe(0)
    expect(JSON.parse(plan.stdout).stations).toHaveLength(3)
    const first = await command(['inspection:simulate', '--config', config, '--visit', 'before', '--output', join(root, 'before')]).withTimeout(60000)
    expect(first.exitCode).toBe(0)
    const baseline = JSON.parse(first.stdout)
    expect(baseline.qualifiedCaptures).toBe(3)
    expect(baseline.boardNeutral).toBe(true)
    const review = await command(['inspection:review', baseline.dataset.recording, '--id', 'qa-review', '--capture', 'capture-0001', '--reviewer', 'test-operator', '--reviewed-at', '2026-10-18T12:00:00.000Z', '--decision', 'needs-follow-up', '--modality', 'visible', '--x', '48', '--y', '36', '--note', 'Synthetic regression declaration, no human defect verification', '--output', join(root, 'reviewed')]).withTimeout(60000)
    expect(review.exitCode).toBe(0)
    const recorded = JSON.parse(review.stdout)
    expect(recorded.review.reviewerId).toBe('test-operator')
    expect(recorded.review.identityAuthenticated).toBe(false)
    expect(recorded.review.physicalDefectVerified).toBe(false)
    const reviews = JSON.parse(await readFile(join(recorded.dataset.directory, 'reviews.json'), 'utf8'))
    expect(reviews).toHaveLength(1)
    expect(reviews[0].captureSha256).toBe(recorded.review.captureSha256)
    expect((await stat(recorded.dataset.manifest)).mode & 0o777).toBe(0o600)
    const repeated = await command(['inspection:simulate', '--scenario', 'wind', '--visit', 'after', '--output', join(root, 'after')]).withTimeout(60000)
    expect(repeated.exitCode).toBe(0)
    const comparison = await command(['inspection:compare', baseline.dataset.recording, JSON.parse(repeated.stdout).dataset.recording]).withTimeout(60000)
    expect(comparison.exitCode).toBe(0)
    const matched = JSON.parse(comparison.stdout)
    expect(matched.pairs).toHaveLength(3)
    expect(matched.defectChangeDetermined).toBe(false)
    expect((await command(['inspection:compare', baseline.dataset.recording, baseline.dataset.recording]).withTimeout(60000)).exitCode).toBe(1)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)

test('native fault demonstrations reject premature runs and private malformed recordings stay out of errors', async () => {
  for (const scenario of ['gnss-loss', 'structure-motion', 'camera-loss'] as const) {
    const run = await command(['inspection:simulate', '--scenario', scenario]).withTimeout(60000)
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout).status).not.toBe('completed')
    expect(JSON.parse(run.stdout).boardNeutral).toBe(true)
  }
  for (const args of [['--seconds', 'nan'], ['--scenario', 'unknown'], ['--scenario', 'camera-loss', '--seconds', '8']]) expect((await command(['inspection:simulate', ...args]).withTimeout(60000)).exitCode).toBe(1)
  const root = await mkdtemp(join(tmpdir(), 'inspection-private-'))
  try {
    const path = join(root, 'private.json')
    await writeFile(path, '{"location":PRIVATE_ASSET_TOKEN}')
    const result = await command(['inspection:compare', path, path]).withTimeout(60000)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).not.toContain('PRIVATE_ASSET_TOKEN')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)
