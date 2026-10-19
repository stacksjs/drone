import { expect, test } from 'bun:test'
import { createApplicationPlant } from '../../resources/functions/drone/application/plant'
import { exampleApplicationConfig } from '../../resources/functions/drone/application/fixtures'
import { createGroundPlant } from '../../resources/functions/drone/vehicles/ground/plant'

const environment = { windMps: [0, 0, 0] as [number, number, number], currentMps: [0, 0, 0] as [number, number, number] }
const enabled = [0, 0, 0, 1, 1, 1, 1]

// Public plant construction/integration catches caller aliasing and inconsistent
// material/time advancement; it does not qualify a physical implement.
test('application plant validates and detaches configuration while preserving the supplied ground adapter', () => {
  const config = exampleApplicationConfig(), ground = createGroundPlant()
  let groundSteps = 0
  const plant = createApplicationPlant(config, { ground: { snapshot: ground.snapshot, step(...args) { groundSteps++; return ground.step(...args) } } })
  config.calibration.maxRatePerSecond = 1
  config.calibration.scale.tareRaw = 90000
  config.calibration.primaryCloseMs = 1
  for (let i = 0; i < 500; i++) plant.step(enabled, .004, environment)
  expect(groundSteps).toBe(500)
  expect(plant.meterSnapshot().flowPerSecond).toBeCloseTo(.03, 10)
  expect(plant.meterSnapshot().scaleRaw).toBeLessThan(11000)
  const invalid = exampleApplicationConfig(); invalid.calibration.primaryCloseMs = 0
  expect(() => createApplicationPlant(invalid)).toThrow()
})

test('plant rejects fractional-millisecond integration before advancing ground, material or clock', () => {
  const plant = createApplicationPlant(exampleApplicationConfig()), before = plant.snapshot(), meter = plant.meterSnapshot()
  for (const dt of [.0001, .0015, .0101, 0, Number.NaN]) {
    expect(() => plant.step(enabled, dt, environment)).toThrow()
    expect(plant.snapshot()).toEqual(before)
    expect(plant.meterSnapshot()).toEqual(meter)
  }
  plant.step(enabled, .001, environment)
  plant.step(enabled, .01, environment)
  expect(plant.meterSnapshot().atMs).toBe(11)
  expect(plant.meterSnapshot().emittedAmount).toBeGreaterThan(0)
})
