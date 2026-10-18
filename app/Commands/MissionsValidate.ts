import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { parseMissionPlan } from '../../resources/functions/drone/missions/plan'
import { readMissionFile } from '../../resources/functions/drone/missions/files'
export default defineCommand({
  name: 'missions:validate <path>',
  description: 'Validate versioned tasks, references, fence, rally and conservative endurance',
  // eslint-disable-next-line
  async handle(options, path) {
    try { print(JSON.stringify(parseMissionPlan(await readMissionFile(path)), null, 2)) }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
