import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { examplePublicSafetyConfig } from '../../resources/functions/drone/public-safety/fixtures'

// Native command seam verifies private portable evidence and replay; numeric geometry/physics have independent function tests.
test('native public-safety commands plan, collect and replay bounded incident evidence without physical authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-public-safety-cli-'))
  try {
    const invoke = (args: string[]) => command(args).withTimeout(60000)
    const config = join(root, 'config.json'), directory = join(root, 'collected')
    await writeFile(config, JSON.stringify(examplePublicSafetyConfig()))
    const planned = await invoke(['public-safety:plan', config])
    expect(planned.exitCode).toBe(0)
    expect(JSON.parse(planned.stdout).sectorId).toBe(examplePublicSafetyConfig().sectorId)
    const collected = await invoke(['public-safety:simulate', '--config', config, '--output', directory])
    expect(collected.exitCode).toBe(0)
    const result = JSON.parse(collected.stdout)
    expect(result.status).toBe('completed')
    expect(result.captures).toBeGreaterThan(0)
    expect(result.identityAuthenticated).toBe(false)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(join(directory, 'recording.json'))).mode & 0o777).toBe(0o600)
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    expect(manifest.retentionDeletionEnforced).toBe(false)
    for (const file of manifest.files) {
      const bytes = await readFile(join(directory, file.path))
      expect(bytes.length).toBe(file.bytes)
      expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(file.sha256)
    }
    const thermalPath = manifest.images[0].thermal
    const thermal = await readFile(join(directory, thermalPath))
    const source = JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8'))
    const sampleIndex = source.captures[0].thermalCentiKelvin.findIndex((value: number) => value === 29315)
    expect(sampleIndex).toBeGreaterThanOrEqual(0)
    expect(thermal.readUInt16LE(sampleIndex * 2)).toBe(29315)
    expect(thermal[sampleIndex * 2]).toBe(0x83)
    expect(thermal[sampleIndex * 2 + 1]).toBe(0x72)
    const replay = await invoke(['public-safety:replay', join(directory, 'recording.json'), '--at-ms', '600'])
    expect(replay.exitCode).toBe(0)
    expect(JSON.parse(replay.stdout).confirmedCaptures).toBe(0)
    expect(JSON.parse(replay.stdout).verified).toBe(true)
    expect((await invoke(['public-safety:replay', join(directory, 'recording.json'), '--at-ms', '601'])).exitCode).toBe(1)
    expect((await invoke(['public-safety:simulate', '--output', directory])).exitCode).toBe(1)
    for (const scenario of ['link-loss', 'boundary-change', 'endurance-change']) {
      const stopped = await invoke(['public-safety:simulate', '--scenario', scenario])
      expect(stopped.exitCode).toBe(0)
      expect(JSON.parse(stopped.stdout).faultDemonstrated).toBe(true)
    }
    const malformed = join(root, 'malformed.json')
    await writeFile(malformed, '{private-incident-note')
    const denied = await invoke(['public-safety:plan', malformed])
    expect(denied.exitCode).toBe(1)
    expect(denied.stderr).not.toContain('private-incident-note')
    const nullConfig = join(root, 'null.json'), nullDirectory = join(root, 'null-dataset')
    await writeFile(nullConfig, 'null')
    expect((await invoke(['public-safety:simulate', '--config', nullConfig, '--output', nullDirectory])).exitCode).toBe(1)
    expect(await stat(nullDirectory).catch(() => null)).toBeNull()
    expect((await invoke(['public-safety:simulate', '--purpose', 'pursuit'])).exitCode).toBe(1)
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 180000)
