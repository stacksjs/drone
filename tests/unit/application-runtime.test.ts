import { expect, test } from 'bun:test'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { createApplicationPlant } from '../../resources/functions/drone/application/plant'
import { createApplicationController } from '../../resources/functions/drone/application/controller'
import { simulateApplication, applicationScenarios } from '../../resources/functions/drone/application/runtime'
import { createGroundProfile } from '../../resources/functions/drone/vehicles/ground/profile'
import { runVehicleSimulation } from '../../resources/functions/drone/vehicles/runtime'
import type { ApplicationControllerInput } from '../../resources/functions/drone/application/runtime-types'
import { planApplication } from '../../resources/functions/drone/application/planner'

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

function qualifiedInput(atMs = 600): ApplicationControllerInput {
  return { atMs, enabled: true, reference: '55:0,0,0,0,0', missionState: 'running', taskId: 'apply-1', ground: { healthy: true, reason: 'ground-encoder-gnss-fused', positionM: [3, 0, 0], speedMps: .5, wheelSpeedMps: .5, yawRad: 0, yawRateRadS: 0, obstacleM: 20, personM: 20, onSurface: true, stopped: false, guardClosed: true, emergency: false, uncertaintyM: .05 }, feedback: { sequence: (atMs - 600) / 20 + 1, capturedAtMs: atMs - 40, pulseCount: 0, scaleRaw: 11000, primaryEncoder: 0, masterEncoder: 0, energyEncoder: 0 }, weather: { windMps: [0, 0], temperatureC: 20, humidityPercent: 60, inversion: false, capturedAtMs: atMs }, grant: atMs === 600 ? { action: 'grant', sequence: 1, issuedAtMs: atMs, expiresAtMs: atMs + 200, visitId: 'public-test', configId: 'inert-sprayer', materialId: 'inert-water', reference: '55:0,0,0,0,0' } : null, emergency: false }
}

test('qualified estimated speed and explicit prescription determine rate with no positive floor at zero speed or during turns', () => {
  const config = exampleApplicationConfig(), options = { visitId: 'public-test', authorizeImplement: true, testMode: false }
  expect(createApplicationController(config, options).step(qualifiedInput()).targetPerSecond).toBeCloseTo(.008, 12)
  const faster = qualifiedInput(); faster.ground.speedMps = .75
  expect(createApplicationController(config, options).step(faster).targetPerSecond).toBeCloseTo(.012, 12)
  for (const change of ['zero', 'turn', 'outside', 'dry-task', 'no-grant'] as const) {
    const input = qualifiedInput()
    if (change === 'zero') input.ground.speedMps = 0
    if (change === 'turn') input.ground.yawRateRadS = .5
    if (change === 'outside') input.ground.positionM = [7, 0, 0]
    if (change === 'dry-task') input.taskId = 'home'
    if (change === 'no-grant') input.grant = null
    const decision = createApplicationController(config, options).step(input)
    expect(decision.targetPerSecond).toBe(0)
    expect(decision.channels).toEqual([0, 0, 0])
  }
})

test('whole forecast footprint guards exclusions and prescription boundaries with uncertainty and transport margin', () => {
  const config = exampleApplicationConfig(), options = { visitId: 'public-test', authorizeImplement: true, testMode: false }
  config.prescription = [{ id: 'south-rate', polygon: [[1, -1], [3.5, -1], [3.5, 1], [1, 1]], ratePerHa: 200 }, { id: 'north-rate', polygon: [[3.5, -1], [6, -1], [6, 1], [3.5, 1]], ratePerHa: 300 }]
  const validated = planApplication(config).config
  for (const [north, expected, zone] of [[2, .008, 'south-rate'], [5, .012, 'north-rate']] as const) {
    const input = qualifiedInput(); input.ground.positionM[0] = north
    const decision = createApplicationController(validated, options).step(input)
    expect(decision.targetPerSecond).toBeCloseTo(expected, 12)
    expect(decision.prescriptionId).toBe(zone)
  }
  const straddling = qualifiedInput(); straddling.ground.positionM[0] = 3.5
  expect(createApplicationController(validated, options).step(straddling).targetPerSecond).toBe(0)
  const guarded = exampleApplicationConfig()
  guarded.exclusions = [[[3.4, -.2], [3.7, -.2], [3.7, .2], [3.4, .2]]]
  const decision = createApplicationController(planApplication(guarded).config, options).step(qualifiedInput())
  expect(decision.reason).toBe('application-footprint-guard')
  expect(decision.targetPerSecond).toBe(0)
})

test('explicit lease scope, instrument freshness, replay and missing feedback cannot authorize continuous metering', () => {
  const config = exampleApplicationConfig(), options = { visitId: 'public-test', authorizeImplement: true, testMode: false }
  const wrongMaterial = qualifiedInput(); wrongMaterial.grant!.materialId = 'other-material'
  expect(createApplicationController(config, options).step(wrongMaterial).reason).toBe('application-grant-invalid')
  for (const change of ['missing', 'stale'] as const) {
    const input = qualifiedInput()
    if (change === 'missing') input.feedback = null
    else input.feedback!.capturedAtMs = 400
    expect(createApplicationController(config, options).step(input).reason).toBe('application-meter-unavailable')
  }
  const empty = qualifiedInput(); empty.feedback!.scaleRaw = config.calibration.scale.tareRaw
  const emptyDecision = createApplicationController(config, options).step(empty)
  expect(emptyDecision.reason).toBe('application-level-empty')
  expect(emptyDecision.channels).toEqual([0, 0, 0])
  const replay = createApplicationController(config, options)
  replay.step(qualifiedInput())
  const changed = qualifiedInput(620); changed.feedback!.sequence = 1
  expect(replay.step(changed).reason).toBe('application-meter-replay')
  const lease = createApplicationController(config, options)
  lease.step(qualifiedInput())
  for (let atMs = 620; atMs < 800; atMs += 20) lease.step(qualifiedInput(atMs))
  const expired = lease.step(qualifiedInput(800))
  expect(expired.reason).toBe('application-grant-expired')
  expect(expired.channels).toEqual([0, 0, 0])
  const late = createApplicationController(config, options)
  late.step(qualifiedInput())
  for (let atMs = 620; atMs < 800; atMs += 20) late.step(qualifiedInput(atMs))
  const renewal = qualifiedInput(800)
  renewal.grant = { ...qualifiedInput().grant!, action: 'renew', sequence: 2, issuedAtMs: 800, expiresAtMs: 1000 }
  expect(late.step(renewal).reason).toBe('application-grant-expired')
})

test('public controller rejects nonfinite weather clocks and ground kinematics before issuing any metering output', () => {
  const config = exampleApplicationConfig(), options = { visitId: 'public-test', authorizeImplement: true, testMode: false }
  const mutations: ((input: ApplicationControllerInput) => void)[] = [
    input => { input.weather.capturedAtMs = Number.NaN },
    input => { input.weather.capturedAtMs = Infinity },
    input => { input.weather.capturedAtMs = 601 },
    input => { input.ground.speedMps = Number.NaN },
    input => { input.ground.yawRad = Infinity },
    input => { input.ground.yawRateRadS = Number.NaN },
    input => { input.ground.uncertaintyM = 0 },
    input => { input.ground.uncertaintyM = -1 },
    input => { input.ground.uncertaintyM = Number.NaN },
    input => { input.ground.positionM[0] = Infinity },
  ]
  for (const mutate of mutations) {
    const input = qualifiedInput(); mutate(input)
    const decision = createApplicationController(config, options).step(input)
    expect(decision.state).toBe('latched')
    expect(decision.channels).toEqual([0, 0, 0])
    expect(decision.targetPerSecond).toBe(0)
    expect(decision.estimatedPositionM.every(Number.isFinite)).toBe(true)
  }
})

test('public controller snapshots calibration and authority options rather than retaining mutable caller aliases', () => {
  const config = exampleApplicationConfig(), options = { visitId: 'public-test', authorizeImplement: true, testMode: false }
  const controller = createApplicationController(config, options)
  config.prescription[0]!.ratePerHa = 10000; config.weatherLimits.maxWindMps = 0; options.authorizeImplement = false
  expect(controller.step(qualifiedInput()).targetPerSecond).toBeCloseTo(.008, 12)
  const invalid = exampleApplicationConfig(); invalid.calibration.pulse!.litres = 0
  expect(() => createApplicationController(invalid, options)).toThrow()
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

test('a completed authorized route with no prescription preserves zero application and an explicit missing-material outcome', () => {
  const config = exampleApplicationConfig(); config.prescription = []
  const run = simulateApplication({ config, authorizeImplement: true, testMode: false })
  expect(run.status).toBe('completed')
  expect(run.reason).toBe('application-no-material-discharged')
  expect(run.final.emittedAmount).toBe(0)
  expect(run.releases).toEqual([])
  expect(run.decisions.every(decision => decision.targetPerSecond === 0)).toBe(true)
})

test('both inert implements use actual ground movement, measured feedback and replayable separately scoped leases', () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    const run = simulateApplication({ config: exampleApplicationConfig(type), authorizeImplement: true, testMode: false })
    expect(run.status).toBe('completed')
    expect(run.reason).toBe('stopped')
    expect(run.decisions.some(decision => decision.state === 'latched')).toBe(false)
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
  for (const type of ['sprayer', 'spreader'] as const) for (const scenario of applicationScenarios.filter(name => name !== 'nominal')) {
    const run = simulateApplication({ config: exampleApplicationConfig(type), scenario, authorizeImplement: true, testMode: false })
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
  expect(() => runVehicleSimulation(createGroundProfile(), { seconds: 2, neutralTailMs: 15004 })).toThrow()
})
