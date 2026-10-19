import { expect, test } from 'bun:test'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { validateApplicationConfig } from '../../resources/functions/drone/application/planner'
import { simulateApplication } from '../../resources/functions/drone/application/runtime'
import { processApplication } from '../../resources/functions/drone/application/coverage'
import { applicationRecordingJson, parseApplicationRecording, validateApplicationRun } from '../../resources/functions/drone/application/evidence'

test('configuration rejects inherited array iteration before invoking an untrusted hook', () => {
  const config = exampleApplicationConfig()
  let invoked = false
  const inherited = Object.create(Array.prototype)
  Object.defineProperty(inherited, Symbol.iterator, { value() { invoked = true; throw new Error('PRIVATE_INHERITED_ITERATOR') } })
  Object.setPrototypeOf(config.boundary, inherited)
  expect(() => validateApplicationConfig(config)).toThrow('prototype')
  expect(invoked).toBe(false)
})

test('accepted long closure and slow energy calibration produce independently verified replayable shutdown for both materials', () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    for (const response of ['normal', 'slow-energy', 'slow-barriers'] as const) {
      const config = exampleApplicationConfig(type)
      config.boundary = [[-2, -2], [2, -2], [2, 2], [-2, 2]]
      config.prescription[0]!.polygon = config.boundary.map(point => [...point])
      config.routeM = [[-1, 0], [0, 0]]
      config.calibration.closingAllowanceMs = 10000
      if (response !== 'normal') config.calibration.energyTauMs = 1000
      if (response === 'slow-barriers') {
        config.boundary = [[-8, -8], [8, -8], [8, 8], [-8, 8]]
        config.prescription[0]!.polygon = config.boundary.map(point => [...point])
        config.gridResolutionM = 1
        config.calibration.primaryCloseMs = 2000
        config.calibration.masterCloseMs = 2000
        config.calibration.noFlowTimeoutMs = 5000
        config.implement.fallTimeS = 2
      }
      const run = simulateApplication({ config, authorizeImplement: true, testMode: false })
      expect(run.status).toBe('completed')
      expect(run.shutdown.closureVerified).toBe(true)
      expect(run.shutdown.finalAtMs - run.inputs.at(-1)!.atMs).toBeGreaterThanOrEqual(10000)
      if (response === 'slow-barriers') {
        expect(run.final.emittedAmount).toBeGreaterThan(0)
        expect(run.shutdown.finalAtMs - run.inputs.at(-1)!.atMs).toBe(12200)
      }
      const restored = parseApplicationRecording(applicationRecordingJson(run))
      expect(restored).toEqual(run)
      expect(Math.abs(processApplication(restored).conservationError)).toBeLessThan(1e-8)
    }
  }
}, 60000)

test('zero prescriptions stay deliberately off and mixed zones can apply only their positive prescribed support', () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    const config = exampleApplicationConfig(type)
    const positiveRate = config.prescription[0]!.ratePerHa
    config.prescription[0]!.ratePerHa = 0
    const zero = simulateApplication({ config, authorizeImplement: true, testMode: false })
    expect(zero.status).toBe('completed')
    expect(zero.final.emittedAmount).toBe(0)
    expect(zero.decisions.every(decision => decision.channels.every(value => value === 0))).toBe(true)
    expect(zero.decisions.some(decision => decision.state === 'latched')).toBe(false)
    expect(validateApplicationRun(zero).status).toBe('completed')
    config.prescription = [
      { id: 'zero-zone', polygon: [[1, -1], [3.5, -1], [3.5, 1], [1, 1]], ratePerHa: 0 },
      { id: 'positive-zone', polygon: [[3.5, -1], [6, -1], [6, 1], [3.5, 1]], ratePerHa: positiveRate },
    ]
    const mixed = simulateApplication({ config, authorizeImplement: true, testMode: false })
    expect(mixed.status).toBe('completed')
    expect(mixed.final.emittedAmount).toBeGreaterThan(0)
    const zeroDecisions = mixed.decisions.filter(decision => decision.prescriptionId === 'zero-zone')
    expect(zeroDecisions.length).toBeGreaterThan(0)
    expect(zeroDecisions.every(decision => decision.targetPerSecond === 0 && decision.channels.every(value => value === 0))).toBe(true)
    expect(mixed.decisions.some(decision => decision.prescriptionId === 'positive-zone' && decision.targetPerSecond > 0)).toBe(true)
    expect(validateApplicationRun(mixed).status).toBe('completed')
  }
})

test('recorded shutdown request and residual amount must join the actual last application stop', () => {
  const run = simulateApplication({ authorizeImplement: true, testMode: false })
  expect(run.shutdown.emittedAfterRequest).toBeGreaterThan(0)
  run.shutdown.requestedAtMs = run.inputs.at(-1)!.atMs
  run.shutdown.emittedAfterRequest = 0
  expect(() => { validateApplicationRun(run) }).toThrow()
})

test('vehicle host truth positions and final truth must match the independent actual plant probes', () => {
  const run = simulateApplication({ authorizeImplement: true, testMode: false })
  expect(run.probes[0]!.atMs).toBe(600)
  for (const where of ['initial', 'host', 'final'] as const) {
    const changed = structuredClone(run)
    if (where === 'initial') changed.vehicle.path[0]!.truthPositionM = [900, 900, 900]
    if (where === 'host') changed.vehicle.path[100]!.truthPositionM = [900, 900, 900]
    if (where === 'final') changed.vehicle.finalTruthPositionM = [900, 900, 900]
    expect(() => { validateApplicationRun(changed) }).toThrow()
  }
  const missing = structuredClone(run)
  missing.probes.splice(1, 1)
  expect(() => { validateApplicationRun(missing) }).toThrow('cadence')
})

test('a horizon ending inside host-loss watchdog settling retains no new host data and remains incomplete', () => {
  const config = exampleApplicationConfig()
  config.prescription[0]!.ratePerHa = 53
  config.calibration.minRatePerSecond = .0005
  config.calibration.noFlowTimeoutMs = 2000
  const run = simulateApplication({ config, scenario: 'host-loss', seconds: 7, authorizeImplement: true, testMode: false })
  expect(run.status).toBe('incomplete')
  expect(run.faultDemonstrated).toBe(false)
  expect(run.shutdown.requestedAtMs).toBe(6980)
  expect(run.inputs.at(-1)!.atMs).toBe(6960)
  expect(run.shutdown.finalAtMs).toBe(9000)
  expect(validateApplicationRun(run).status).toBe('incomplete')
})

test('a scheduled host-loss fault cannot activate during independent settling after an earlier empty stop', () => {
  const config = exampleApplicationConfig(); config.material.initialAmount = .0026
  const run = simulateApplication({ config, scenario: 'host-loss', authorizeImplement: true, testMode: false })
  expect(run.status).toBe('blocked')
  expect(run.reason).toBe('application-level-empty')
  expect(run.faultDemonstrated).toBe(false)
  const stop = run.decisions.find((decision, index) => decision.state !== 'applying' && run.decisions[index - 1]?.state === 'applying')!
  expect(run.shutdown.requestedAtMs).toBe(stop.atMs)
  expect(run.shutdown.requestedAtMs).toBeLessThan(run.inputs.at(-1)!.atMs)
  expect(parseApplicationRecording(applicationRecordingJson(run))).toEqual(run)
})
