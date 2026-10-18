import { defineCommand } from '@stacksjs/cli'
import { print, printError } from '@stacksjs/cli/output'
import { parseMissionTrace, replayMission } from '../../resources/functions/drone/missions/engine'
import { readMissionFile } from '../../resources/functions/drone/missions/files'
export default defineCommand({
  name: 'missions:replay <path>',
  description: 'Recompute recorded mission decisions with no vehicle connection',
  options: { '--at-ms <n>': 'Absolute fixture time; defaults to the last recorded epoch' },
  async handle(options, path) {
    try {
      const trace = parseMissionTrace(await readMissionFile(path))
      const atMs = options.atMs === undefined ? trace.rows.at(-1)?.observation.nowMs ?? 0 : Number(options.atMs)
      if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 120000) throw new RangeError('Replay epoch must be an integer from 0..120000 ms')
      trace.rows = trace.rows.filter(row => row.observation.nowMs <= atMs)
      const result = replayMission(trace).snapshot()
      print(JSON.stringify({ ...result, rows: trace.rows.length, payloadEvents: trace.rows.flatMap(row => row.result.payload ? [{ atMs: row.observation.nowMs, ...row.result.payload }] : []) }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
