import { defineCommand } from '@stacksjs/cli'
import { printAsync } from '../../resources/functions/cli/output'
import { storeCommandEnrollment, storeCommandFailure, storeEnrollmentFlags } from '../../resources/functions/drone/updates/command'
import { createRuntimeTrustStore } from '../../resources/functions/drone/updates/store'

export default defineCommand({
  name: 'updates:store-init',
  description: 'Create a new independently bound metadata protocol store without selecting firmware',
  options: { ...storeEnrollmentFlags, '--output <path>': 'New exclusive private protocol-state directory' },
  async handle(options) {
    try {
      if (typeof options.output !== 'string') throw new Error('Explicit new store output required')
      await printAsync(JSON.stringify(await createRuntimeTrustStore({ ...storeCommandEnrollment(options), output: options.output })))
    }
    catch { await storeCommandFailure() }
  },
})
