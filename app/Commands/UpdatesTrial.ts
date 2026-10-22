import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { hostTrialCommandOptions, hostTrialFlags, storeCommandFailure } from '../../resources/functions/drone/updates/command'
import { trialRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:trial <directory>',
  description: 'Confirm an owned host image only through current signed policy and its actual neutral runtime health',
  options: { ...hostTrialFlags, '--candidate <id>': 'Exact owned prepared candidate identity' },
  async handle(options, directory) {
    try {
      if (typeof options.candidate !== 'string') throw new Error('Explicit owned candidate required')
      await printAsync(JSON.stringify(await trialRuntimeFirmwareCandidate({ ...hostTrialCommandOptions(options, directory), candidateId: options.candidate })))
    }
    catch { await storeCommandFailure() }
  },
})
