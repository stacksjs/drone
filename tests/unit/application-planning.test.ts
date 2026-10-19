import { expect, test } from 'bun:test'
import type { ApplicationConfig } from '../../resources/functions/drone/application/types'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { planApplication, validateApplicationConfig } from '../../resources/functions/drone/application/planner'

// Public planning seam verifies explicit polygon support and owned mission
// budgets. It does not qualify delivered field dose or physical interlocks.
test('inert water and granules retain independent calibration and a dry approach, apply pass and dry return', () => {
  for (const type of ['sprayer', 'spreader'] as const) {
    const p = planApplication(exampleApplicationConfig(type))
    expect(p.fieldAreaM2).toBe(10)
    expect(p.excludedAreaM2).toBe(0)
    expect(p.treatableAreaM2).toBe(10)
    expect(p.prescribedAmount).toBe(type === 'sprayer' ? .2 : .1)
    expect(p.inventorySufficient).toBe(true)
    expect(p.physicalTrialEligible).toBe(false)
    expect(p.mission.tasks.map(task => task.id)).toEqual(['start', 'approach', 'apply-1', 'home', 'stop'])
    expect(p.mission.vehicle).toBe('ground')
    expect(p.worstCaseMs).toBeGreaterThan(50000)
    expect(p.worstCaseMs).toBeLessThanOrEqual(120000)
    expect(p.requiredWh).toBeGreaterThan(0)
    expect(p.requiredWh).toBeLessThan(70)
  }
})

test('concave field support, partial exclusions and unequal prescriptions retain independently worked areas', () => {
  const c = exampleApplicationConfig()
  c.boundary = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]
  c.exclusions = [[[.2, .2], [.8, .2], [.8, .8], [.2, .8]], [[-1, 2], [.5, 2], [.5, 3], [-1, 3]]]
  c.prescription = [
    { id: 'lower-rate', polygon: [[0, 0], [2, 0], [2, 2], [0, 2]], ratePerHa: 200 },
    { id: 'upper-rate', polygon: [[0, 2], [1, 2], [1, 4], [0, 4]], ratePerHa: 100 },
  ]
  const p = planApplication(c)
  expect(p.fieldAreaM2).toBe(7)
  expect(p.excludedAreaM2).toBeCloseTo(.86, 12)
  expect(p.treatableAreaM2).toBeCloseTo(6.14, 12)
  expect(p.prescribedAmount).toBeCloseTo(.0678, 12)
  c.material.initialAmount = .01
  expect(planApplication(c).inventorySufficient).toBe(false)
  // Winding changes do not alter support; all declared unprescribed area remains.
  c.boundary.reverse(); c.exclusions.forEach(ring => ring.reverse()); c.prescription.forEach(zone => zone.polygon.reverse())
  expect(planApplication(c).prescribedAmount).toBeCloseTo(.0678, 12)
})

test('a clipped triangle exclusion is integrated exactly rather than by bounding rectangle or centre tests', () => {
  const c = exampleApplicationConfig()
  c.boundary = [[0, 0], [4, 0], [0, 4]]
  c.exclusions = [[[1, 1], [3, 1], [3, 3], [1, 3]]]
  c.prescription[0]!.polygon = structuredClone(c.boundary)
  const p = planApplication(c)
  expect(p.fieldAreaM2).toBe(8)
  expect(p.excludedAreaM2).toBe(2)
  expect(p.treatableAreaM2).toBe(6)
  expect(p.prescribedAmount).toBe(.12)
})

test('configuration cloning rejects hidden JSON-incompatible fields before losing required state', () => {
  const c = exampleApplicationConfig()
  Object.defineProperty(c, 'id', { value: c.id, enumerable: false })
  expect(() => validateApplicationConfig(c)).toThrow()
})

test('configured sensor counters must fit the actual shared vehicle measurement range', () => {
  const scale = exampleApplicationConfig()
  scale.material.initialAmount = 2
  scale.calibration.scale.loadedRaw = 100001000
  expect(() => validateApplicationConfig(scale)).toThrow('scale telemetry range')
  const pulse = exampleApplicationConfig()
  pulse.material.initialAmount = 2
  pulse.calibration.pulse = { pulses: 1000000, litres: .01, durationMs: 100 }
  expect(() => validateApplicationConfig(pulse)).toThrow('pulse telemetry range')
})

test('touching polygon edges are allowed while actual overlapping exclusion and prescription interiors are rejected', () => {
  const c = exampleApplicationConfig()
  c.exclusions = [[[2, -1], [3, -1], [3, 0], [2, 0]], [[2, 0], [3, 0], [3, 1], [2, 1]]]
  const p = planApplication(c)
  expect(p.excludedAreaM2).toBe(2)
  expect(p.treatableAreaM2).toBe(8)
  expect(p.prescribedAmount).toBe(.16)
  c.exclusions[1] = [[2, -.1], [3, -.1], [3, 1], [2, 1]]
  expect(() => planApplication(c)).toThrow('overlapping polygon interiors')
  c.exclusions = []
  c.prescription = [{ id: 'one', polygon: [[0, 0], [4, 0], [2, 4]], ratePerHa: 200 }, { id: 'two', polygon: [[0, 3], [4, 3], [2, -1]], ratePerHa: 200 }]
  expect(() => planApplication(c)).toThrow('overlapping polygon interiors')
})

test('an explicit unprescribed field retains all missing support and never implies physical trial approval', () => {
  const c = exampleApplicationConfig('spreader')
  c.prescription = []; c.material.initialAmount = 0
  c.localRequirements.jurisdiction = 'Operator-declared location'
  const p = planApplication(c)
  expect(p.treatableAreaM2).toBe(10)
  expect(p.prescribedAmount).toBe(0)
  expect(p.inventorySufficient).toBe(true)
  expect(p.config.localRequirements.status).toBe('unqualified')
  expect(p.physicalTrialEligible).toBe(false)
})

test('geometry, material, timing and resource errors fail bounded public planning', () => {
  const mutations: ((c: ApplicationConfig) => void)[] = [
    c => { c.boundary = [[0, 0], [2, 2], [0, 2], [2, 0]] },
    c => { c.boundary = [[0, 0], [2, 0], [1, 0], [1, 2], [0, 2]] },
    c => { c.boundary = [[0, 0], [1, 0], [1, 0], [0, 1]] },
    c => { c.boundary = Array.from({ length: 33 }, (_, i) => [3 + Math.cos(i / 33 * 2 * Math.PI), Math.sin(i / 33 * 2 * Math.PI)]) },
    c => { c.exclusions = Array(9).fill([[0, 0], [1, 0], [0, 1]]) },
    c => { c.prescription = Array(9).fill(c.prescription[0]!) },
    c => { c.routeM.push(...Array.from({ length: 11 }, (_, i) => [i, 0] as [number, number])) },
    c => { c.routeM[0] = [12, 1] },
    c => { c.routeM[1] = [...c.routeM[0]!] },
    c => { c.gridResolutionM = .05 },
    c => { c.material.unit = 'kg' },
    c => { c.material.kind = 'inert-granules' },
    c => { c.material.densityKgPerL = 2 },
    c => { c.material.initialAmount = -1 },
    c => { c.calibration.pulse = null },
    c => { c.calibration.noFlowTimeoutMs = 200 },
    c => { c.calibration.closingAllowanceMs = 250 },
    c => { c.prescription[0]!.ratePerHa = 10000 },
    c => { c.implement.maxSpeedMps = 0 },
    c => { c.origin.latitudeDeg = 1 },
    c => { c.weather.windMps[0] = Number.NaN },
    c => { c.weatherLimits.maxTemperatureC = 0 },
    c => { c.localRequirements.evidenceLinks = ['https://user:private@example.com/evidence'] },
    c => { Object.assign(c.localRequirements, { status: 'approved' }) },
    c => { Object.assign(c, { physicalTrialEligible: true }) },
  ]
  for (const mutate of mutations) { const c = exampleApplicationConfig(); mutate(c); expect(() => planApplication(c)).toThrow() }
})

test('config is detached and rejects getters, cycles, sparse arrays and unsupported source objects before copying', () => {
  const c = exampleApplicationConfig(), p = planApplication(c)
  c.boundary[0]![0] = 50; c.routeM[0]![0] = 50
  expect(p.config.boundary[0]![0]).toBe(1)
  expect(p.mission.tasks[1]!.kind).toBe('waypoint')
  const getter = exampleApplicationConfig()
  Object.defineProperty(getter.material, 'initialAmount', { enumerable: true, get() { throw new Error('PRIVATE_APPLICATION_ACCESSOR_INVOKED') } })
  expect(() => validateApplicationConfig(getter)).toThrow('accessor')
  const cyclic = exampleApplicationConfig()
  Object.assign(cyclic, { self: cyclic })
  expect(() => validateApplicationConfig(cyclic)).toThrow('cyclic')
  const sparse = exampleApplicationConfig()
  delete sparse.boundary[1]
  expect(() => validateApplicationConfig(sparse)).toThrow('sparse')
  expect(() => validateApplicationConfig(new Uint8Array(new SharedArrayBuffer(4)))).toThrow('unsupported')
  const symbolic = exampleApplicationConfig()
  Object.assign(symbolic, { [Symbol('unsupported')]: 1 })
  expect(() => validateApplicationConfig(symbolic)).toThrow('symbolic')
  expect(() => exampleApplicationConfig('unsupported' as 'sprayer')).toThrow()
})

test('the actual mission graph rejects a route that exceeds its bounded execution budget', () => {
  const c = exampleApplicationConfig()
  c.routeM = Array.from({ length: 12 }, (_, i) => [i % 2 ? -8 : 8, 0])
  expect(() => planApplication(c)).toThrow()
})
