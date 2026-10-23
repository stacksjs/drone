import { createSimulatedLiftController } from './lift-controller'
import { allocateQuadX } from './allocation'
import { multirotorModel as model } from './model'

export type { SimulatedControlInput, SimulatedControlOutput } from './lift-controller'

/** Original quad-X model and tuning, on the shared simulation-only lift cascade. */
export function createSimulatedMultirotorController(options: { headingAlignment: 'initial-simulation-north' }) {
  return createSimulatedLiftController(options, { massKg: model.massKg, gravityMps2: model.gravityMps2, rateScale: [1, 1, 1], attitudeControl: 'quaternion-error-v1', allocate: allocateQuadX })
}
