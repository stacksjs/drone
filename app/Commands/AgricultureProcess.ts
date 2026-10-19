import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { processAgriculture } from '../../resources/functions/drone/agriculture/layer'
import { readAgricultureObservations, readAgricultureRecording } from '../../resources/functions/drone/agriculture/files'
import { validateLivestockObservations } from '../../resources/functions/drone/agriculture/evidence'
import { writeAgricultureDataset } from '../../resources/functions/drone/agriculture/export'

export default defineCommand({
  name: 'agriculture:process <recording>',
  description: 'Verify recorded raw bands and recalculate the calibrated field/parcel observation layer',
  options: {
    '--output <directory>': 'Optional new private reprocessed dataset',
    '--observations <path>': 'Optional source-bound livestock declarations to validate and retain',
  },
  async handle(options, path) {
    try {
      const run = await readAgricultureRecording(path)
      const layer = processAgriculture(run)
      const observations = await validateLivestockObservations(run, options.observations ? await readAgricultureObservations(options.observations) : [])
      const dataset = options.output ? await writeAgricultureDataset(options.output, run, observations) : null
      await printAsync(JSON.stringify({ layer, observations: observations.length, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
