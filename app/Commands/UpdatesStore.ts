import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { inspectRuntimeTrustStore } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:store <directory>',
  description: 'Inspect independently pinned metadata state under writer exclusion',
  options: storeReferenceFlags,
  async handle(options, directory) {
    try { await printAsync(JSON.stringify(await inspectRuntimeTrustStore(storeCommandReference(options, directory)))) }
    catch { await storeCommandFailure() }
  },
})
