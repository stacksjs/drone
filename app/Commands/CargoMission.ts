import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { cargoDeliveryScenarios, cargoDeliverySummary, simulateCargoDelivery } from '../../resources/functions/drone/cargo/delivery'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'cargo:mission <request>',
  description: 'Execute an explicitly configured modeled cargo mission without physical dispatch',
  options: {
    '--scenario <name>': { description: cargoDeliveryScenarios.join(', '), default: 'nominal' },
  },
  async handle(options, path) {
    try {
      const input = await readMissionFile(path, { maxBytes: 16384, preserveBom: true })
      const summary = cargoDeliverySummary(simulateCargoDelivery({ configuration: JSON.parse(input), scenario: options.scenario }))
      if (!summary.demonstrationMatched || summary.status !== 'completed' || summary.delivery.outcome !== 'received' || !summary.landingContact) process.exitCode = 2
      await printAsync(JSON.stringify(summary))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Cargo mission simulation unavailable: invalid declaration, rejected route or output failure') }
      catch { /* Failed output remains failure even if its diagnostic pipe is closed. */ }
    }
  },
})
