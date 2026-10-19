import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'

// Real native commands verify application orchestration and private artifacts.
// Numerical deposition, source replay and hardware evidence have separate public seams.
test('native commands plan, meter both inert materials, reprocess exact cells and replay actual epochs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-application-cli-'))
  try {
    const invoke = (args: string[]) => command(args).withTimeout(60000)
    for (const type of ['sprayer', 'spreader'] as const) {
      const config = join(root, `${type}.json`)
      await writeFile(config, JSON.stringify(exampleApplicationConfig(type)))
      const planned = await invoke(['application:plan', config])
      expect(planned.exitCode).toBe(0)
      const plan = JSON.parse(planned.stdout)
      expect(plan.fieldAreaM2).toBe(10)
      expect(plan.prescribedAmount).toBeCloseTo(type === 'sprayer' ? .2 : .1, 12)
      expect(plan.physicalTrialEligible).toBe(false)
      const directory = join(root, `${type}-collected`)
      const applied = await invoke(['application:simulate', '--implement', type, '--mode', 'apply', '--authorize-implement', '--output', directory])
      expect(applied.exitCode).toBe(0)
      const result = JSON.parse(applied.stdout)
      expect(result.status).toBe('completed')
      expect(result.unit).toBe(type === 'sprayer' ? 'L' : 'kg')
      expect(result.emittedAmount).toBeGreaterThan(0)
      expect(result.shutdown.closureVerified).toBe(true)
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'recording.json'))).mode & 0o777).toBe(0o600)
      const processed = await invoke(['application:process', join(directory, 'recording.json')])
      expect(processed.exitCode).toBe(0)
      expect(JSON.parse(processed.stdout).report).toEqual(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8')))
      const replay = await invoke(['application:replay', join(directory, 'recording.json')])
      expect(replay.exitCode).toBe(0)
      expect(JSON.parse(replay.stdout).hostObservationAvailable).toBe(true)
      const tail = await invoke(['application:replay', join(directory, 'recording.json'), '--at-ms', String(result.shutdown.finalAtMs)])
      expect(tail.exitCode).toBe(0)
      const selected = JSON.parse(tail.stdout)
      expect(selected.input).toBeNull()
      expect(selected.decision).toBeNull()
      expect(selected.hostObservationAvailable).toBe(false)
      expect(selected.independentModeledProbe.atMs).toBe(result.shutdown.finalAtMs)
      expect((await invoke(['application:process', join(directory, 'recording.json'), '--output', directory])).exitCode).toBe(1)
      expect((await invoke(['application:replay', join(directory, 'recording.json'), '--at-ms', '601'])).exitCode).toBe(1)
    }
    const dry = await invoke(['application:simulate'])
    expect(dry.exitCode).toBe(0)
    expect(JSON.parse(dry.stdout).status).toBe('dry-completed')
    expect(JSON.parse(dry.stdout).emittedAmount).toBe(0)
    const isolation = await invoke(['application:simulate', '--mode', 'apply', '--authorize-implement', '--scenario', 'master-stuck'])
    expect(isolation.exitCode).toBe(0)
    expect(JSON.parse(isolation.stdout).shutdown.closureVerified).toBe(false)
    expect(JSON.parse(isolation.stdout).faultDemonstrated).toBe(true)
    expect((await invoke(['application:simulate', '--mode', 'apply', '--authorize-implement', '--scenario', 'host-loss', '--seconds', '2'])).exitCode).toBe(1)
    for (const args of [['--mode', 'live'], ['--seconds', 'nan'], ['--scenario', 'unknown'], ['--implement', 'unknown']])
      expect((await invoke(['application:simulate', ...args])).exitCode).toBe(1)
    const broken = join(root, 'broken.json')
    await writeFile(broken, '{private-application-location')
    const invalid = await invoke(['application:plan', broken])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr).toContain('Invalid application configuration JSON')
    expect(invalid.stderr).not.toContain('private-application-location')
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 240000)
