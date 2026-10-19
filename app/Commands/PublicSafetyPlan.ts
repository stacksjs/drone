import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { planPublicSafetyMission } from '../../resources/functions/drone/public-safety/planner'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'public-safety:plan <config>',
  description: 'Validate a bounded incident sector, operating boundary, privacy declarations and owned mission budget',
  // eslint-disable-next-line no-unused-vars
  async handle(options, path) {
    try {
      let config: unknown
      try { config = JSON.parse(await readMissionFile(path, { maxBytes: 256 * 1024 })) }
      catch { throw new TypeError('Invalid public-safety configuration JSON or file') }
      const plan = planPublicSafetyMission(config)
      await printAsync(JSON.stringify(plan, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
