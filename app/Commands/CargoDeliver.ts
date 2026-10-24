import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { cargoDeliveryScenarios, cargoDeliverySummary, simulateCargoDelivery } from '../../resources/functions/drone/cargo/delivery'

export default defineCommand({
  name: 'cargo:deliver',
  description: 'Simulate owned cargo release, modeled recipient evidence and a finite alternate landing',
  options: {
    '--scenario <name>': { description: cargoDeliveryScenarios.join(', '), default: 'nominal' },
  },
  async handle(options) {
    try {
      const summary = cargoDeliverySummary(simulateCargoDelivery({ scenario: options.scenario }))
      if (!summary.demonstrationMatched) process.exitCode = 1
      await printAsync(JSON.stringify(summary))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Cargo delivery simulation failed: invalid input, unavailable result or output failure') }
      catch { /* Closed stderr cannot turn a failed output into success. */ }
    }
  },
})
