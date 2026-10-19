import { defineCommand } from '@stacksjs/cli'
import { printError } from '@stacksjs/cli/output'
import { printAsync } from '../../resources/functions/cli/output'
import { applicationEvidenceLimits, parseApplicationRecording } from '../../resources/functions/drone/application/evidence'
import { processApplication } from '../../resources/functions/drone/application/coverage'
import { writeApplicationDataset } from '../../resources/functions/drone/application/export'
import { readMissionFile } from '../../resources/functions/drone/missions/files'

export default defineCommand({
  name: 'application:process <recording>',
  description: 'Verify mission and metering inputs and recalculate exact modeled application coverage',
  options: { '--output <directory>': 'Optional new private reprocessed dataset' },
  async handle(options, path) {
    try {
      const run = parseApplicationRecording(await readMissionFile(path, { maxBytes: applicationEvidenceLimits.recordingBytes }))
      const report = processApplication(run)
      const dataset = options.output ? await writeApplicationDataset(options.output, run) : null
      await printAsync(JSON.stringify({ report, dataset }, null, 2))
    }
    catch (error) { printError(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
  },
})
