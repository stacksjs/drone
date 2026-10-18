import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { createSurveyPlan } from '../../resources/functions/drone/mapping/planner'
import { exampleSurveyConfig } from '../../resources/functions/drone/mapping/fixtures'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'mapping:plan',
  description: 'Clip calibrated camera survey lanes and validate overlap, trigger and endurance constraints',
  options: { '--config <path>': 'Bounded survey JSON; omit for the declared synthetic example' },
  async handle(options) {
    try {
      let input: unknown = exampleSurveyConfig()
      if (options.config) {
        try { input = JSON.parse(await readMissionFile(options.config)) }
        catch { throw new TypeError('Invalid survey configuration JSON or file') }
      }
      print(JSON.stringify(createSurveyPlan(input), null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
