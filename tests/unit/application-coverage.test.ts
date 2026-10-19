import { expect, test } from 'bun:test'
import type { ApplicationConfig, ApplicationRelease } from '../../resources/functions/drone/application/types'
import { processApplicationReleases } from '../../resources/functions/drone/application/coverage'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'

function config(type: 'sprayer' | 'spreader' = 'sprayer'): ApplicationConfig {
  const c = exampleApplicationConfig(type)
  c.boundary = [[0, 0], [4, 0], [4, 4], [0, 4]]
  c.exclusions = [[[1, 1], [2, 1], [2, 2], [1, 2]]]
  c.prescription = [{ id: 'zone-a', polygon: structuredClone(c.boundary), ratePerHa: type === 'sprayer' ? 200 : 100 }]
  c.routeM = [[.5, .5], [3, .5], [3, 3]]
  c.gridResolutionM = 1; c.implement.swathM = 2; c.implement.footprintLengthM = 2; c.implement.fallTimeS = 1; c.calibration.closingAllowanceMs = 3000; c.calibration.maxRatePerSecond = .1
  return c
}
function release(atMs: number, taskId: string | null = 'apply-a', positionM: [number, number, number] = [1, 1, 0], amount = 4): ApplicationRelease {
  return { atMs, amount, positionM, yawRad: 0, windMps: [0, 0], taskId, hostAvailable: true, positionEvidence: 'modeled-plant-truth' }
}
// Public numerical deposition seam. Worked areas and conservation deliberately
// describe mathematical inert-material fixtures, not an authorized real pass,
// physical distribution, drift or measured field dose.
test('preserves emitted conservation across treatable, excluded, outside and still-in-flight material', () => {
  const report = processApplicationReleases(config(), [release(100), release(200, 'apply-a', [0, 0, 0]), release(1900, null, [1, 1, 0], 2)], 2000)
  expect(report.emittedAmount).toBe(10)
  expect(report.inFieldAmount).toBeCloseTo(4, 10)
  expect(report.excludedAmount).toBeCloseTo(1, 10)
  expect(report.outsideAmount).toBeCloseTo(3, 10)
  expect(report.inFlightAmount).toBe(2)
  expect(report.conservationError).toBeCloseTo(0, 10)
  expect(report.cells.reduce((sum, cell) => sum + cell.depositedAmount, 0)).toBeCloseTo(4, 10)
  expect(report.physicalApplicationVerified).toBe(false)
})

test('exact union separates repeated same-pass stamps from overlap of distinct pass task identities', () => {
  const samePass = processApplicationReleases(config(), [release(100), release(120), release(140)], 2000)
  expect(samePass.coveredAreaM2).toBeCloseTo(3, 10)
  expect(samePass.overlapAreaM2).toBe(0)
  expect(samePass.inFieldAmount).toBeCloseTo(9, 10)
  const twoPasses = processApplicationReleases(config(), [release(100), release(120, 'apply-b', [2, 1, 0])], 2000)
  expect(twoPasses.coveredAreaM2).toBeCloseTo(5, 10)
  expect(twoPasses.overlapAreaM2).toBeCloseTo(1, 10)
  const threePasses = processApplicationReleases(config(), [release(100), release(120, 'apply-b'), release(140, 'apply-c')], 2000)
  expect(threePasses.coveredAreaM2).toBeCloseTo(3, 10)
  expect(threePasses.overlapAreaM2).toBeCloseTo(3, 10)
  const unknownScope = processApplicationReleases(config(), [release(100), release(120, null), release(140, 'return')], 2000)
  expect(unknownScope.coveredAreaM2).toBeCloseTo(3, 10)
  expect(unknownScope.overlapAreaM2).toBe(0)
})

test('clips a triangular field and exclusion exactly and preserves zero-support grid cells and zone amount', () => {
  const c = config()
  c.boundary = [[0, 0], [2, 0], [0, 2]]
  c.exclusions = [[[.25, .25], [.75, .25], [.75, .75], [.25, .75]]]
  c.prescription[0]!.polygon = structuredClone(c.boundary)
  c.routeM = [[.2, .2], [1, .2], [.2, 1]]
  const report = processApplicationReleases(c, [release(100)], 2000)
  expect(report.fieldAreaM2).toBeCloseTo(2, 10)
  expect(report.treatableAreaM2).toBeCloseTo(1.75, 10)
  expect(report.coveredAreaM2).toBeCloseTo(1.75, 10)
  expect(report.missedAreaM2).toBeCloseTo(0, 10)
  expect(report.inFieldAmount).toBeCloseTo(1.75, 10)
  expect(report.excludedAmount).toBeCloseTo(.25, 10)
  expect(report.outsideAmount).toBeCloseTo(2, 10)
  expect(report.cells).toHaveLength(4)
  expect(report.cells.some(cell => cell.areaM2 === 0 && cell.dosePerHa === null)).toBe(true)
  expect(report.cells.reduce((sum, cell) => sum + cell.prescribedAmount, 0)).toBeCloseTo(.035, 10)
  expect(report.cells.filter(cell => cell.areaM2 > cell.excludedAreaM2).every(cell => Math.abs(cell.dosePerHa! - 10000) < 1e-8)).toBe(true)
})

test('orients finite rectangular kernels by yaw and advects them by wind times fall duration', () => {
  const c = config(); c.boundary = [[0, 0], [2, 0], [2, 2], [0, 2]]; c.exclusions = []
  c.prescription[0]!.polygon = structuredClone(c.boundary); c.routeM = [[.2, .2], [1, .2], [1, 1]]
  c.implement.swathM = 1
  const emitted = release(100, 'apply-a', [1, 1, 0], 2); emitted.yawRad = Math.PI / 2; emitted.windMps = [1, 0]
  const report = processApplicationReleases(c, [emitted], 2000)
  expect(report.inFieldAmount).toBeCloseTo(1, 10)
  expect(report.outsideAmount).toBeCloseTo(1, 10)
  expect(report.coveredAreaM2).toBeCloseTo(1, 10)
  expect(report.cells.filter(cell => cell.boundsM[2] <= 1).every(cell => cell.depositedAmount === 0)).toBe(true)
})

test('both liquid and granular units retain explicit zero coverage and missing prescription without fabricated delivery', () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    const report = processApplicationReleases(config(type), [], 2000)
    expect(report.unit).toBe(type === 'sprayer' ? 'L' : 'kg')
    expect(report.emittedAmount).toBe(0)
    expect(report.coveredAreaM2).toBe(0)
    expect(report.missedAreaM2).toBeCloseTo(15, 10)
    expect(report.cells.reduce((sum, cell) => sum + cell.prescribedAmount, 0)).toBeCloseTo(type === 'sprayer' ? .3 : .15, 10)
  }
})

test('rejects hidden or shared public release data before cloning or reading accessors', () => {
  const hidden = release(100)
  Object.defineProperty(hidden, 'secret', { get() { throw new Error('private getter invoked') } })
  expect(() => processApplicationReleases(config(), [hidden], 2000)).toThrow('fields')
  const extended = [release(100)]
  Object.defineProperty(extended, 'secret', { get() { throw new Error('private getter invoked') } })
  expect(() => processApplicationReleases(config(), extended, 2000)).toThrow('array')
  const position = release(100)
  Object.setPrototypeOf(position.positionM, Object.assign([], { hidden: true }))
  expect(() => processApplicationReleases(config(), [position], 2000)).toThrow('quantities')
})
