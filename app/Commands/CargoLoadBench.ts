import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import type { CargoLoadCase } from '../../resources/functions/drone/cargo/types'
import { cargoLoadScenarios, cargoLoadSummary, simulateCargoLoad } from '../../resources/functions/drone/cargo/load'

export default defineCommand({
  name: 'cargo:load-bench',
  description: 'Characterize an owned airborne point load and prescribed split in the bounded simulation',
  options: {
    '--scenario <name>': { description: cargoLoadScenarios.join(', '), default: 'centered-carried' },
  },
  async handle(options) {
    try {
      if (typeof options.scenario !== 'string' || !cargoLoadScenarios.includes(options.scenario as CargoLoadCase)) throw new TypeError('cargo-load-input')
      const run = simulateCargoLoad({ scenario: options.scenario })
      const summary = cargoLoadSummary(run)
      if (run.status === 'unqualified') process.exitCode = 1
      await printAsync(JSON.stringify(summary))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Cargo load characterization failed: invalid input, unavailable result or output failure') }
      catch { /* A closed stderr cannot turn an output failure into success. */ }
    }
  },
})
