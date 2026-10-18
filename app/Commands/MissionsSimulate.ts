import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { MissionScenario } from '../../resources/functions/drone/missions/simulation'
import { missionScenarios, simulateMission } from '../../resources/functions/drone/missions/simulation'
import { parseMissionPlan } from '../../resources/functions/drone/missions/plan'
import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'
export default defineCommand({
  name: 'missions:simulate',
  description: 'Run an owned mission through modeled sensors, estimation, authority and quad-X controls',
  options: {
    '--scenario <name>': { description: missionScenarios.join(', '), default: 'nominal' },
    '--seconds <n>': { description: 'Maximum virtual duration, 8..120 seconds', default: '45' },
    '--plan <path>': { description: 'Optional v1 mission JSON plan' },
    '--output <directory>': { description: 'New private directory for the replayable mission trace' },
  },
  async handle(options) {
    try {
      const plan = options.plan ? parseMissionPlan(await readMissionFile(options.plan)).plan : undefined
      const { trace, ...result } = simulateMission({ scenario: options.scenario as MissionScenario, seconds: Number(options.seconds), plan })
      const tracePath = options.output ? await writeMissionTrace(options.output, trace) : null
      // eslint-disable-next-line
      print(JSON.stringify({ ...result, tracePath }, (key, value) => typeof value === 'bigint' ? String(value) : value, 2))
      const expected = options.scenario === 'abort' ? 'aborted' : ['rc-override', 'reserve'].includes(options.scenario) ? 'blocked' : 'completed'
      if (result.mission.state !== expected) process.exitCode = 1
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
