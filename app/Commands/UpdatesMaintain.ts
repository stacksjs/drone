import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandFailure, storeCommandReference, storeReferenceFlags } from '../../resources/functions/drone/updates/command'
import { continueRuntimeTrustMaintenance } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:maintain <directory>',
  description: 'Explicitly retain an unresolved attempt and require fresh signed metadata verification without resetting trust',
  options: {
    ...storeReferenceFlags,
    '--attempt <id>': 'Exact unresolved attempt identity from independently pinned store readback',
    '--acknowledge-unresolved-inputs': 'Acknowledge that prior inputs remain unresolved and retained for investigation',
    '--repository <path>': 'Bounded offline metadata repository for full fresh verification',
    '--trusted-system-clock-source <name>': 'Audit label for the independently managed trusted system clock, not an attestation',
  },
  async handle(options, directory) {
    try {
      if (options.acknowledgeUnresolvedInputs !== true || typeof options.attempt !== 'string' || typeof options.repository !== 'string' || typeof options.trustedSystemClockSource !== 'string') throw new Error('Explicit attempt, acknowledgement, repository and trusted clock source required')
      await printAsync(JSON.stringify(await continueRuntimeTrustMaintenance({ ...storeCommandReference(options, directory), repository: options.repository, previousAttemptId: options.attempt, acknowledgeUnresolvedInputs: true, clock: { source: options.trustedSystemClockSource, read: () => new Date() } })))
    }
    catch { await storeCommandFailure() }
  },
})
