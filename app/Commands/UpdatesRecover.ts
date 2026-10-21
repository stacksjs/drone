import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { recoverRuntimeTrustStore } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:recover <directory>',
  description: 'Replay exact durable metadata inputs to retain floors, without selecting or installing firmware',
  options: storeReferenceFlags,
  async handle(options, directory) {
    try { await printAsync(JSON.stringify(await recoverRuntimeTrustStore(storeCommandReference(options, directory)))) }
    catch { await storeCommandFailure() }
  },
})
