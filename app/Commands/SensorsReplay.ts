import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createSensorReplay, maxSensorDatasetBytes } from '../../resources/functions/drone/sensors/replay'

export default defineCommand({
  name: 'sensors:replay <dataset>',
  description: 'Replay a bounded sensor dataset through calibration, clock and health checks',
  options: { '--at-ms <ms>': { description: 'Nonnegative virtual replay time in ms', default: '1000' } },
  async handle(options, dataset) {
    try {
      const bytes = await Bun.file(dataset).slice(0, maxSensorDatasetBytes + 1).arrayBuffer()
      if (bytes.byteLength > maxSensorDatasetBytes) throw new RangeError('Dataset exceeds 1 MiB')
      const replay = createSensorReplay(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      // eslint-disable-next-line
      print(JSON.stringify(replay.advanceTo(Number(options.atMs)), (key, value) => typeof value === 'bigint' ? value.toString() : value, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
