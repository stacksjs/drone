import { expect, test } from 'bun:test'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { createApplicationPlant } from '../../resources/functions/drone/application/plant'
import { createApplicationController } from '../../resources/functions/drone/application/controller'
import { simulateApplication, applicationScenarios } from '../../resources/functions/drone/application/runtime'
import { createGroundProfile } from '../../resources/functions/drone/vehicles/ground/profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'

// Public plant/runtime seams verify real modeled integration and qualified controller replay.
// They do not qualify real metering, physical isolation or field deposition.
test('seven-channel plant meters actual material with finite response, independent isolation and conserved inventory', () => {
  const config = exampleApplicationConfig(), plant = createApplicationPlant(config)
  const environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
  expect(() => plant.step([0, 0, 0, 1], .004, environment)).toThrow('seven-channel')
  plant.step([0, 0, 0, 1, 1, 1, 1], .004, environment)
  const first = plant.meterSnapshot()
  expect(first.primaryPosition).toBeCloseTo(.02666666666666667, 12)
  expect(first.masterPosition).toBeCloseTo(.04, 12)
  expect(first.energy).toBeCloseTo(.048770575499285984, 12)
  expect(first.flowPerSecond).toBeLessThan(config.calibration.maxRatePerSecond / 100)
  for (let i = 0; i < 500; i++) plant.step([0, 0, 0, 1, .4, 1, 1], .004, environment)
  const flowing = plant.meterSnapshot()
  expect(flowing.emittedAmount).toBeGreaterThan(.01)
  expect(flowing.pulseCount).toBe(Math.floor(flowing.emittedAmount * 2000))
  expect(flowing.remainingAmount + flowing.emittedAmount).toBeCloseTo(config.material.initialAmount, 12)
  plant.setFault('stuck-valve')
  for (let i = 0; i < 500; i++) plant.step([0, 0, 0, 1, 0, 0, 0], .004, environment)
  const stopped = plant.meterSnapshot()
  expect(stopped.primaryPosition).toBeGreaterThan(0)
  expect(stopped.masterPosition).toBe(0)
  expect(stopped.flowPerSecond).toBe(0)
  expect(stopped.emittedAmount).toBeGreaterThan(flowing.emittedAmount)
  expect(stopped.remainingAmount + stopped.emittedAmount).toBeCloseTo(config.material.initialAmount, 12)
})

test('implement authority defaults dry and requires both an explicit grant and apply mode independently of vehicle arming', () => {
  for (const options of [{}, { authorizeImplement: true }, { testMode: false }]) {
    const run = simulateApplication(options)
    expect(run.status).toBe('dry-completed')
    expect(run.final.emittedAmount).toBe(0)
    expect(run.decisions.every(decision => decision.channels.every(n => n === 0))).toBe(true)
    expect(run.shutdown.closureVerified).toBe(true)
  }
})

test('both inert implements use actual ground movement, measured feedback and replayable separately scoped leases', () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    const run = simulateApplication({ config: exampleApplicationConfig(type), authorizeImplement: true, testMode: false })
    expect(run.status).toBe('completed')
    expect(run.final.emittedAmount).toBeGreaterThan(.001)
    expect(run.releases.reduce((sum, release) => sum + release.amount, 0)).toBeCloseTo(run.final.emittedAmount, 12)
    expect(run.final.remainingAmount + run.final.emittedAmount + run.final.unmeteredLossAmount).toBeCloseTo(run.config.material.initialAmount, 12)
    expect(run.decisions.some(decision => decision.targetPerSecond > 0 && decision.measuredPerSecond! > 0)).toBe(true)
    expect(run.inputs.some(input => input.grant?.action === 'grant')).toBe(true)
    expect(run.inputs.some(input => input.grant?.action === 'renew')).toBe(true)
    expect(run.shutdown.closureVerified).toBe(true)
    const controller = createApplicationController(run.config, run.options)
    expect(run.inputs.map(input => controller.step(input))).toEqual(run.decisions)
    for (const [i, input] of run.inputs.entries()) {
      expect(input.atMs).toBe(run.vehicle.path[i]!.atMs)
      expect(input.taskId).toBe(run.vehicle.path[i]!.mission.taskId)
    }
  }
})

test('application faults are exercised after actual discharge and latch despite transient instrument recovery', () => {
  for (const scenario of applicationScenarios.filter(name => name !== 'nominal')) {
    const run = simulateApplication({ scenario, authorizeImplement: true, testMode: false })
    expect(run.final.emittedAmount).toBeGreaterThan(0)
    expect(run.faultDemonstrated).toBe(true)
    expect(['blocked', 'host-lost']).toContain(run.status)
    expect(run.shutdown.closureVerified).toBe(scenario !== 'master-stuck')
    expect(run.final.remainingAmount + run.final.emittedAmount + run.final.unmeteredLossAmount).toBeCloseTo(run.config.material.initialAmount, 10)
    if (scenario === 'master-stuck') expect(run.final.flowPerSecond).toBeGreaterThan(0)
    const firstLatch = run.decisions.findIndex(decision => decision.state === 'latched')
    if (firstLatch >= 0) expect(run.decisions.slice(firstLatch).every(decision => decision.channels.every(n => n === 0))).toBe(true)
  }
})

test('host loss creates only independent tail probes and retains actual residual discharge without fabricated host estimates', () => {
  const run = simulateApplication({ scenario: 'host-loss', authorizeImplement: true, testMode: false })
  expect(run.status).toBe('host-lost')
  const hostEnd = run.inputs.at(-1)!.atMs
  expect(run.vehicle.path.at(-1)!.atMs).toBe(hostEnd)
  expect(run.vehicle.trace.rows.at(-1)!.observation.nowMs).toBe(hostEnd)
  expect(run.probes.at(-1)!.atMs).toBeGreaterThan(hostEnd + 1000)
  expect(run.probes.filter(probe => probe.atMs > run.shutdown.requestedAtMs).every(probe => !probe.hostAvailable)).toBe(true)
  expect(run.shutdown.emittedAfterRequest).toBeGreaterThan(0)
  expect(run.releases.some(release => !release.hostAvailable && release.taskId === null)).toBe(true)
  expect(run.shutdown.closureVerified).toBe(true)
  const short = simulateApplication({ scenario: 'host-loss', authorizeImplement: true, testMode: false, seconds: 2 })
  expect(short.status).toBe('incomplete')
  expect(short.faultDemonstrated).toBe(false)
})

test('opt-in independent tail preserves existing ground profiles and adds no host path or decisions', () => {
  const plain = runVehicleSimulation(createGroundProfile(), { seconds: 2 })
  const explicit = runVehicleSimulation(createGroundProfile(), { seconds: 2, neutralTailMs: 0 })
  expect(explicit).toEqual(plain)
  const settled = runVehicleSimulation(createGroundProfile(), { seconds: 2, neutralTailMs: 1000 })
  expect(settled.path).toEqual(plain.path)
  expect(settled.trace).toEqual(plain.trace)
  expect(settled.board.actuators).toEqual([0, 0, 0, 1])
  expect(() => runVehicleSimulation(createGroundProfile(), { seconds: 2, neutralTailMs: 6000 })).toThrow()
})
