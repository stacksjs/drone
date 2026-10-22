import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { inspectRuntimeFirmwareSlots } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:slots <directory>',
  description: 'Inspect retained host slot roles, evidence and recorded-byte integrity without current trust authority',
  options: storeReferenceFlags,
  async handle(options, directory) {
    try { await printAsync(JSON.stringify(await inspectRuntimeFirmwareSlots(storeCommandReference(options, directory)))) }
    catch { await storeCommandFailure() }
  },
})
