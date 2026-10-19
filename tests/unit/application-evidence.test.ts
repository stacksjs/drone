import { expect, test } from 'bun:test'
import type { ApplicationRun } from '../../resources/functions/drone/application/runtime-types'
import { applicationRecordingJson, parseApplicationRecording, validateApplicationRun } from '../../resources/functions/drone/application/evidence'
import { processApplication } from '../../resources/functions/drone/application/coverage'
import { simulateApplication } from '../../resources/functions/drone/application/runtime'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'

// Public recording seam replays retained mission and qualified implement
// inputs. It establishes unsigned consistency, not sensor/producer identity,
// physical actuation, whole sensor replay or cross-platform physics equality.
test('both actual metering implementations replay detached recordings and explicit native diagnostic IDs', () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    const run = simulateApplication({ config: exampleApplicationConfig(type), authorizeImplement: true, testMode: false })
    const recording = applicationRecordingJson(run), restored = parseApplicationRecording(recording)
    expect(restored).toEqual(run)
    expect(restored.vehicle.board.bootId).toBe(55n)
    expect(restored.vehicle.authority.sessionId).toBe(123n)
    expect(restored.inputs).not.toBe(run.inputs)
    expect(Buffer.byteLength(recording)).toBeLessThan(16 * 1024 * 1024)
    const report = processApplication(restored)
    expect(report.emittedAmount).toBeCloseTo(run.final.emittedAmount, 10)
    expect(Math.abs(report.conservationError)).toBeLessThan(1e-8)
    expect(report.coveredAreaM2).toBeGreaterThan(0)
    expect(report.overlapAreaM2).toBeLessThanOrEqual(report.coveredAreaM2 + 1e-8)
  }
})

test('rejects tampered control replay, feedback scope, independent release and inventory evidence', () => {
  const original = simulateApplication({ authorizeImplement: true, testMode: false })
  const mutations: ((run: ApplicationRun) => void)[] = [
    run => { run.decisions[100]!.reason = 'changed-decision' },
    run => { run.inputs[100]!.reference = '99:0,0,0,0,0' },
    run => { run.inputs[100]!.feedback!.pulseCount += 1 },
    run => { run.vehicle.trace.rows[100]!.result.reason = 'edited-mission' },
    run => { run.releases[0]!.amount += .01 },
    run => { run.releases[0]!.positionM[0] += .1 },
    run => { run.releases[0]!.taskId = 'apply-forged' },
    run => { run.releases[0]!.windMps[0] += 1 },
    run => { run.final.remainingAmount += 1 },
    run => { run.reason = 'fabricated-reason' },
    run => { Object.assign(run.vehicle.authority.events[0]!, { authenticated: true }) },
    run => { run.vehicle.scenario = 'weather' },
    run => { run.shutdown.closureVerified = !run.shutdown.closureVerified },
    run => { run.probes[100]!.state.emittedAmount += .1 },
    run => { Object.assign(run.inputs[100]!, { producerAuthenticated: true }) },
  ]
  for (const mutate of mutations) { const run = structuredClone(original); mutate(run); expect(() => { validateApplicationRun(run) }).toThrow() }
})

test('rejects unbounded, shared, accessor and malformed uint64 input without implicit scalar coercion', () => {
  expect(() => parseApplicationRecording('x'.repeat(16 * 1024 * 1024 + 1))).toThrow('16 MiB')
  expect(() => parseApplicationRecording('private source text')).toThrow('Invalid application recording JSON')
  expect(() => validateApplicationRun({ get value() { throw new Error('private accessor invoked') } })).toThrow('accessor')
  expect(() => validateApplicationRun({ value: new Uint8Array(new SharedArrayBuffer(4)) })).toThrow('unsupported memory')
  const original = simulateApplication({ seconds: 2 }), encoded = applicationRecordingJson(original)
  expect(() => parseApplicationRecording(encoded.replace('"$applicationUint64":"55"', '"$applicationUint64":"055"'))).toThrow('uint64')
})

test('actual fault and dry recordings preserve all prior material, host-loss boundaries and independent tail evidence', () => {
  for (const type of ['sprayer', 'spreader'] as const) for (const scenario of ['empty', 'stuck-valve', 'master-stuck', 'blocked-flow', 'meter-loss', 'meter-replay', 'weather', 'manual', 'host-loss', 'emergency', 'localization-loss', 'guard-open', 'lease-expiry'] as const) {
    const run = simulateApplication({ config: exampleApplicationConfig(type), scenario, authorizeImplement: true, testMode: false })
    expect(validateApplicationRun(run).status).toBe(run.status)
    expect(run.final.emittedAmount).toBeGreaterThan(0)
    expect(run.faultDemonstrated).toBe(true)
    if (scenario === 'host-loss') {
      const lastHost = run.inputs.at(-1)!.atMs
      expect(run.probes.some(probe => probe.atMs > lastHost && !probe.hostAvailable)).toBe(true)
      expect(run.releases.filter(release => release.atMs > lastHost).every(release => !release.hostAvailable && release.taskId === null)).toBe(true)
    }
    if (scenario === 'master-stuck') expect(run.shutdown.closureVerified).toBe(false)
  }
  for (const options of [{}, { authorizeImplement: true }, { authorizeImplement: true, testMode: false, seconds: 2 }] as const) {
    const run = simulateApplication(options)
    expect(parseApplicationRecording(applicationRecordingJson(run))).toEqual(run)
    expect(run.final.emittedAmount).toBe(0)
  }
}, 30000)


test('actual authorized zero-discharge completion preserves all missing support and no invented delivery', () => {
  const config = exampleApplicationConfig(); config.prescription = []
  const run = simulateApplication({ config, authorizeImplement: true, testMode: false })
  expect(run.status).toBe('completed')
  expect(run.reason).toBe('application-no-material-discharged')
  expect(parseApplicationRecording(applicationRecordingJson(run))).toEqual(run)
  const report = processApplication(run)
  expect(report.emittedAmount).toBe(0)
  expect(report.coveredAreaM2).toBe(0)
  expect(report.missedAreaM2).toBeCloseTo(report.treatableAreaM2, 10)
})
