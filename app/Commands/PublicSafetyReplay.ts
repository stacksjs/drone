import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { parsePublicSafetyRecording, publicSafetyEvidenceLimits } from '../../resources/functions/drone/public-safety/evidence'
import { writePublicSafetyDataset } from '../../resources/functions/drone/public-safety/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'public-safety:replay <recording>',
  description: 'Re-execute the pinned owned incident profile and inspect an exact retained observation epoch',
  options: { '--at-ms <n>': 'Exact retained observation epoch; defaults to the final epoch', '--output <directory>': 'Optional new private verified evidence dataset' },
  async handle(options, path) {
    try {
      const run = parsePublicSafetyRecording(await readMissionFile(path, { maxBytes: publicSafetyEvidenceLimits.recordingBytes }))
      if (options.atMs !== undefined && !/^\d+$/.test(options.atMs)) throw new TypeError('Replay requires an exact integer observation epoch')
      const atMs = options.atMs === undefined ? run.epochs.at(-1)!.atMs : Number(options.atMs)
      const epoch = run.epochs.find(row => row.atMs === atMs)
      if (!epoch) throw new RangeError('Requested time is not a retained incident observation epoch')
      const dataset = options.output ? await writePublicSafetyDataset(options.output, run) : null
      await printAsync(JSON.stringify({ replayProfile: run.replayProfile, verified: true, authentication: 'unsigned-synthetic-consistency', epoch, confirmedCaptures: run.captures.filter(c => c.acknowledgedAtMs <= atMs).length, events: run.events.filter(event => event.atMs === atMs), dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
