import { defineCommand } from '@stacksjs/cli'
import { printAsync, printErrorAsync } from '../../resources/functions/cli/output'
import { environmentProfiles, normalizeEnvironmentInput } from '../../resources/functions/drone/environment/plan'
import { environmentSummary, simulateEnvironment } from '../../resources/functions/drone/environment/runtime'
import { environmentOutputDirectory, writeEnvironmentDataset } from '../../resources/functions/drone/environment/export'

export default defineCommand({
  name: 'environment:simulate',
  description: 'Acquire a finite synthetic airborne cell index with unsigned local provenance',
  options: {
    '--profile <name>': { description: environmentProfiles.join(', '), default: 'nominal' },
    '--output <directory>': 'Optional new private five-file dataset; parent must exist',
  },
  async handle(options) {
    try {
      const input = normalizeEnvironmentInput({ profile: options.profile })
      const directory = options.output === undefined ? undefined : environmentOutputDirectory(options.output)
      const summary = directory === undefined ? environmentSummary(simulateEnvironment(input)) : (await writeEnvironmentDataset(directory, input)).summary
      if (!summary.qualified) process.exitCode = 1
      await printAsync(JSON.stringify(summary))
    }
    catch {
      process.exitCode = 1
      try { await printErrorAsync('Environment simulation failed: invalid input, unavailable result or output failure') }
      catch { /* Exit remains failed when stderr itself is unavailable. */ }
    }
  },
})
