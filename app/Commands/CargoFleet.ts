import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { cargoFleetScenarios, cargoFleetSummary, simulateCargoFleet } from '../../resources/functions/drone/cargo/fleet'

export default defineCommand({
  name: 'cargo:fleet',
  description: 'Run two owned modeled carriers through one finite station and captured intake, without physical dispatch',
  options: {
    '--scenario <name>': { description: cargoFleetScenarios.join(', '), default: 'nominal' },
  },
  async handle(options) {
    try {
      const summary = cargoFleetSummary(simulateCargoFleet({ scenario: options.scenario }))
      if (summary.status !== 'completed') process.exitCode = 2
      const wire = JSON.stringify(summary)
      if (Buffer.byteLength(wire) + 1 > 16384) throw new RangeError('cargo-fleet-output-limit')
      await printAsync(wire)
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Cargo fleet simulation unavailable: invalid scenario, execution or output failure') }
      catch { /* A closed diagnostic pipe does not make the failed command succeed. */ }
    }
  },
})
