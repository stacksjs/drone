import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { reserveRuntimeFirmwareCandidate } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:reserve <directory>',
  description: 'Reserve an owned signed-image candidate in a pinned store without selecting or installing firmware',
  options: { ...storeReferenceFlags, '--repository <path>': 'Bounded offline signed-image repository', '--trusted-system-clock-source <name>': 'Audit label for the independently managed trusted system clock, not an attestation' },
  async handle(options, directory) {
    try {
      if (typeof options.repository !== 'string' || typeof options.trustedSystemClockSource !== 'string') throw new Error('Explicit repository and independently trusted system-clock source required')
      await printAsync(JSON.stringify(await reserveRuntimeFirmwareCandidate({ ...storeCommandReference(options, directory), repository: options.repository, clock: { source: options.trustedSystemClockSource, read: () => new Date() } })))
    }
    catch { await storeCommandFailure() }
  },
})
