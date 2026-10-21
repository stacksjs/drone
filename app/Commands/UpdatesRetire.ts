import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { retireRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:retire <directory>',
  description: 'Retire the exact active candidate reservation while retaining its history, bytes and trust floors',
  options: { ...storeReferenceFlags, '--candidate <id>': 'Exact active candidate identity from pinned store status' },
  async handle(options, directory) {
    try {
      if (typeof options.candidate !== 'string') throw new Error('Explicit candidate identity required')
      await printAsync(JSON.stringify(await retireRuntimeFirmwareCandidate({ ...storeCommandReference(options, directory), candidateId: options.candidate })))
    }
    catch { await storeCommandFailure() }
  },
})
