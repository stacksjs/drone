import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { hostTrialCommandOptions, hostTrialFlags, storeCommandFailure } from '../../resources/functions/drone/updates/command'
import { rollbackRuntimeFirmwareSlot } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:rollback <directory>',
  description: 'Re-verify the retained known-good host image under current policy and observe a fresh health session',
  options: hostTrialFlags,
  async handle(options, directory) {
    try { await printAsync(JSON.stringify(await rollbackRuntimeFirmwareSlot(hostTrialCommandOptions(options, directory)))) }
    catch { await storeCommandFailure() }
  },
})
