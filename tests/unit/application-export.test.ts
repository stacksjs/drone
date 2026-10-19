import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseApplicationRecording } from '../../resources/functions/drone/application/evidence'
import { writeApplicationDataset } from '../../resources/functions/drone/application/export'
import { simulateApplication } from '../../resources/functions/drone/application/runtime'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'

const paths: string[] = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
async function target() { const parent = await mkdtemp(join(tmpdir(), 'application-export-')); paths.push(parent); return join(parent, 'dataset') }
// Files/public export seam proves retained data, content hashes and exclusive
// completion. It does not prove physical application or hardware durability.
test('exports both inert implement units with separate measured and truth ledgers and exact content hashes', async () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    const run = simulateApplication({ config: exampleApplicationConfig(type), authorizeImplement: true, testMode: false }), directory = await target()
    expect(await writeApplicationDataset(directory, run)).toBe(directory)
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    expect(manifest.unit).toBe(type === 'sprayer' ? 'L' : 'kg')
    expect(manifest.physicalTrialEligible).toBe(false)
    expect(manifest.fullPhysicsReplayPerformed).toBe(false)
    for (const entry of manifest.files) {
      const bytes = await readFile(join(directory, entry.path))
      expect(bytes.length).toBe(entry.bytes)
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(entry.sha256)
    }
    expect(parseApplicationRecording(await readFile(join(directory, 'recording.json'), 'utf8'))).toEqual(run)
    const ledger = JSON.parse(await readFile(join(directory, 'measured-ledger.json'), 'utf8')), truth = JSON.parse(await readFile(join(directory, 'independent-truth.json'), 'utf8'))
    expect(ledger.evidence).toBe('recorded-qualified-host-meter-ledger')
    expect(truth.evidence).toBe('independent-modeled-plant-truth')
    expect(ledger.rows.length).toBe(run.inputs.length)
    expect(truth.releases).toEqual(run.releases)
    expect(truth.shutdown).toEqual(run.shutdown)
    const geometry = JSON.parse(await readFile(join(directory, 'cells.geojson'), 'utf8'))
    expect(geometry.features.every((cell: { geometry: { type: string } }) => cell.geometry.type === 'Point')).toBe(true)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, 'manifest.json'))).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).not.toContain('manifest.pending.json')
  }
})

test('invalid source accounting fails before I/O and asynchronous writes snapshot caller-owned data without overwrite', async () => {
  const run = simulateApplication({ authorizeImplement: true, testMode: false }), invalid = structuredClone(run), directory = await target()
  invalid.releases[0]!.amount += .01
  await expect(writeApplicationDataset(directory, invalid)).rejects.toThrow()
  await expect(stat(directory)).rejects.toThrow('ENOENT')
  const pending = writeApplicationDataset(directory, run), expectedReason = run.reason
  run.reason = 'Changed after export starts'; run.releases[0]!.amount += 1
  await pending
  const saved = parseApplicationRecording(await readFile(join(directory, 'recording.json'), 'utf8'))
  expect(saved.reason).toBe(expectedReason)
  const manifest = await readFile(join(directory, 'manifest.json'), 'utf8')
  await expect(writeApplicationDataset(directory, saved)).rejects.toThrow('EEXIST')
  expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe(manifest)
})
