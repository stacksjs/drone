import { expect, test } from 'bun:test'
import { processApplication } from '../../resources/functions/drone/application/coverage'
import { applicationRecordingJson, parseApplicationRecording, validateApplicationRun } from '../../resources/functions/drone/application/evidence'
import { exampleAerialApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { simulateAerialApplication } from '../../resources/functions/drone/application/runtime'
import { createRigidBody } from '../../resources/functions/drone/controls/physics'

const metered = { authorizeImplement: true, testMode: false }

test('the centered load changes achieved acceleration at equal thrust', () => {
  const light = createRigidBody({ positionM: [0, 0, -1], motorsN: [5, 5, 5, 5] })
  const heavy = createRigidBody({ positionM: [0, 0, -1], motorsN: [5, 5, 5, 5] })
  expect(light.step([5, 5, 5, 5], .004, { centeredLoadKg: .2 }).accelerationMps2[2]).toBeLessThan(
    heavy.step([5, 5, 5, 5], .004, { centeredLoadKg: .4 }).accelerationMps2[2],
  )
})

test('the loaded quad lands, meters only on a granted pass and excludes the protected strip', () => {
  const fixture = exampleAerialApplicationConfig()
  const dry = simulateAerialApplication(fixture, { authorizeImplement: true })
  const ungranted = simulateAerialApplication(fixture, { testMode: false })
  for (const run of [dry, ungranted]) {
    expect(run.status).toBe('dry-completed')
    expect(run.vehicle.mission.reason).toBe('landed')
    expect(run.final.emittedAmount).toBe(0)
    expect(run.probes.at(-1)!.flight.pumpEnergyWh).toBe(0)
  }
  expect(ungranted.decisions.every(row => row.reason === 'application-no-explicit-grant')).toBe(true)

  const run = simulateAerialApplication(fixture, metered)
  const final = run.probes.at(-1)!.flight
  expect(run.status).toBe('completed')
  expect(run.vehicle.mission.reason).toBe('landed')
  expect(run.shutdown.closureVerified).toBe(true)
  expect(run.vehicle.transitions.some(transition => transition.taskId === 'home')).toBe(true)
  expect(run.decisions.some(row => row.reason === 'application-footprint-guard')).toBe(true)
  expect(run.decisions.filter(row => row.channels.some(Boolean)).every(row => row.taskId === 'apply-1')).toBe(true)
  expect(run.final.emittedAmount).toBeGreaterThan(.01)
  expect(final.massKg).toBeCloseTo(run.plan.load.takeoffMassKg - run.final.emittedAmount, 12)
  expect(final.pumpEnergyWh).toBeGreaterThan(0)
  expect(final.propulsionEnergyWh).toBeGreaterThan(final.pumpEnergyWh)
  expect(final.reserveMarginWh).toBeGreaterThan(0)
  expect(parseApplicationRecording(applicationRecordingJson(run))).toEqual(run)

  const report = processApplication(run)
  expect(report.emittedAmount).toBeCloseTo(report.inFieldAmount + report.excludedAmount + report.outsideAmount + report.inFlightAmount, 12)
  expect(report.excludedAmount).toBeLessThan(1e-9)
  expect(report.coveredAreaM2).toBeGreaterThan(0)
  expect(report.missedAreaM2).toBeGreaterThan(report.coveredAreaM2)
  expect(report.overlapAreaM2).toBe(0)

  const wrongMass = structuredClone(run)
  wrongMass.probes.at(-1)!.flight.massKg += .02
  expect(() => validateApplicationRun(wrongMass)).toThrow('flight mass')
  const wrongDrift = structuredClone(run)
  wrongDrift.releases[0]!.releaseVelocityMps = [100, 0]
  expect(() => validateApplicationRun(wrongDrift)).toThrow('release velocity')
}, 60000)

test('aerial meter loss, host loss and double barrier failure keep their independent outcomes', () => {
  const fixture = exampleAerialApplicationConfig()
  const meter = simulateAerialApplication(fixture, { ...metered, scenario: 'meter-loss' })
  expect(meter.status).toBe('blocked')
  expect(meter.reason).toBe('application-meter-unavailable')
  expect(meter.vehicle.mission.reason).toBe('landed')
  expect(meter.shutdown.closureVerified).toBe(true)
  const latchAt = meter.decisions.find(row => row.state === 'latched')!.atMs
  expect(meter.decisions.filter(row => row.atMs >= latchAt).every(row => row.channels.every(n => n === 0))).toBe(true)

  const host = simulateAerialApplication(fixture, { ...metered, scenario: 'host-loss' })
  expect(host.status).toBe('host-lost')
  expect(host.vehicle.board.fault).toBe('output-lease-expired')
  expect(host.probes.at(-1)!.hostAvailable).toBe(false)
  expect(host.releases.some(row => !row.hostAvailable && row.taskId === null)).toBe(true)
  expect(host.shutdown.closureVerified).toBe(true)

  const stuck = simulateAerialApplication(fixture, { ...metered, scenario: 'master-stuck' })
  expect(stuck.status).toBe('blocked')
  expect(stuck.reason).toBe('application-barrier-position-disagreement')
  expect(stuck.vehicle.mission.reason).toBe('landed')
  expect(stuck.shutdown.closureVerified).toBe(false)
  expect(stuck.shutdown.emittedAfterRequest).toBeGreaterThan(.001)
  expect(stuck.final.flowPerSecond).toBeGreaterThan(0)
  expect(processApplication(stuck).excludedAmount).toBeGreaterThan(0)
  for (const run of [meter, host, stuck]) {
    expect(run.faultDemonstrated).toBe(true)
    expect(validateApplicationRun(run).status).toBe(run.status)
  }
}, 60000)

test('opposite declared aerial passes retain overlap and continue guarding exclusions', () => {
  const fixture = exampleAerialApplicationConfig()
  fixture.application.routeM.push([2, 0])
  const run = simulateAerialApplication(fixture, metered)
  const report = processApplication(run)
  expect(run.status).toBe('completed')
  expect(run.decisions.some(row => row.taskId === 'apply-2' && row.state === 'applying')).toBe(true)
  expect(report.overlapAreaM2).toBeGreaterThan(0)
  expect(report.overlapAreaM2).toBeLessThan(report.coveredAreaM2)
  expect(report.excludedAmount).toBeLessThan(1e-9)
}, 60000)
