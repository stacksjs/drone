import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { planApplication } from '../../resources/functions/drone/application/planner'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'application:plan <config>',
  description: 'Validate inert-material prescriptions, polygon support, inventory and an owned ground mission',
  // eslint-disable-next-line
  async handle(options, path) {
    try {
      const text = await readMissionFile(path, { maxBytes: 256 * 1024 })
      let config: unknown
      try { config = JSON.parse(text) }
      catch { throw new TypeError('Invalid application configuration JSON') }
      await printAsync(JSON.stringify(planApplication(config), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
