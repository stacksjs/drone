import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { renderPublicSafetyDataset, writePublicSafetyDataset } from '../../resources/functions/drone/public-safety/export'
import { simulatePublicSafety } from '../../resources/functions/drone/public-safety/runtime'
import { publicSafetyRecordingData } from '../../resources/functions/drone/public-safety/evidence'

// Public renderer/offline output catches changed source-derived bytes; it does not qualify DB/Auth or power loss.
test('shared public-safety renderer preserves real offline recording, derivatives and unsigned manifest', async () => {
  const run = simulatePublicSafety({ seconds: 10 })
  const rendered = await renderPublicSafetyDataset(run)
  expect(rendered.files.find(file => file.path === 'recording.json')!.contents).toBe(`${publicSafetyRecordingData(run)}\n`)
  const manifest = JSON.parse(rendered.manifestJson)
  expect(manifest.identityAuthenticated).toBe(false)
  expect(manifest.retentionDeletionEnforced).toBe(false)
  expect(manifest.physicalThermalVerified).toBe(false)
  expect(manifest.images.length).toBeGreaterThan(0)
  const directory = await mkdtemp(join(tmpdir(), 'drone-managed-render-'))
  try {
    await writePublicSafetyDataset(join(directory, 'offline'), run)
    expect(await readFile(join(directory, 'offline/manifest.json'), 'utf8')).toBe(rendered.manifestJson)
    for (const file of rendered.files) {
      const actual = await readFile(join(directory, 'offline', file.path))
      expect(actual).toEqual(Buffer.from(file.contents))
      expect(createHash('sha256').update(actual).digest('hex')).toBe(manifest.files.find((entry: { path: string }) => entry.path === file.path).sha256)
    }
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
