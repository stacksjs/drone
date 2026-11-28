import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { parseJsonText } from '@stacksjs/router/json'
import { printAsync } from '../../resources/functions/cli/output'
import { planAerialApplication, planApplication } from '../../resources/functions/drone/application/planner'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'application:plan <config>',
  description: 'Validate inert-material prescriptions, polygon support, inventory and an owned mission',
  options: { '--vehicle <name>': { description: 'ground or quadcopter', default: 'ground' } },
  async handle(options, path) {
    try {
      if (!['ground', 'quadcopter'].includes(options.vehicle)) throw new RangeError('Application vehicle must be ground or quadcopter')
      const text = await readMissionFile(path, { maxBytes: 256 * 1024 })
      let config: unknown
      try { config = parseJsonText(text, { rejectDuplicateKeys: true }) }
      catch { throw new TypeError('Invalid application configuration JSON') }
      const plan = options.vehicle === 'quadcopter' ? planAerialApplication(config) : planApplication(config)
      await printAsync(JSON.stringify(plan, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
