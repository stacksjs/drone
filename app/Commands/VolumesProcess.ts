import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { parseVolumeRequest } from '../../resources/functions/drone/volumes/import'
import { processStockpile } from '../../resources/functions/drone/volumes/engine'
import { writeVolumeDataset } from '../../resources/functions/drone/volumes/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'volumes:process <request>',
  description: 'Process a known indexed TIN or cell-grid request without acquisition, meshing or reconstruction',
  options: { '--output <directory>': 'New private audit dataset; existing outputs are preserved' },
  async handle(options, path) {
    try {
      const request = parseVolumeRequest(await readMissionFile(path))
      const { integrationPieces, ...report } = processStockpile(request)
      const dataset = options.output ? await writeVolumeDataset(options.output, request) : null
      print(JSON.stringify({ report, contributionCount: integrationPieces.length, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
