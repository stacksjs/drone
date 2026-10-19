import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { createAgriculturePlan } from '../../resources/functions/drone/agriculture/planner'
import { readAgricultureConfig } from '../../resources/functions/drone/agriculture/files'

export default defineCommand({
  name: 'agriculture:plan <config>',
  description: 'Validate a crop scouting route, raw-band calibration, panel references and explicit parcels',
  // eslint-disable-next-line
  async handle(options, path) {
    try { await printAsync(JSON.stringify(createAgriculturePlan(await readAgricultureConfig(path)), null, 2)) }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
