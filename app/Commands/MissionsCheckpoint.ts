import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { checkpointMission, parseMissionTrace, replayMission } from '../../resources/functions/drone/missions/engine'
import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'missions:checkpoint <path>',
  description: 'Save an exact active decision prefix from a verified owned mission recording',
  options: {
    '--at-ms <n>': 'Required exact recorded observation epoch',
    '--output <directory>': 'Required new private checkpoint directory',
  },
  async handle(options, path) {
    try {
      if (!options.output || options.atMs === undefined) throw new TypeError('Checkpoint requires --at-ms and --output')
      const trace = checkpointMission(parseMissionTrace(await readMissionFile(path)), Number(options.atMs))
      const tracePath = await writeMissionTrace(options.output, trace)
      print(JSON.stringify({ ...replayMission(trace).snapshot(), rows: trace.rows.length, tracePath }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
