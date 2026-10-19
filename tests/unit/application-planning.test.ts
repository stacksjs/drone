import { expect, test } from 'bun:test'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { planApplication } from '../../resources/functions/drone/application/planner'
import { validateApplicationConfig } from '../../resources/functions/drone/application/planner'

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
