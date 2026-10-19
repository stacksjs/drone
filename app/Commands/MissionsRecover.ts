import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { parseOwnedMissionTrace, recoverOwnedMission } from '../../resources/functions/drone/missions/recording'
import { readMissionFile, writeMissionTrace } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'missions:recover <checkpoint> <observation>',
  description: 'Verify a simulation checkpoint and save paused recovery using an explicit fresh observation',
  options: { '--output <directory>': 'Required new private directory for the recovered decision trace' },
  async handle(options, checkpoint, observation) {
    try {
      if (!options.output) throw new TypeError('Recovery requires --output')
      const trace = parseOwnedMissionTrace(await readMissionFile(checkpoint, { maxBytes: 16 * 1024 * 1024 }))
      const text = await readMissionFile(observation)
      let fresh: unknown
      try { fresh = JSON.parse(text) }
      catch { throw new TypeError('Invalid mission observation JSON') }
      const engine = recoverOwnedMission(trace, fresh)
      const recovered = engine.trace()
      const tracePath = await writeMissionTrace(options.output, recovered)
      print(JSON.stringify({ ...engine.snapshot(), rows: recovered.rows.length, tracePath }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
