import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { createLivestockObservation, validateLivestockObservations } from '../../resources/functions/drone/agriculture/evidence'
import { readAgricultureObservations, readAgricultureRecording } from '../../resources/functions/drone/agriculture/files'
import { writeAgricultureDataset } from '../../resources/functions/drone/agriculture/export'

export default defineCommand({
  name: 'agriculture:observe <recording>',
  description: 'Bind an explicit operator-selected animal label to one source capture pixel and field location',
  options: {
    '--id <id>': 'Required new observation identity',
    '--animal <id>': 'Required operator-selected animal label, not verified identity',
    '--capture <id>': 'Required retained source capture identity',
    '--x <n>': 'Required integer output pixel x',
    '--y <n>': 'Required integer output pixel y',
    '--observer <id>': 'Required operator-declared observer identity',
    '--observed-at <time>': 'Required canonical UTC timestamp with milliseconds',
    '--note <text>': 'Required explicit observation note',
    '--observations <path>': 'Optional existing livestock-observations.json to validate and retain',
    '--output <directory>': 'Required new private dataset, preserving the original',
  },
  async handle(options, path) {
    try {
      if (![options.id, options.animal, options.capture, options.x, options.y, options.observer, options.observedAt, options.note, options.output].every(value => typeof value === 'string' && value.length > 0)) throw new TypeError('Specify all required observation fields and --output')
      const run = await readAgricultureRecording(path)
      let input: unknown = []
      if (options.observations) input = await readAgricultureObservations(options.observations)
      if (!Array.isArray(input) || input.length >= 64) throw new RangeError('Retained observations must contain at most 63 records')
      const retained = await validateLivestockObservations(run, input)
      const observation = await createLivestockObservation(run, { id: options.id!, animalId: options.animal!, captureId: options.capture!, pixel: [Number(options.x), Number(options.y)], observerId: options.observer!, observedAt: options.observedAt!, note: options.note! })
      const dataset = await writeAgricultureDataset(options.output!, run, [...retained, observation])
      await printAsync(JSON.stringify({ observation, retainedObservations: retained.length, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
