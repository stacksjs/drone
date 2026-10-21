import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { inspectRuntimeFirmwareCandidates } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:candidates <directory>',
  description: 'Inspect owned candidate identity and recorded-byte integrity without granting selection authority',
  options: storeReferenceFlags,
  async handle(options, directory) {
    try { await printAsync(JSON.stringify(await inspectRuntimeFirmwareCandidates(storeCommandReference(options, directory)))) }
    catch { await storeCommandFailure() }
  },
})
