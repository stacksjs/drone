import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { cargoFleetSummary } from '../../resources/functions/drone/cargo/fleet'
import { cargoFleetOperatorCases, simulateCargoFleetControl } from '../../resources/functions/drone/cargo/fleet-control'

export default defineCommand({
  name: 'cargo:fleet-control',
  description: 'Exercise explicit modeled transport cancellation and recovery over the retained two-carrier world',
  options: {
    '--case <name>': { description: cargoFleetOperatorCases.join(', '), default: 'cancel-resume' },
  },
  async handle(options) {
    try {
      const fixture = simulateCargoFleetControl({ case: options.case })
      const summary = { ...cargoFleetSummary(fixture.run), operatorCase: fixture.case }
      if (summary.status !== 'completed') process.exitCode = 2
      const wire = JSON.stringify(summary)
      if (Buffer.byteLength(wire) + 1 > 16384) throw new RangeError('cargo-fleet-control-output-limit')
      await printAsync(wire)
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Cargo fleet control unavailable: invalid case, execution or output failure') }
      catch { /* A closed diagnostic pipe does not make the failed command succeed. */ }
    }
  },
})
