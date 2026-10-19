import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { parseOwnedMissionTrace, replayOwnedMissionAt } from '../../resources/functions/drone/missions/recording'
import { readMissionFile } from '../../resources/functions/drone/missions/files'
export default defineCommand({
  name: 'missions:replay <path>',
  description: 'Recompute recorded mission decisions with no vehicle connection',
  options: { '--at-ms <n>': 'Absolute fixture time; defaults to the last recorded epoch' },
  async handle(options, path) {
    try {
      const source = parseOwnedMissionTrace(await readMissionFile(path, { maxBytes: 16 * 1024 * 1024 }))
      const engine = replayOwnedMissionAt(source, options.atMs === undefined ? undefined : Number(options.atMs))
      const trace = engine.trace(), result = engine.snapshot()
      print(JSON.stringify({ ...result, rows: trace.rows.length, payloadEvents: trace.rows.flatMap(row => row.result.payload ? [{ atMs: row.observation.nowMs, ...row.result.payload }] : []) }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
