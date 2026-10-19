import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { applicationEvidenceLimits, parseApplicationRecording } from '../../resources/functions/drone/application/evidence'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'application:replay <recording>',
  description: 'Recompute recorded mission and implement decisions and inspect one exact retained epoch',
  options: { '--at-ms <n>': 'Optional exact host or independent plant probe epoch, defaults to the last host input' },
  async handle(options, path) {
    try {
      const run = parseApplicationRecording(await readMissionFile(path, { maxBytes: applicationEvidenceLimits.recordingBytes }))
      const atMs = options.atMs === undefined ? run.inputs.at(-1)!.atMs : Number(options.atMs)
      const input = run.inputs.find(row => row.atMs === atMs) ?? null
      const decision = run.decisions.find(row => row.atMs === atMs) ?? null
      const probe = run.probes.find(row => row.atMs === atMs) ?? null
      if (!Number.isSafeInteger(atMs) || !input && !probe) throw new RangeError('Replay epoch must match a retained host input or independent plant probe')
      await printAsync(JSON.stringify({ atMs, visitId: run.options.visitId, status: run.status, reason: run.reason, hostObservationAvailable: input !== null, input, decision, independentModeledProbe: probe, physicalTrialEligible: false }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
