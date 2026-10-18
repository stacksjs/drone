import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createInspectionPlan } from '../../resources/functions/drone/inspection/planner'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'inspection:plan <config>',
  description: 'Validate an asset-relative bridge-face route and explicit clearance, camera and endurance assumptions',
  // eslint-disable-next-line
  async handle(options, path) {
    try {
      let input: unknown
      try { input = JSON.parse(await readMissionFile(path)) }
      catch { throw new TypeError('Invalid inspection configuration JSON or file') }
      print(JSON.stringify(createInspectionPlan(input), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
