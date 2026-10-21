import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { planFarmingObservation } from '../../resources/functions/drone/agriculture/farming-plan'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'farming:plan <request>',
  description: 'Preview an explicitly declared metric field plan without collection or dispatch',
  // eslint-disable-next-line
  async handle(options, path) {
    try {
      const input = await readMissionFile(path, { maxBytes: 262144, preserveBom: true })
      await printAsync(JSON.stringify(await planFarmingObservation(input)))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Farming planning preview unavailable: invalid declaration, rejected plan or output failure') }
      catch { /* A failed error pipe cannot deliver a diagnostic. Preserve exit 1. */ }
    }
  },
})
