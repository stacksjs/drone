import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import type { MissionObservation } from '../../resources/functions/drone/missions/engine'
import { parseMissionTrace, resumeMission } from '../../resources/functions/drone/missions/engine'
import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'missions:resume <checkpoint> <observation>',
  description: 'Explicitly resume a paused simulation mission using a fresh supervised observation',
  options: { '--output <directory>': 'Required new private directory for the resumed decision trace' },
  async handle(options, checkpoint, observation) {
    try {
      if (!options.output) throw new TypeError('Resume requires --output')
      const trace = parseMissionTrace(await readMissionFile(checkpoint))
      const text = await readMissionFile(observation)
      let fresh: MissionObservation
      try { fresh = JSON.parse(text) }
      catch { throw new TypeError('Invalid mission observation JSON') }
      const engine = resumeMission(trace, fresh)
      const resumed = engine.trace()
      const tracePath = await writeMissionTrace(options.output, resumed)
      print(JSON.stringify({ ...engine.snapshot(), rows: resumed.rows.length, tracePath }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
