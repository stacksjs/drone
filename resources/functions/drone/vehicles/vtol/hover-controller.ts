import { createSimulatedLiftController } from '../../controls/lift-controller'
import { allocateVtolLift } from './allocation'
import { vtolModel as model } from './plant'

/** Fictional hover tuning scaled for the declared diagonal inertia. No transition or physical control. */
export function createVtolHoverController(options: { headingAlignment: 'initial-simulation-north' }) {
  return createSimulatedLiftController(options, {
    massKg: model.massKg,
    gravityMps2: model.gravityMps2,
    rateScale: [10, 40 / 3, 12],
    attitudeControl: 'thrust-heading-v2',
    allocate(wrench) {
      const result = allocateVtolLift(wrench)
      return { motorsN: result.rotorsN, achieved: result.achieved, limited: result.limited }
    },
  })
}
