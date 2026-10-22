import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { abandonRuntimeFirmwareTrial } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:abandon <directory>',
  description: 'Abandon an exact interrupted host trial after metadata recovery while retaining artifacts and known-good state',
  options: { ...storeReferenceFlags, '--trial <id>': 'Exact interrupted host trial identity' },
  async handle(options, directory) {
    try {
      if (typeof options.trial !== 'string') throw new Error('Explicit interrupted trial required')
      await printAsync(JSON.stringify(await abandonRuntimeFirmwareTrial({ ...storeCommandReference(options, directory), trialId: options.trial })))
    }
    catch { await storeCommandFailure() }
  },
})
