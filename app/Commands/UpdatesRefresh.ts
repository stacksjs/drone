import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { refreshRuntimeTrustStore } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:refresh <directory>',
  description: 'Verify offline metadata at an independently trusted system time and retain its accepted prefix',
  options: { ...storeReferenceFlags, '--repository <path>': 'Bounded offline metadata repository', '--trusted-system-clock-source <name>': 'Audit label for the independently managed trusted system clock, not an attestation' },
  async handle(options, directory) {
    try {
      if (typeof options.repository !== 'string' || typeof options.trustedSystemClockSource !== 'string') throw new Error('Explicit repository and independently trusted system-clock source required')
      await printAsync(JSON.stringify(await refreshRuntimeTrustStore({ ...storeCommandReference(options, directory), repository: options.repository, clock: { source: options.trustedSystemClockSource, read: () => new Date() } })))
    }
    catch { await storeCommandFailure() }
  },
})
