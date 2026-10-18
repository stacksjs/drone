import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createEstimatorReplay } from '../../resources/functions/drone/estimation/replay'
import { maxSensorDatasetBytes } from '../../resources/functions/drone/sensors/replay'

export default defineCommand({
  name: 'estimator:replay <dataset>',
  description: 'Replay owned tilt, local-position and pressure-height estimates with health',
  options: { '--at-ms <ms>': { description: 'Nonnegative virtual replay time in ms', default: '1000' } },
  async handle(options, dataset) {
    try {
      const data = await Bun.file(dataset).slice(0, maxSensorDatasetBytes + 1).arrayBuffer()
      if (data.byteLength > maxSensorDatasetBytes) throw new RangeError('Dataset exceeds 1 MiB')
      const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
      const replay = createEstimatorReplay(input)
      // eslint-disable-next-line
      print(JSON.stringify(replay.advanceTo(Number(options.atMs)), (key, value) => typeof value === 'bigint' ? value.toString() : value, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
