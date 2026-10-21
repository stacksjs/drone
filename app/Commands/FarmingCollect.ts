import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { collectFarmingObservation } from '../../resources/functions/drone/agriculture/farming-collection'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'farming:collect <request> <directory>',
  description: 'Retain an explicitly declared synthetic collection preview in a new private directory',
  // eslint-disable-next-line
  async handle(options, path, directory) {
    try {
      const input = await readMissionFile(path, { maxBytes: 262144, preserveBom: true })
      const result = await collectFarmingObservation(input, directory)
      await printAsync(JSON.stringify(result))
      process.exitCode = result.record.outcome.status === 'completed' ? 0 : 2
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Farming collection preview unavailable: invalid declaration, rejected collection or output failure') }
      catch { /* A failed diagnostic pipe cannot change exit 1 or roll back completed evidence. */ }
    }
  },
})
