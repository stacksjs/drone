import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { VolumeScenario } from '../../resources/functions/drone/volumes/fixtures'
import { exampleVolumeRequest, volumeScenarios } from '../../resources/functions/drone/volumes/fixtures'
import { processStockpile } from '../../resources/functions/drone/volumes/engine'
import { writeVolumeDataset } from '../../resources/functions/drone/volumes/export'

export default defineCommand({
  name: 'volumes:demo',
  description: 'Integrate an explicitly analytic stockpile fixture with coverage, cut/fill and conditional error bounds',
  options: {
    '--scenario <name>': { description: volumeScenarios.join(', '), default: 'pyramid' },
    '--output <directory>': 'New private numerical surface and volume dataset',
  },
  async handle(options) {
    try {
      const request = exampleVolumeRequest(options.scenario as VolumeScenario)
      const { integrationPieces, ...report } = processStockpile(request)
      const dataset = options.output ? await writeVolumeDataset(options.output, request) : null
      print(JSON.stringify({ report, contributionCount: integrationPieces.length, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
