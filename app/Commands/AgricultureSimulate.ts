import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import type { AgricultureScenario } from '../../resources/functions/drone/agriculture/types'
import { agricultureScenarios, simulateAgriculture } from '../../resources/functions/drone/agriculture/runtime'
import { processAgriculture } from '../../resources/functions/drone/agriculture/layer'
import { writeAgricultureDataset } from '../../resources/functions/drone/agriculture/export'
import { readAgricultureConfig } from '../../resources/functions/drone/agriculture/files'

export default defineCommand({
  name: 'agriculture:simulate',
  description: 'Collect raw red/NIR and visible imagery through the owned survey runtime and calculate a field layer',
  options: {
    '--config <path>': 'Optional explicit agriculture configuration JSON',
    '--scenario <name>': { description: agricultureScenarios.join(', '), default: 'nominal' },
    '--visit <id>': { description: 'Explicit recording visit identity', default: 'field-visit' },
    '--seconds <n>': { description: 'Virtual duration, 8..120 integer seconds', default: '100' },
    '--output <directory>': 'New private raw-band, layer, parcel and observation dataset',
  },
  async handle(options) {
    try {
      if (!/^\d+$/.test(options.seconds)) throw new RangeError('Agriculture seconds must be an integer from 8..120')
      const config = options.config ? await readAgricultureConfig(options.config) : undefined
      const run = simulateAgriculture({ config, scenario: options.scenario as AgricultureScenario, seconds: Number(options.seconds), visitId: options.visit })
      const layer = processAgriculture(run)
      const dataset = options.output ? await writeAgricultureDataset(options.output, run) : null
      await printAsync(JSON.stringify({ status: run.status, reason: run.reason, visitId: run.visitId, captures: run.captures.length, boardNeutral: run.survey.boardNeutral, fieldAreaM2: layer.fieldAreaM2, observedAreaM2: layer.observedAreaM2, meanNdvi: layer.meanNdvi, parcels: layer.parcels, physicalFlightEnabled: false, physicalCalibrationVerified: false, physicalAgronomyVerified: false, dataset }, null, 2))
      const expected = options.scenario === 'nominal' ? 'completed' : ['position-loss', 'rc-override'].includes(options.scenario) ? 'blocked' : 'aborted'
      if (run.status !== expected || !run.survey.boardNeutral) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
