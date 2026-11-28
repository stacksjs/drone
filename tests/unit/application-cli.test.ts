import { expect, test } from 'bun:test'
import { command } from '@stacksjs/testing'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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

test('native aerial planning preserves exclusions, budgets return and rejects an inadmissible load', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drone-aerial-plan-'))
  try {
    const fixture = resolve('examples/application-aerial-water.json')
    const invoke = (path: string) => command(['application:plan', path, '--vehicle', 'quadcopter']).withTimeout(30000)
    const planned = await invoke(fixture)
    expect(planned.exitCode).toBe(0)
    const plan = JSON.parse(planned.stdout)
    expect(plan.mission.vehicle).toBe('quadcopter')
    expect(plan.mission.tasks.map((task: { id: string }) => task.id)).toEqual(['start', 'takeoff', 'approach', 'apply-1', 'home', 'land'])
    expect(plan.mission.tasks.find((task: { id: string }) => task.id === 'apply-1').positionM).toEqual([6, 0, -1.2])
    expect(plan.excludedAreaM2).toBeCloseTo(.48, 12)
    expect(plan.prescribedAmount).toBeCloseTo(.1904, 12)
    expect(plan.inventorySufficient).toBe(true)
    expect(plan.load.emptySystemMassKg).toBeCloseTo(1.59, 12)
    expect(plan.load.takeoffMassKg).toBeCloseTo(1.79, 12)
    expect(plan.powerBudget.pumpWh).toBeGreaterThan(0)
    expect(plan.powerBudget.marginWh).toBeGreaterThan(0)
    expect(plan.physicalTrialEligible).toBe(false)

    const original = JSON.parse(await readFile(fixture, 'utf8'))
    const invalid = join(root, 'invalid.json')
    for (const [overrides, error] of [
      [{ tankCapacityL: .1 }, 'water level exceeds declared capacity'],
      [{ tankMassKg: .8, mountingMassKg: .8 }, 'cannot preserve collective thrust margin'],
      [{ availableWh: 5 }, 'cannot preserve energy reserve'],
      [{ evidence: 'measured' }, 'requires declared synthetic centered mounting'],
    ] as const) {
      await writeFile(invalid, JSON.stringify({ ...original, aircraft: { ...original.aircraft, ...overrides } }))
      const refused = await invoke(invalid)
      expect(refused.exitCode).toBe(1)
      expect(refused.stderr).toContain(error)
    }
  }
  finally { await rm(root, { recursive: true, force: true }) }
}, 90000)
